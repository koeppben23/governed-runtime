/**
 * @module integration/tools/plan
 * @description FlowGuard plan tool — submit plan or record independent review verdict.
 *
 * Host-Observed Independent Review Persistence Boundary
 *
 * Architecture: FlowGuard does NOT call subagents. The OpenCode primary agent
 * orchestrates independent review by calling the flowguard-reviewer subagent
 * via the Task tool. The HOST captures the reviewer's structured findings into
 * the review assurance evidence; the agent never resubmits findings.
 *
 * Flow:
 * 1. Primary agent drafts plan, submits to FlowGuard
 * 2. FlowGuard returns next-action instructing subagent invocation
 * 3. Primary agent calls flowguard-reviewer subagent via Task tool
 * 4. Host captures the reviewer's structured findings into invocation evidence
 * 5. Primary agent submits the review verdict ONLY (reviewVerdict)
 * 6. FlowGuard resolves the host-captured findings, validates the binding, and
 *    persists them (append-only, separate)
 *
 * Tool responsibilities:
 * - Input validation: verdict vs host-captured evidence binding
 * - Persistence: plan.history (author), plan.reviewFindings (host-captured)
 * - Response: summary of review findings, iteration tracking
 * - Next-action: independent reviewer instructions
 *
 * Validation rules:
 * - reviewMode=self → BLOCKED
 * - reviewVerdict without bound structured evidence → SUBAGENT_EVIDENCE_MISSING
 * - captured findings binding mismatch → BLOCKED
 *
 * @version v8
 */

import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import {
  freezeContextAuthorityAtHead,
  frozenAuthorityOrUndefined,
} from '../../rails/repository-authority.js';
import { resolveAttemptDiscoveryOrBlock } from '../review/discovery-attempt-context.js';

