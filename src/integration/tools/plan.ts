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

import type { ToolDefinition } from './helpers.js';
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
import { PlanClaimDeclarationInput as PlanClaimDeclarationSchema } from '../../state/proofgraph-approval.js';
import { findLatestObligation } from '../review/assurance.js';
import {
  resolveReviewDispatchAuthority,
  type ReviewDispatchAuthority,
} from '../review/dispatch-authority.js';
import { resolvePreImplementationChallengeClassification } from './pre-implementation-challenge.js';
import {
  buildPlanEvidence,
  buildPlanSubmissionState,
  createPlanReviewAttempt,
} from './plan-submission-state.js';
import {
  applyPlanRevision,
  blockedInvalidPlanFindings,
  buildReviewedPlanState,
  consumePlanObligation,
  resolveEffectivePlanFindings,
} from './plan-review-state.js';
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
import type { PlanArgs, PlanInputFlags, PlanExecutionScope } from './plan-types.js';

// ---- internal helpers ----

import { classifyPlanCall, planInputFlags, planReviewPolicy } from './plan-types.js';
import { responseReportsError, runActiveChecksAutomatically } from './auto-validation.js';
import { routePlanInitialSubmission, blockedPlanReviewInProgress } from './plan-route.js';
import { classifyPlanClaimSubmission } from './plan-claim-submission.js';
import {
  buildPlanSubmissionResponse as buildSubmissionResponse,
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

// ---- tool handlers ----

function resolvePlanDispatchAuthority(
  finalState: SessionState,
  planVersion: number,
):
  | { readonly kind: 'ok'; readonly authority: ReviewDispatchAuthority }
  | {
      readonly kind: 'blocked';
      readonly code: 'REVIEW_ATTEMPT_UNAVAILABLE';
      readonly reason: string;
    } {
  const obligation = findLatestObligation(
    finalState.reviewAssurance?.obligations ?? [],
    'plan',
    0,
    planVersion,
  );
  if (!obligation) {
    return {
      kind: 'blocked',
      code: 'REVIEW_ATTEMPT_UNAVAILABLE',
      reason: 'the plan submission produced no review obligation authority',
    };
  }
  return resolveReviewDispatchAuthority(finalState.reviewAssurance, obligation.obligationId);
}

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
  const authority = resolvePlanDispatchAuthority(finalState, planVersion);
  if (authority.kind === 'blocked') {
    return formatBlocked(authority.code, { reason: authority.reason });
  }
  const response = buildSubmissionResponse({
    scope,
    finalState,
    planEvidence,
    planVersion,
    transitions,
    authority: authority.authority,
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
      const response = await withMutableSessionTransaction(context, async (mutableSession) => {
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

      // Automatic validation: when a solo-mode (or CI auto-gated) plan
      // convergence auto-approves PLAN_REVIEW into VALIDATION, run the active
      // checks in-flow. Executed AFTER the transaction releases the session
      // write lock — the run-check path executes subprocesses outside the lock
      // and must acquire it only to persist evidence. A blocked plan call (e.g.
      // COMMAND_NOT_ALLOWED at an existing VALIDATION) did not enter the phase
      // and must not trigger the runner. The plan response is superseded only
      // when checks actually ran.
      const autoValidationResponse = responseReportsError(response)
        ? null
        : await runActiveChecksAutomatically(context);
      return autoValidationResponse ?? response;
    } catch (err) {
      return formatError(err);
    }
  },
};
