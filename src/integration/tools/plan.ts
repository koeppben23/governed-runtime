/**
 * @module integration/tools/plan
 * @description FlowGuard plan tool — submit plan or record independent review verdict.
 *
 * Agent-Orchestrated Independent Review Persistence Boundary
 *
 * Architecture: FlowGuard does NOT call subagents. The OpenCode primary agent
 * orchestrates independent review by calling the flowguard-reviewer subagent
 * via the Task tool. FlowGuard accepts, validates, and persists the resulting
 * ReviewFindings.
 *
 * Flow (subagentEnabled=true):
 * 1. Primary agent drafts plan, submits to FlowGuard
 * 2. FlowGuard returns next-action instructing subagent invocation
 * 3. Primary agent calls flowguard-reviewer subagent via Task tool
 * 4. Subagent returns structured ReviewFindings
 * 5. Primary agent submits review verdict + reviewFindings to FlowGuard
 * 6. FlowGuard validates (mode gating, version binding, iteration binding,
 *    mandatory findings) and persists both (append-only, separate)
 *
 * Tool responsibilities:
 * - Input validation: reviewFindings vs policy, planVersion binding
 * - Persistence: plan.history (author), plan.reviewFindings (reviewer)
 * - Response: summary of review findings, iteration tracking
 * - Next-action: independent reviewer instructions
 *
 * Policy config (selfReview):
 * - subagentEnabled: enforces subagent review mode
 * - fallbackToSelf: deprecated compatibility field; self-review fallback is prohibited
 *
 * Validation rules:
 * - reviewMode=self → BLOCKED
 * - reviewVerdict=approve + missing reviewFindings → BLOCKED
 * - reviewFindings.planVersion mismatch → BLOCKED
 *
 * @version v7
 */

import { z } from 'zod';

import type { ToolDefinition } from './helpers.js';
import {
  withMutableSessionTransaction,
  formatBlocked,
  formatAutoAdvanceOverflow,
  formatError,
  extractSections,
  appendNextAction,
  writeStateWithArtifacts,
} from './helpers.js';
import type { SessionState } from '../../state/schema.js';
import { evaluate } from '../../machine/evaluate.js';
import { isCommandAllowed, Command } from '../../machine/commands.js';
import { autoAdvance } from '../../rails/types.js';
import type {
  PlanEvidence,
  LoopVerdict,
  RevisionDelta,
  ReviewFindings,
} from '../../state/evidence.js';
import { ReviewFindings as ReviewFindingsSchema } from '../../state/evidence.js';
import {
  validateReviewFindings,
  requireReviewFindings,
  resolveHostTaskEffectiveFindings,
} from './review-validation.js';
import {
  appendReviewObligation,
  consumeReviewObligation,
  createReviewObligation,
  ensureReviewAssurance,
  findAcceptedInvocationForFindings,
  findLatestObligation,
} from '../review/assurance.js';
import { resolveRuntimeReviewPlatform } from '../review/orchestration-mode.js';
// presentation imports moved to plan-response.ts

// ---- re-exported from sub-modules for backward-compatible import paths ----
export type {
  PlanArgs,
  MutablePlanSession,
  PlanInputFlags,
  PlanReviewPolicy,
  PlanExecutionScope,
  PlanRevisionResult,
  PlanSubmissionResponseInput,
  ConvergedPlanReviewInput,
} from './plan-types.js';
export { classifyPlanCall, planInputFlags, planReviewPolicy } from './plan-types.js';
export {
  firstLine,
  buildPlanSubmissionResponse,
  buildPlanReviewInstruction,
  latestPlanReviewSummary,
  convergedPlanResponse,
  convergedPlanReviewCardResponse,
  nonConvergedPlanResponse,
  persistConvergedPlanReview,
  persistNonConvergedPlanReview,
  persistPlanReview,
} from './plan-response.js';

// ---- internal types ----
import type {
  PlanArgs,
  PlanInputFlags,
  PlanExecutionScope,
  PlanRevisionResult,
} from './plan-types.js';

// ---- internal helpers ----

import { classifyPlanCall, planInputFlags, planReviewPolicy } from './plan-types.js';
import {
  buildPlanSubmissionResponse as buildSubmissionResponse,
  persistPlanReview as persistReview,
} from './plan-response.js';

