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
 * - selfReviewVerdict=approve + missing reviewFindings → BLOCKED
 * - reviewFindings.planVersion mismatch → BLOCKED
 *
 * @version v6
 */

import { z } from 'zod';

import type { ToolDefinition, ToolContext } from './helpers.js';
import {
  withMutableSession,
  formatEval,
  formatBlocked,
  formatError,
  extractSections,
  appendNextAction,
  writeStateWithArtifacts,
} from './helpers.js';
import {
  PHASE_LABELS,
  buildProductNextAction,
  buildPlanReviewCard,
} from '../../presentation/index.js';
import { materializeReviewCardArtifact } from '../../adapters/workspace/index.js';
import { resolveNextAction } from '../../machine/next-action.js';

// State & Machine
import type { SessionState } from '../../state/schema.js';
import { evaluate } from '../../machine/evaluate.js';
import { isCommandAllowed, Command } from '../../machine/commands.js';

// Rail helpers
import { autoAdvance } from '../../rails/types.js';

// Evidence types
import type {
  PlanEvidence,
  LoopVerdict,
  RevisionDelta,
  ReviewFindings,
} from '../../state/evidence.js';
import { ReviewFindings as ReviewFindingsSchema } from '../../state/evidence.js';

// Review findings validation (shared with implement.ts)
import { REVIEWER_SUBAGENT_TYPE } from '../../shared/flowguard-identifiers.js';
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
  reviewObligationResponseFields,
} from '../review/assurance.js';

type PlanArgs = {
  planText?: string;
  selfReviewVerdict?: 'approve' | 'changes_requested';
  reviewFindings?: ReviewFindings;
  reviewerUnavailable?: boolean;
};

type MutablePlanSession = Awaited<ReturnType<typeof withMutableSession>>;

type PlanInputFlags = {
  hasPlanText: boolean;
  hasVerdict: boolean;
  hasFindings: boolean;
  isInitialSubmission: boolean;
};

type PlanReviewPolicy = {
  subagentEnabled: boolean;
  fallbackToSelf: boolean;
  strictEnforcement: boolean;
};

type PlanExecutionScope = MutablePlanSession & {
  args: PlanArgs;
  context: ToolContext;
  input: PlanInputFlags;
  reviewPolicy: PlanReviewPolicy;
  maxSelfReviewIterations: number;
};

type PlanRevisionResult = {
  currentPlan: PlanEvidence;
  history: PlanEvidence[];
  revisionDelta: RevisionDelta;
  prevDigest: string;
  verdict: LoopVerdict;
};

type PlanSubmissionResponseInput = {
  scope: PlanExecutionScope;
  finalState: SessionState;
  planEvidence: PlanEvidence;
  planVersion: number;
  reviewFindings: ReviewFindings | null;
  transitions: unknown;
};

type ConvergedPlanReviewInput = {
  scope: PlanExecutionScope;
  finalState: SessionState;
  ev: Parameters<typeof formatEval>[0];
  transitions: unknown;
  revision: PlanRevisionResult;
  iteration: number;
};

/** Extract the first non-empty line of text, truncated to 120 characters. */
function firstLine(text: string | undefined): string | undefined {
  if (text == null) return undefined;
  const line =
    text
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? '';
  return line.length > 120 ? line.slice(0, 117) + '...' : line;
}

function planInputFlags(args: PlanArgs): PlanInputFlags {
  const hasPlanText = typeof args.planText === 'string' && args.planText.trim().length > 0;
  // BUG-21: Use typeof checks — `!== undefined` is true for null (which LLMs
  // may send for absent optional fields). Post-Zod these can only be string/object
  // or undefined, but defense-in-depth protects against schema changes.
  const hasVerdict =
    typeof args.selfReviewVerdict === 'string' && args.selfReviewVerdict.length > 0;
  const hasFindings = args.reviewFindings != null && typeof args.reviewFindings === 'object';
  return {
    hasPlanText,
    hasVerdict,
    hasFindings,
    isInitialSubmission: !hasVerdict,
  };
}

function planReviewPolicy(scope: MutablePlanSession): PlanReviewPolicy {
  return {
    subagentEnabled: scope.policy.selfReview?.subagentEnabled ?? false,
    fallbackToSelf: scope.policy.selfReview?.fallbackToSelf ?? false,
    strictEnforcement: scope.policy.selfReview?.strictEnforcement ?? false,
  };
}

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