import type { ToolDefinition } from './helpers.js';
import { projectMarkdownHeadings } from '../../shared/markdown-sections.js';
import { formatError } from './error-format.js';
import {
  withMutableSessionTransaction,
  formatBlocked,
  formatAutoAdvanceOverflow,
  enrichWithWorkflowDirective,
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
import { computeRecordDigest, resolvePlanReviewCompletion } from '../../state/evidence-plan.js';
import { PlanClaimDeclarationInput as PlanClaimDeclarationSchema } from '../../state/proofgraph-approval.js';
import { normalizePlanClaims } from '../../state/proofgraph-approval.js';
import { resolveStructuredEffectiveFindings } from './review-validation.js';
import { collectPreviouslyUsedChallengeIds } from '../review/challenge-history.js';
import {
  appendReviewObligation,
  consumeReviewObligation,
  createObligationAndAttempt,
  ensureReviewAssurance,
  findLatestObligation,
} from '../review/assurance.js';
import { buildReviewChallengeContract } from '../review/challenge-contract.js';
import { resolvePreImplementationChallengeClassification } from './pre-implementation-challenge.js';
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
import { routePlanInitialSubmission, blockedPlanReviewInProgress } from './plan-route.js';
import { classifyPlanClaimSubmission } from './plan-claim-submission.js';
import {
  buildPlanSubmissionResponse as buildSubmissionResponse,
  buildPlanReviewObligationInput,
  persistPlanReview as persistReview,
} from './plan-response.js';

function validatePlanCallShape(scope: PlanExecutionScope): string | null {
  const { input, state } = scope;
  if (!isCommandAllowed(state.phase, Command.PLAN)) {
    return formatBlocked('COMMAND_NOT_ALLOWED', { command: '/plan', phase: state.phase });
  }
  if (!state.ticket) return formatBlocked('TICKET_REQUIRED', { action: 'creating a plan' });

  return validatePlanInputShape(scope.args, input, state);
}

function normalizeInitialPlanSubmissionArgs(args: PlanArgs, state: SessionState): PlanArgs {
  const hasPlanText = typeof args.planText === 'string' && args.planText.trim().length > 0;
  if (!hasPlanText || state.plan || state.phase !== 'TICKET') return args;
  return { planText: args.planText, claims: args.claims, targetPaths: args.targetPaths };
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
  return null;
}

function buildPlanEvidence(
  planBody: string,
  scope: PlanExecutionScope,
  lineage?: {
    planVersion: number;
    supersedesRecordDigest?: string | null;
    originatingReviewObligationId?: string | null;
    revisionReason?: string | null;
  },
): PlanEvidence {
  const contentDigest = scope.ctx.digest(planBody);
  const planVersion = lineage?.planVersion ?? 1;
  const supersedesRecordDigest = lineage?.supersedesRecordDigest ?? null;
  const originatingReviewObligationId = lineage?.originatingReviewObligationId ?? null;
  const revisionReason = lineage?.revisionReason ?? null;
  const revisionId = randomUUID();

  return {
    body: planBody,
    digest: contentDigest,
    sections: projectMarkdownHeadings(planBody),
    createdAt: scope.ctx.now(),
    revisionId,
    recordDigest: computeRecordDigest({
      contentDigest,
      planVersion,
      supersedesRecordDigest,
      originatingReviewObligationId,
      revisionReason,
      revisionId,
    }),
    planVersion,
    supersedesRecordDigest,
    originatingReviewObligationId,
    revisionReason,
    lineageStatus: 'verified' as const,
  };
}

/** Register the plan review obligation and its first attempt, when review applies. */
async function createPlanReviewAttempt(
  scope: PlanExecutionScope,
  planEvidence: PlanEvidence,
  planVersion: number,
  classificationFiles?: readonly string[],
): Promise<
  | {
      kind: 'ok';
      attemptResult: ReturnType<typeof createObligationAndAttempt> | null;
    }
  | { kind: 'blocked'; message: string }
> {
  const freeze = await freezeContextAuthorityAtHead(scope.worktree);
  const authority = frozenAuthorityOrUndefined(freeze);
  // Repository-governed attempts are minted WITH their host-owned Discovery
  // snapshot (persistence coherence); a structural projection failure blocks
  // the submission before any state mutation.
  const discovery = await resolveAttemptDiscoveryOrBlock({
    state: scope.state,
    worktree: scope.worktree,
    repositoryGoverned: authority !== undefined,
    now: scope.ctx.now(),
  });
  if (discovery.kind === 'blocked') {
    return {
      kind: 'blocked',
      message: formatBlocked('REVIEWER_CONTEXT_UNAVAILABLE', {
        reason: discovery.reason,
      }),
    };
  }
  const attemptResult = createObligationAndAttempt(
    scope.state.reviewAssurance,
    buildPlanReviewObligationInput(scope, planEvidence, planVersion, classificationFiles, {
      freeze,
      planClaimDeclarations: submittedPlanClaimDeclarations(scope),
    }),
    scope.ctx.now(),
    discovery.context,
  );
  return { kind: 'ok', attemptResult };
}

function currentClaimSubmissionDiagnostics(scope: PlanExecutionScope) {
  return scope.args.claims
    ? scope.claimSubmissionDiagnostics
    : scope.state.plan?.claimSubmissionDiagnostics;
}

/** The declaration set a plan submission writes: fresh normalized claims or the carried-over set. */
function submittedPlanClaimDeclarations(
  scope: PlanExecutionScope,
): import('../../state/proofgraph-approval.js').PlanClaimDeclarations | undefined {
  return scope.args.claims
    ? {
        flow: 'plan',
        version: 'v2' as const,
        claims: normalizePlanClaims(scope.args.claims)!,
      }
    : scope.state.plan?.claimDeclarations;
}

function appendClaimSubmissionHistory(scope: PlanExecutionScope, planVersion: number) {
  const history = scope.state.plan?.claimSubmissionHistory ?? [];
  if (!scope.args.claims || !scope.claimSubmissionDiagnostics) return history;
  return [...history, { planVersion, ...scope.claimSubmissionDiagnostics }];
}

function buildPlanSubmissionState(
  scope: PlanExecutionScope,
  planEvidence: PlanEvidence,
  planVersion: number,
  attempt: Extract<Awaited<ReturnType<typeof createPlanReviewAttempt>>, { kind: 'ok' }>,
): SessionState {
  const history = scope.state.plan ? [scope.state.plan.current, ...scope.state.plan.history] : [];
  const nextObligation = attempt.attemptResult?.obligation ?? null;

  return {
    ...scope.state,
    plan: {
      current: planEvidence,
      history,
      // Host-captured review findings are append-only and are only ever
      // written by handlePlanReview from the resolved structured evidence.
      reviewFindings: scope.state.plan?.reviewFindings,
      claimDeclarations: submittedPlanClaimDeclarations(scope),
      claimSubmissionDiagnostics: currentClaimSubmissionDiagnostics(scope),
      claimSubmissionHistory: appendClaimSubmissionHistory(scope, planVersion),
      reviewCompletion: 'pending',
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
      reviewCycle: scope.state.reviewCycles.plan,
      maxIterations: scope.maxPlanReviewIterations,
      prevDigest: null,
      currDigest: planEvidence.digest,
      revisionDelta: 'major',
      verdict: 'changes_requested',
    },
    reviewAssurance:
      attempt.attemptResult?.assurance ??
      appendReviewObligation(scope.state.reviewAssurance, nextObligation),
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
  const resolved = resolveStructuredEffectiveFindings({
    pendingObligation: pendingObligation ?? null,
    expected: {
      obligationType: 'plan',
      iteration: expectedIteration,
      planVersion: expectedPlanVersion,
    },
    input: {
      reviewerUnavailable: scope.args.reviewerUnavailable,
      verdict: scope.args.reviewVerdict,
    },
    state: {
      assurance: scope.state.reviewAssurance,
      sessionId: scope.context.sessionID,
      // Bind design-challenge evidence to the plan's canonical allowed refs
      // (finding B3): without this, a plan review challenge could cite a
      // fabricated ADR section / digest and pass.
      allowedChallengeEvidenceRefs: buildReviewChallengeContract(
        scope.state,
        pendingObligation ?? null,
      )?.evidenceRefs,
      previouslyUsedChallengeIds: collectPreviouslyUsedChallengeIds(scope.state),
    },
  });
  return { assuranceBase, pendingObligation, expectedIteration, expectedPlanVersion, resolved };
}

function blockedInvalidPlanFindings(
  args: PlanArgs,
  effectiveFindings: ReviewFindings,
  obligationId: string | undefined,
): string | null {
  if (effectiveFindings.overallVerdict === 'unable_to_review') {
    return formatBlocked('SUBAGENT_UNABLE_TO_REVIEW', {
      obligationId: obligationId ?? 'unknown',
    });
  }
  if (effectiveFindings.overallVerdict !== args.reviewVerdict) {
    return formatBlocked('SUBAGENT_FINDINGS_VERDICT_MISMATCH', {
      submittedVerdict: args.reviewVerdict as string,
      findingsVerdict: effectiveFindings.overallVerdict,
    });
  }
  return null;
}

function applyPlanRevision(
  scope: PlanExecutionScope,
  originatingReviewObligationId?: string | null,
): PlanRevisionResult | string {
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
  if (!scope.args.claims) {
    return formatBlocked('REVISED_PLAN_CLAIMS_REQUIRED');
  }

  const predecessorVersion = currentPlan.planVersion;
  const revised = buildPlanEvidence(revisedBody, scope, {
    planVersion: predecessorVersion + 1,
    supersedesRecordDigest: currentPlan.recordDigest,
    originatingReviewObligationId: originatingReviewObligationId ?? null,
    revisionReason: 'Review requested changes',
  });
  revisionDelta = revised.digest === prevDigest ? 'none' : 'minor';
  history = [currentPlan, ...history];
  currentPlan = revised;
  return { currentPlan, history, revisionDelta, prevDigest, verdict };
}

function buildReviewedPlanState(
  scope: PlanExecutionScope,
  revision: PlanRevisionResult,
  effectiveFindings: ReviewFindings,
  consumedAssurance: ReturnType<typeof consumeReviewObligation>,
): SessionState {
  // Only host-captured effective findings are ever appended.
  const existingReviewFindings = scope.state.plan?.reviewFindings;
  const newReviewFindings = [...(existingReviewFindings ?? []), effectiveFindings];
  const nextIteration = scope.state.selfReview!.iteration + 1;

  return {
    ...scope.state,
    plan: {
      current: revision.currentPlan,
      history: revision.history,
      reviewFindings: newReviewFindings,
      claimDeclarations: submittedPlanClaimDeclarations(scope),
      claimSubmissionDiagnostics: currentClaimSubmissionDiagnostics(scope),
      claimSubmissionHistory: appendClaimSubmissionHistory(scope, revision.currentPlan.planVersion),
      reviewCompletion: resolvePlanReviewCompletion(
        nextIteration,
        scope.maxPlanReviewIterations,
        revision.revisionDelta,
        revision.verdict,
      ),
    },
    selfReview: {
      iteration: nextIteration,
      reviewCycle: scope.state.reviewCycles.plan,
      maxIterations: scope.maxPlanReviewIterations,
      prevDigest: revision.prevDigest,
      currDigest: revision.currentPlan.digest,
      revisionDelta: revision.revisionDelta,
      verdict: revision.verdict,
    },
    reviewAssurance: {
      ...consumedAssurance,
    },
    error: null,
  };
}

function consumePlanObligation(
  scope: PlanExecutionScope,
  assuranceBase: ReturnType<typeof ensureReviewAssurance>,
  expectedIteration: number,
  expectedPlanVersion: number,
  evidenceInvocationId: string,
) {
  const strictObligation = findLatestObligation(
    assuranceBase.obligations,
    'plan',
    expectedIteration,
    expectedPlanVersion,
  );
  return consumeReviewObligation(
    assuranceBase,
    strictObligation,
    scope.ctx.now(),
    evidenceInvocationId,
  );
}

// ---- tool handlers ----

async function handlePlanSubmission(scope: PlanExecutionScope): Promise<string> {
  const planBody = scope.args.planText?.trim();
  if (!planBody) return formatBlocked('EMPTY_PLAN');

  const predecessorVersion = scope.state.plan?.current.planVersion;
  const planVersion = predecessorVersion ? predecessorVersion + 1 : 1;

  const planEvidence = buildPlanEvidence(planBody, scope, {
    planVersion,
    supersedesRecordDigest: scope.state.plan?.current.recordDigest ?? null,
    originatingReviewObligationId: originatingPlanReviewObligationId(scope),
    revisionReason: scope.state.plan ? 'Revision after changes requested' : null,
  });
  const classification = await resolvePreImplementationChallengeClassification(
    scope.state,
    scope.worktree,
    scope.args.targetPaths,
  );
  const attempt = await createPlanReviewAttempt(
    scope,
    planEvidence,
    planVersion,
    classification.kind === 'available' ? classification.changedFiles : [],
  );
  if (attempt.kind === 'blocked') return attempt.message;
  const nextState = buildPlanSubmissionState(scope, planEvidence, planVersion, attempt);
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
    transitions,
  });
  return JSON.stringify(enrichWithWorkflowDirective(response, finalState));
}