function blockedPlanReviewInProgress(state: SessionState): string | null {
  const assurance = ensureReviewAssurance(state.reviewAssurance);
  const blockedPlanObligations = assurance.obligations.filter(
    (o) => o.obligationType === 'plan' && o.status === 'blocked',
  );
  const lastPlanObligation = [...assurance.obligations]
    .reverse()
    .find((o) => o.obligationType === 'plan');

  if (lastPlanObligation?.status !== 'blocked') {
    return formatBlocked('PLAN_REVIEW_IN_PROGRESS');
  }
  if (blockedPlanObligations.length >= 3) {
    return formatBlocked('ORCHESTRATION_PERMANENTLY_FAILED', {
      attempts: String(blockedPlanObligations.length),
    });
  }
  return null;
}

function validatePlanRequest(scope: PlanExecutionScope): string | null {
  const { input, state } = scope;
  if (!isCommandAllowed(state.phase, Command.PLAN)) {
    return formatBlocked('COMMAND_NOT_ALLOWED', { command: '/plan', phase: state.phase });
  }
  if (!state.ticket) return formatBlocked('TICKET_REQUIRED', { action: 'creating a plan' });

  const mixedInputBlocked = validatePlanInputShape(scope.args, input, state);
  if (mixedInputBlocked) return mixedInputBlocked;

  if (
    input.isInitialSubmission &&
    input.hasPlanText &&
    state.phase === 'PLAN' &&
    state.selfReview
  ) {
    const blocked = blockedPlanReviewInProgress(state);
    if (blocked) return blocked;
  }

  return validateInitialPlanFindings(scope);
}

function normalizeInitialPlanSubmissionArgs(args: PlanArgs, state: SessionState): PlanArgs {
  const hasPlanText = typeof args.planText === 'string' && args.planText.trim().length > 0;
  if (!hasPlanText || state.plan || state.phase !== 'TICKET') return args;
  return { planText: args.planText };
}

function validatePlanInputShape(
  args: PlanArgs,
  input: PlanInputFlags,
  state: SessionState,
): string | null {
  return validateSubmissionInputShape(args, input) ?? validateReviewInputShape(input, state);
}

function validateSubmissionInputShape(args: PlanArgs, input: PlanInputFlags): string | null {
  const mode = classifyPlanCall(args, input);
  if (mode.kind === 'invalid') return formatBlocked(mode.code, mode.params);
  return null;
}

function validateReviewInputShape(input: PlanInputFlags, state: SessionState): string | null {
  if (input.hasVerdict && !state.plan) return formatBlocked('PLAN_SUBMISSION_REQUIRED');
  if (input.hasVerdict && !state.selfReview) return formatBlocked('PLAN_REVIEW_LOOP_REQUIRED');
  if (input.hasFindings && !input.hasVerdict && !state.plan) {
    return formatBlocked('PLAN_SUBMISSION_REQUIRED');
  }
  if (input.hasFindings && !input.hasVerdict) return formatBlocked('PLAN_FINDINGS_WITHOUT_VERDICT');
  return null;
}

function validateInitialPlanFindings(scope: PlanExecutionScope): string | null {
  if (!scope.input.isInitialSubmission || !scope.args.reviewFindings) return null;
  return validateReviewFindings(scope.args.reviewFindings, {
    subagentEnabled: scope.reviewPolicy.subagentEnabled,
    fallbackToSelf: scope.reviewPolicy.fallbackToSelf,
    expectedPlanVersion: (scope.state.plan?.history.length ?? 0) + 1,
    expectedIteration: 0,
    strictEnforcement: false,
    reviewInvocationPolicy: scope.policy.reviewInvocationPolicy,
    reviewParentSessionId: scope.context.sessionID,
    reviewHostPlatform: resolveRuntimeReviewPlatform(),
  });
}

function buildPlanEvidence(planBody: string, scope: PlanExecutionScope): PlanEvidence {
  return {
    body: planBody,
    digest: scope.ctx.digest(planBody),
    sections: extractSections(planBody),
    createdAt: scope.ctx.now(),
  };
}