function validatePlanInputShape(
  args: PlanArgs,
  input: PlanInputFlags,
  state: SessionState,
): string | null {
  return validateSubmissionInputShape(args, input) ?? validateReviewInputShape(input, state);
}

function validateSubmissionInputShape(args: PlanArgs, input: PlanInputFlags): string | null {
  if (input.hasPlanText && input.hasFindings && !input.hasVerdict) {
    return formatBlocked('PLAN_SUBMISSION_MIXED_INPUTS');
  }
  if (input.hasPlanText && input.hasVerdict && args.selfReviewVerdict !== 'changes_requested') {
    return formatBlocked('PLAN_APPROVE_WITH_TEXT');
  }
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

function buildPlanSubmissionResponse(input: PlanSubmissionResponseInput): Record<string, unknown> {
  const { scope, finalState, planEvidence, planVersion, reviewFindings, transitions } = input;
  const nextObligation = scope.reviewPolicy.subagentEnabled
    ? findLatestObligation(finalState.reviewAssurance?.obligations ?? [], 'plan', 0, planVersion)
    : null;
  const response: Record<string, unknown> = {
    phase: finalState.phase,
    status: 'Plan submitted (v' + planVersion + ').',
    planDigest: planEvidence.digest,
    selfReviewIteration: 0,
    maxSelfReviewIterations: scope.maxSelfReviewIterations,
    reviewMode: scope.reviewPolicy.subagentEnabled ? 'subagent' : 'self',
    ...reviewObligationResponseFields(nextObligation),
    next: initialPlanReviewNext(planVersion),
    _audit: { transitions },
  };
  if (reviewFindings) response.latestReview = latestPlanReviewSummary(reviewFindings, planVersion);
  return response;
}

function initialPlanReviewNext(planVersion: number): string {
  return (
    `INDEPENDENT_REVIEW_REQUIRED: Before submitting your review verdict, ` +
    `you MUST call the ${REVIEWER_SUBAGENT_TYPE} subagent via the Task tool. ` +
    `Use subagent_type "${REVIEWER_SUBAGENT_TYPE}" with a prompt that includes: ` +
    '(1) the full plan text, (2) the ticket text, (3) iteration=0, ' +
    '(4) planVersion=' +
    planVersion +
    '. ' +
    'Parse the JSON ReviewFindings from the subagent response. ' +
    'Then call flowguard_plan with selfReviewVerdict based on the findings ' +
    'overallVerdict, and include the reviewFindings object. ' +
    'If the subagent returns changes_requested, revise the plan and resubmit.'
  );
}

function latestPlanReviewSummary(
  reviewFindings: ReviewFindings,
  planVersion: number,
): Record<string, unknown> {
  return {
    iteration: reviewFindings.iteration,
    planVersion,
    overallVerdict: reviewFindings.overallVerdict,
    blockingIssueCount: reviewFindings.blockingIssues.length,
    majorRiskCount: reviewFindings.majorRisks.length,
    missingVerificationCount: reviewFindings.missingVerification.length,
    reviewMode: reviewFindings.reviewMode,
    reviewedAt: reviewFindings.reviewedAt,
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
      verdict: scope.args.selfReviewVerdict,
    },
    state: { assurance: scope.state.reviewAssurance, sessionId: scope.context.sessionID },
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
  if (effectiveFindings && effectiveFindings.overallVerdict !== args.selfReviewVerdict) {
    return formatBlocked('SUBAGENT_FINDINGS_VERDICT_MISMATCH', {
      submittedVerdict: args.selfReviewVerdict as string,
      findingsVerdict: effectiveFindings.overallVerdict,
    });
  }
  return null;
}

function applyPlanRevision(scope: PlanExecutionScope): PlanRevisionResult | string {
  const state = scope.state;
  const verdict = scope.args.selfReviewVerdict as LoopVerdict;
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
  // BUG-15 Stufe 2: For evidence-resolved findings, use the known invocationId directly.
  return consumeReviewObligation(
    assuranceBase,
    strictObligation,
    scope.ctx.now(),
    evidenceInvocationId ??
      findAcceptedInvocationForFindings(assuranceBase, strictObligation, scope.args.reviewFindings)
        ?.invocationId,
  );
}

async function persistConvergedPlanReview(input: ConvergedPlanReviewInput): Promise<string> {
  const { scope, finalState } = input;
  await writeStateWithArtifacts(scope.sessDir, finalState);
  if (finalState.phase !== 'PLAN_REVIEW') {
    return appendNextAction(JSON.stringify(convergedPlanResponse(input)), finalState);
  }

  const response = await convergedPlanReviewCardResponse(input);
  return appendNextAction(JSON.stringify(response), finalState);
}

function convergedPlanResponse(input: ConvergedPlanReviewInput): Record<string, unknown> {
  const { finalState, ev, transitions, revision, iteration } = input;
  return {
    phase: finalState.phase,
    status: `Independent review converged at iteration ${iteration}. Workflow advanced to ${finalState.phase}.`,
    planDigest: revision.currentPlan.digest,
    selfReviewIteration: iteration,
    next: formatEval(ev),
    _audit: { transitions },
  };
}

async function convergedPlanReviewCardResponse(
  input: ConvergedPlanReviewInput,
): Promise<Record<string, unknown>> {
  const { scope, finalState, ev, transitions, revision, iteration } = input;
  const nextAction = resolveNextAction(finalState.phase, finalState);
  const productNext = buildProductNextAction(nextAction, finalState.phase);
  const reviewCard = buildPlanReviewCard({
    planText: revision.currentPlan.body,
    phase: finalState.phase,
    phaseLabel: PHASE_LABELS[finalState.phase],
    productNextAction: productNext,
    planVersion: revision.history.length + 1,
    policyMode: finalState.policySnapshot?.mode,
    taskTitle: firstLine(finalState.ticket?.text),
  });
  const artifactErr = await materializeReviewCardArtifact(
    scope.sessDir,
    'plan-review-card',
    reviewCard,
    finalState,
    revision.currentPlan.digest,
  );
  const response: Record<string, unknown> = {
    phase: finalState.phase,
    status: `Independent review converged at iteration ${iteration}. Plan ready for approval.`,
    planDigest: revision.currentPlan.digest,
    selfReviewIteration: iteration,
    reviewCard,
    next: formatEval(ev),
    _audit: { transitions },
  };
  if (artifactErr) response.artifactWarning = artifactErr;
  return response;
}

async function persistNonConvergedPlanReview(
  scope: PlanExecutionScope,
  finalState: SessionState,
  transitions: unknown,
  revision: PlanRevisionResult,
  iteration: number,
): Promise<string> {
  const nextPlanVersion = revision.history.length + 1;
  const nextObligation = scope.reviewPolicy.subagentEnabled
    ? createReviewObligation({
        obligationType: 'plan',
        iteration,
        planVersion: nextPlanVersion,
        now: scope.ctx.now(),
      })
    : null;
  const stateToPersist = nextObligation
    ? {
        ...finalState,
        reviewAssurance: appendReviewObligation(finalState.reviewAssurance, nextObligation),
      }
    : finalState;
  await writeStateWithArtifacts(scope.sessDir, stateToPersist);
  return appendNextAction(
    JSON.stringify(
      nonConvergedPlanResponse(scope, finalState, transitions, revision, nextObligation),
    ),
    stateToPersist,
  );
}

function nonConvergedPlanResponse(
  scope: PlanExecutionScope,
  finalState: SessionState,
  transitions: unknown,
  revision: PlanRevisionResult,
  nextObligation: Parameters<typeof reviewObligationResponseFields>[0],
): Record<string, unknown> {
  const nextPlanVersion = revision.history.length + 1;
  return {
    phase: finalState.phase,
    status: `Independent review iteration ${scope.state.selfReview!.iteration + 1}/${scope.maxSelfReviewIterations}. Verdict: ${revision.verdict}.`,
    planDigest: revision.currentPlan.digest,
    selfReviewIteration: scope.state.selfReview!.iteration + 1,
    revisionDelta: revision.revisionDelta,
    reviewMode: 'subagent',
    ...reviewObligationResponseFields(nextObligation),
    next: revisedPlanReviewNext(scope.state.selfReview!.iteration + 1, nextPlanVersion),
    _audit: { transitions },
  };
}

function revisedPlanReviewNext(nextIteration: number, nextPlanVersion: number): string {
  return (
    `INDEPENDENT_REVIEW_REQUIRED: Call the ${REVIEWER_SUBAGENT_TYPE} subagent via Task tool ` +
    `to review the revised plan. Use subagent_type "${REVIEWER_SUBAGENT_TYPE}" with a prompt ` +
    'that includes: (1) the revised plan text, (2) the ticket text, (3) iteration=' +
    nextIteration +
    ', (4) planVersion=' +
    nextPlanVersion +
    '. ' +
    'Parse the JSON ReviewFindings and submit with your next selfReviewVerdict.'
  );
}

async function handlePlanSubmission(scope: PlanExecutionScope): Promise<string> {
  const planBody = scope.args.planText?.trim();
  if (!planBody) return formatBlocked('EMPTY_PLAN');

  const planEvidence = buildPlanEvidence(planBody, scope);
  const history = scope.state.plan ? [scope.state.plan.current, ...scope.state.plan.history] : [];
  const planVersion = history.length + 1;
  const reviewFindings = scope.args.reviewFindings ?? null;
  const nextState = buildPlanSubmissionState(scope, planEvidence, planVersion, reviewFindings);
  const evalFn = (s: SessionState) => evaluate(s, scope.policy);
  const { state: finalState, transitions } = autoAdvance(nextState, evalFn, scope.ctx);

  await writeStateWithArtifacts(scope.sessDir, finalState);
  const response = buildPlanSubmissionResponse({
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
  return persistPlanReview(scope, revision, effectiveFindings, consumedAssurance);
}

async function persistPlanReview(
  scope: PlanExecutionScope,
  revision: PlanRevisionResult,
  effectiveFindings: ReviewFindings | null,
  consumedAssurance: ReturnType<typeof consumeReviewObligation>,
): Promise<string> {
  const nextState = buildReviewedPlanState(scope, revision, effectiveFindings, consumedAssurance);
  const evalFn = (s: SessionState) => evaluate(s, scope.policy);
  const {
    state: finalState,
    evalResult: ev,
    transitions,
  } = autoAdvance(nextState, evalFn, scope.ctx);
  const iteration = scope.state.selfReview!.iteration + 1;
  const approvedConverged = revision.revisionDelta === 'none' && revision.verdict === 'approve';
  const maxReached = iteration >= scope.maxSelfReviewIterations;

  if (maxReached && !approvedConverged) {
    await writeStateWithArtifacts(scope.sessDir, finalState);
    return formatBlocked('MAX_REVIEW_ITERATIONS_REACHED', {
      iteration: String(iteration),
      maxIterations: String(scope.maxSelfReviewIterations),
      lastVerdict: revision.verdict,
    });
  }
  if (approvedConverged) {
    return persistConvergedPlanReview({ scope, finalState, ev, transitions, revision, iteration });
  }
  return persistNonConvergedPlanReview(scope, finalState, transitions, revision, iteration);
}

// ═══════════════════════════════════════════════════════════════════════════════
// flowguard_plan — Submit Plan OR Independent Review Verdict (Multi-Mode)
// ═══════════════════════════════════════════════════════════════════════════════

export const plan: ToolDefinition = {
  description:
    'Submit a plan OR record an independent review verdict. Two modes:\n' +
    'Mode A (submit plan): provide planText. Records the plan and starts the independent review loop.\n' +
    "Mode B (review verdict): provide selfReviewVerdict ('approve' or 'changes_requested') with reviewFindings. " +
    "If 'changes_requested', also provide revised planText.\n" +
    'The independent review loop runs up to maxIterations (from policy). ' +
    'On convergence, auto-advances to PLAN_REVIEW.\n' +
    'Optionally accepts reviewFindings from an independent review agent.',
  args: {
    planText: z
      .string()
      .optional()
      .describe(
        'Plan body text (markdown). Required for Mode A (initial submission) ' +
          "and when selfReviewVerdict is 'changes_requested' (revised plan).",
      ),
    selfReviewVerdict: z
      .enum(['approve', 'changes_requested'])
      .optional()
      .describe(
        'Independent review verdict. Omit for initial plan submission. ' +
          "'approve' = plan is good, advance. " +
          "'changes_requested' = plan needs revision, provide updated planText.",
      ),
    reviewFindings: ReviewFindingsSchema.optional().describe(
      'Structured review findings from independent review. ' +
        'Required when selfReviewVerdict is "approve" and subagentEnabled=true.',
    ),
    reviewerUnavailable: z
      .boolean()
      .optional()
      .describe(
        'Set to true when the reviewer subagent cannot be invoked (Task tool fails, ' +
          'agent unavailable). Allows self-review fallback in host_task_required mode.',
      ),
  },
  async execute(args, context) {
    try {
      const mutableSession = await withMutableSession(context);
      const typedArgs = args as PlanArgs;
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
    } catch (err) {
      return formatError(err);
    }
  },
};