/**
 * The review obligation whose changes_requested verdict triggered this revision,
 * so the plan record digest proves which obligation caused it.
 */
function originatingPlanReviewObligationId(scope: PlanExecutionScope): string | null {
  return (
    [...(scope.state.reviewAssurance?.obligations ?? [])]
      .reverse()
      .find(
        (o) => o.obligationType === 'plan' && (o.status === 'fulfilled' || o.status === 'consumed'),
      )?.obligationId ?? null
  );
}

async function handlePlanReview(scope: PlanExecutionScope): Promise<string> {
  if (!scope.state.selfReview) return formatBlocked('NO_SELF_REVIEW');
  if (!scope.state.plan) return formatBlocked('NO_PLAN');

  const lookup = resolveEffectivePlanFindings(scope);
  if (lookup.resolved.kind === 'blocked') return lookup.resolved.blocked;
  const effectiveFindings = lookup.resolved.effectiveFindings;
  const blocked = blockedInvalidPlanFindings(
    scope.args,
    effectiveFindings,
    lookup.pendingObligation?.obligationId,
  );
  if (blocked) return blocked;

  const revision = applyPlanRevision(scope, lookup.pendingObligation?.obligationId);
  if (typeof revision === 'string') return revision;
  const consumedAssurance = consumePlanObligation(
    scope,
    lookup.assuranceBase,
    lookup.expectedIteration,
    lookup.expectedPlanVersion,
    lookup.resolved.evidenceInvocationId,
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
    "Mode B (reviewer verdict): provide reviewVerdict only ('accept' or 'changes_requested'). " +
    'The host captures the reviewer findings; FlowGuard resolves them from that evidence automatically. ' +
    "Never submit reviewer findings. If 'changes_requested', provide revised planText and claims.\n" +
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
    claims: z
      .array(PlanClaimDeclarationSchema)
      .optional()
      .describe(
        'Pre-evidence claims made by this plan version. Each names its governing plan section and expected implementation check.',
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
    reviewerUnavailable: z
      .boolean()
      .optional()
      .describe(
        'Set to true ONLY after a real reviewer-subagent spawn failure (Task tool fails, agent ' +
          'unavailable). This is a fail-closed signal: FlowGuard blocks with SUBAGENT_UNABLE_TO_REVIEW ' +
          'and recovery guidance. It never enables self-review and never approves the plan.',
      ),
    targetPaths: z
      .array(z.string())
      .optional()
      .describe(
        'File paths targeted by this plan. Required when the policy mandates review challenges. ' +
          'Provides the changed-file evidence that challenge obligations bind against.',
      ),
  },
  async execute(args, context) {
    try {
      return await withMutableSessionTransaction(context, async (mutableSession) => {
        const typedArgs = normalizeInitialPlanSubmissionArgs(
          args as PlanArgs,
          mutableSession.state,
        );
        let scope: PlanExecutionScope = {
          ...mutableSession,
          args: typedArgs,
          context,
          input: planInputFlags(typedArgs),
          reviewPolicy: planReviewPolicy(mutableSession),
          maxPlanReviewIterations: mutableSession.policy.reviewBudget.plan,
        };
        // Call-shape validation runs FIRST: mixed inputs are rejected before
        // any lifecycle routing can re-emit a review instruction.
        const shapeBlocked = validatePlanCallShape(scope);
        if (shapeBlocked) return shapeBlocked;
        const claimClassification = classifyPlanClaimSubmission(
          scope.args,
          scope.state,
          scope.ctx.digest,
        );
        if (claimClassification.kind === 'blocked') return claimClassification.message;
        scope = {
          ...scope,
          args: claimClassification.args,
          ...(claimClassification.diagnostics
            ? { claimSubmissionDiagnostics: claimClassification.diagnostics }
            : {}),
        };
        if (scope.input.isInitialSubmission) {
          // Re-invocation routing for an existing plan obligation:
          // output-repair reissue or attempt re-emission. A blocked plan
          // obligation falls through to the regular submission path (fresh
          // plan revision + fresh obligation).
          const routed = await routePlanInitialSubmission(scope);
          if (routed !== null) return routed;
        }
        if (
          scope.input.isInitialSubmission &&
          scope.input.hasPlanText &&
          scope.state.phase === 'PLAN' &&
          scope.state.selfReview
        ) {
          const gateBlocked = blockedPlanReviewInProgress(scope.state);
          if (gateBlocked) return gateBlocked;
        }
        return scope.input.isInitialSubmission
          ? handlePlanSubmission(scope)
          : handlePlanReview(scope);
      });
    } catch (err) {
      return formatError(err);
    }
  },
};