function buildPlanSubmissionState(
  scope: PlanExecutionScope,
  planEvidence: PlanEvidence,
  planVersion: number,
  reviewFindings: ReviewFindings | null,
): SessionState {
  const history = scope.state.plan ? [scope.state.plan.current, ...scope.state.plan.history] : [];
  const nextObligation = scope.reviewPolicy.subagentEnabled
    ? createReviewObligation({
        obligationType: 'plan',
        iteration: 0,
        planVersion,
        now: scope.ctx.now(),
      })
    : null;

  return {
    ...scope.state,
    plan: {
      current: planEvidence,
      history,
      reviewFindings: reviewFindings
        ? [...(scope.state.plan?.reviewFindings ?? []), reviewFindings]
        : scope.state.plan?.reviewFindings,
    },
    // #428: a new plan invalidates any prior validation evidence. Without this
    // reset, a stale failed-check result (passed:false) survives the re-plan and
    // makes VALIDATION re-entry fire CHECK_FAILED → PLAN before any check is
    // re-executed — an infinite PLAN→PLAN_REVIEW→VALIDATION→PLAN cycle that
    // auto-advance now (correctly) fails closed on. Clearing validation returns
    // VALIDATION to the "checks pending" WAIT state so checks must be re-run.
    validation: [],
    selfReview: {
      iteration: 0,
      maxIterations: scope.maxSelfReviewIterations,
      prevDigest: null,
      currDigest: planEvidence.digest,
      revisionDelta: 'major',
      verdict: 'changes_requested',
    },
    reviewAssurance: appendReviewObligation(scope.state.reviewAssurance, nextObligation),
    error: null,
  };
}

function findUnconsumedPlanObligation(state: SessionState) {
  const assuranceBase = ensureReviewAssurance(state.reviewAssurance);
  const pendingObligation = [...assuranceBase.obligations]
    .reverse()
    .find(
      (item) =>
        item.obligationType === 'plan' && item.status !== 'consumed' && item.consumedAt == null,
    );
  return { assuranceBase, pendingObligation };
}

function resolveEffectivePlanFindings(scope: PlanExecutionScope) {
  const { assuranceBase, pendingObligation } = findUnconsumedPlanObligation(scope.state);
  const expectedIteration = pendingObligation?.iteration ?? scope.state.selfReview!.iteration;
  const expectedPlanVersion =
    pendingObligation?.planVersion ?? scope.state.plan!.history.length + 1;
  const resolved = resolveHostTaskEffectiveFindings({
    pendingObligation: pendingObligation ?? null,
    expected: {
      obligationType: 'plan',
      iteration: expectedIteration,
      planVersion: expectedPlanVersion,
    },
    policy: {
      reviewInvocationPolicy: scope.policy.reviewInvocationPolicy,
      strictEnforcement: scope.reviewPolicy.strictEnforcement,
      subagentEnabled: scope.reviewPolicy.subagentEnabled,
      fallbackToSelf: scope.reviewPolicy.fallbackToSelf,
    },
    input: {
      reviewFindings: scope.args.reviewFindings,
      reviewerUnavailable: scope.args.reviewerUnavailable,
      verdict: scope.args.reviewVerdict,
    },
    state: {
      assurance: scope.state.reviewAssurance,
      sessionId: scope.context.sessionID,
      reviewHostPlatform: resolveRuntimeReviewPlatform(),
    },
  });
  return { assuranceBase, pendingObligation, expectedIteration, expectedPlanVersion, resolved };
}

function blockedInvalidPlanFindings(
  args: PlanArgs,
  effectiveFindings: ReviewFindings | null,
  obligationId: string | undefined,
): string | null {
  if (!effectiveFindings) {
    const blocked = requireReviewFindings(false);
    if (blocked) return blocked;
  }
  if (effectiveFindings?.overallVerdict === 'unable_to_review') {
    return formatBlocked('SUBAGENT_UNABLE_TO_REVIEW', {
      obligationId: obligationId ?? 'unknown',
    });
  }
  if (effectiveFindings && effectiveFindings.overallVerdict !== args.reviewVerdict) {
    return formatBlocked('SUBAGENT_FINDINGS_VERDICT_MISMATCH', {
      submittedVerdict: args.reviewVerdict as string,
      findingsVerdict: effectiveFindings.overallVerdict,
    });
  }
  return null;
}

function applyPlanRevision(scope: PlanExecutionScope): PlanRevisionResult | string {
  const state = scope.state;
  const verdict = scope.args.reviewVerdict as LoopVerdict;
  const prevDigest = state.plan!.current.digest;
  let currentPlan = state.plan!.current;
  let history = [...state.plan!.history];
  let revisionDelta: RevisionDelta = 'none';

  if (verdict !== 'changes_requested') {
    return { currentPlan, history, revisionDelta, prevDigest, verdict };
  }

  const revisedBody = scope.args.planText?.trim();
  if (!revisedBody) return formatBlocked('REVISED_PLAN_REQUIRED');

  const revised = buildPlanEvidence(revisedBody, scope);
  revisionDelta = revised.digest === prevDigest ? 'none' : 'minor';
  history = [currentPlan, ...history];
  currentPlan = revised;
  return { currentPlan, history, revisionDelta, prevDigest, verdict };
}

function buildReviewedPlanState(
  scope: PlanExecutionScope,
  revision: PlanRevisionResult,
  effectiveFindings: ReviewFindings | null,
  consumedAssurance: ReturnType<typeof consumeReviewObligation>,
): SessionState {
  const existingReviewFindings = scope.state.plan?.reviewFindings;
  const newReviewFindings = effectiveFindings
    ? [...(existingReviewFindings ?? []), effectiveFindings]
    : existingReviewFindings;

  return {
    ...scope.state,
    plan: {
      current: revision.currentPlan,
      history: revision.history,
      reviewFindings: newReviewFindings,
    },
    selfReview: {
      iteration: scope.state.selfReview!.iteration + 1,
      maxIterations: scope.maxSelfReviewIterations,
      prevDigest: revision.prevDigest,
      currDigest: revision.currentPlan.digest,
      revisionDelta: revision.revisionDelta,
      verdict: revision.verdict,
    },
    reviewAssurance: {
      obligations: consumedAssurance.obligations,
      invocations: consumedAssurance.invocations,
    },
    error: null,
  };
}

function consumePlanObligation(
  scope: PlanExecutionScope,
  assuranceBase: ReturnType<typeof ensureReviewAssurance>,
  expectedIteration: number,
  expectedPlanVersion: number,
  evidenceInvocationId: string | null,
) {
  const strictObligation = scope.reviewPolicy.strictEnforcement
    ? findLatestObligation(
        assuranceBase.obligations,
        'plan',
        expectedIteration,
        expectedPlanVersion,
      )
    : null;
  return consumeReviewObligation(
    assuranceBase,
    strictObligation,
    scope.ctx.now(),
    evidenceInvocationId ??
      findAcceptedInvocationForFindings(assuranceBase, strictObligation, scope.args.reviewFindings)
        ?.invocationId,
  );
}

// ---- tool handlers ----

async function handlePlanSubmission(scope: PlanExecutionScope): Promise<string> {
  const planBody = scope.args.planText?.trim();
  if (!planBody) return formatBlocked('EMPTY_PLAN');

  const planEvidence = buildPlanEvidence(planBody, scope);
  const history = scope.state.plan ? [scope.state.plan.current, ...scope.state.plan.history] : [];
  const planVersion = history.length + 1;
  const reviewFindings = scope.args.reviewFindings ?? null;
  const nextState = buildPlanSubmissionState(scope, planEvidence, planVersion, reviewFindings);
  const evalFn = (s: SessionState) => evaluate(s, scope.policy);
  const advanced = autoAdvance(nextState, evalFn, scope.ctx);
  // #428: fail closed on overflow BEFORE persisting — no partially-advanced write.
  if (advanced.kind === 'overflow') {
    return formatAutoAdvanceOverflow(advanced);
  }
  const { state: finalState, transitions } = advanced;

  await writeStateWithArtifacts(scope.sessDir, finalState);
  const response = buildSubmissionResponse({
    scope,
    finalState,
    planEvidence,
    planVersion,
    reviewFindings,
    transitions,
  });
  return appendNextAction(JSON.stringify(response), finalState);
}

async function handlePlanReview(scope: PlanExecutionScope): Promise<string> {
  if (!scope.state.selfReview) return formatBlocked('NO_SELF_REVIEW');
  if (!scope.state.plan) return formatBlocked('NO_PLAN');

  const lookup = resolveEffectivePlanFindings(scope);
  if (lookup.resolved.blocked) return lookup.resolved.blocked;
  const effectiveFindings = lookup.resolved.effectiveFindings ?? null;
  const blocked = blockedInvalidPlanFindings(
    scope.args,
    effectiveFindings,
    lookup.pendingObligation?.obligationId,
  );
  if (blocked) return blocked;

  const revision = applyPlanRevision(scope);
  if (typeof revision === 'string') return revision;
  const consumedAssurance = consumePlanObligation(
    scope,
    lookup.assuranceBase,
    lookup.expectedIteration,
    lookup.expectedPlanVersion,
    lookup.resolved.evidenceInvocationId ?? null,
  );
  return persistReview(
    scope,
    revision,
    effectiveFindings,
    consumedAssurance,
    buildReviewedPlanState,
  );
}

// ---- tool definition ----

export const plan: ToolDefinition = {
  description:
    'Submit a plan OR record an independent reviewer verdict. Two modes:\n' +
    'Mode A (submit plan): provide planText. Records the plan and starts the independent review loop.\n' +
    "Mode B (reviewer verdict): provide reviewVerdict ('accept' or 'changes_requested'). " +
    'In host-task mode the plugin resolves the reviewer findings automatically — submit the verdict only. ' +
    "In SDK mode pass the reviewer's exact reviewFindings. If 'changes_requested', also provide revised planText.\n" +
    'The independent review loop runs up to maxIterations (from policy). ' +
    'On convergence it advances to the PLAN_REVIEW user gate; it does NOT approve the plan. ' +
    'Only the user approves via flowguard_decision (/review-decision).',
  args: {
    planText: z
      .string()
      .optional()
      .describe(
        'Plan body text (markdown). Required for Mode A (initial submission) ' +
          "and when reviewVerdict is 'changes_requested' (revised plan).",
      ),
    reviewVerdict: z
      .enum(['accept', 'changes_requested'])
      .optional()
      .describe(
        "The INDEPENDENT REVIEWER's verdict on the plan — NOT user approval. " +
          'Omit for initial plan submission. ' +
          "'accept' = the reviewer accepts the plan; the loop converges and advances to the " +
          'PLAN_REVIEW user gate (the user still approves via /review-decision). ' +
          "'changes_requested' = the plan needs revision; provide updated planText.",
      ),
    reviewFindings: ReviewFindingsSchema.optional().describe(
      "The reviewer's structured findings. SDK mode only — pass the reviewer output verbatim. " +
        'In host-task mode do NOT submit reviewFindings: the plugin resolves them from captured ' +
        'evidence, and hand-edited or mismatched findings are rejected.',
    ),
    reviewerUnavailable: z
      .boolean()
      .optional()
      .describe(
        'Set to true ONLY after a real reviewer-subagent spawn failure (Task tool fails, agent ' +
          'unavailable). This is a fail-closed signal: FlowGuard blocks with SUBAGENT_UNABLE_TO_REVIEW ' +
          'and recovery guidance. It never enables self-review and never approves the plan.',
      ),
  },
  async execute(args, context) {
    try {
      return await withMutableSessionTransaction(context, async (mutableSession) => {
        const typedArgs = normalizeInitialPlanSubmissionArgs(
          args as PlanArgs,
          mutableSession.state,
        );
        const scope: PlanExecutionScope = {
          ...mutableSession,
          args: typedArgs,
          context,
          input: planInputFlags(typedArgs),
          reviewPolicy: planReviewPolicy(mutableSession),
          maxSelfReviewIterations: mutableSession.policy.maxSelfReviewIterations,
        };
        const blocked = validatePlanRequest(scope);
        if (blocked) return blocked;
        return scope.input.isInitialSubmission
          ? handlePlanSubmission(scope)
          : handlePlanReview(scope);
      });
    } catch (err) {
      return formatError(err);
    }
  },
};
