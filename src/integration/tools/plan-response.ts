/**
 * @module integration/tools/plan-response
 * @description Plan tool response builders and persistence functions.
 *
 * @version v1
 */

import type { SessionState } from '../../state/schema.js';
import type { ReviewFindings } from '../../state/evidence.js';
import type {
  PlanExecutionScope,
  PlanRevisionResult,
  PlanSubmissionResponseInput,
  ConvergedPlanReviewInput,
} from './plan-types.js';
import {
  formatEval,
  formatAutoAdvanceOverflow,
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
import { evaluate } from '../../machine/evaluate.js';
import { autoAdvance } from '../../rails/types.js';
import { getAdapterLogger } from '../../logging/adapter-logger.js';
import {
  reviewObligationResponseFields,
  createReviewObligation,
  findLatestObligation,
  appendReviewObligation,
  resolveFrozenReviewProfile,
} from '../review/assurance.js';
import { buildPendingReviewInstruction } from '../review/pending-instruction.js';
import {
  resolveRuntimeReviewPlatform,
  resolveReviewOrchestrationMode,
} from '../review/orchestration-mode.js';

/** Extract the first non-empty line of text, truncated to 120 characters. */
export function firstLine(text: string | undefined): string | undefined {
  if (text == null) return undefined;
  const line =
    text
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? '';
  return line.length > 120 ? line.slice(0, 117) + '...' : line;
}

export function buildPlanSubmissionResponse(
  input: PlanSubmissionResponseInput,
): Record<string, unknown> {
  const { scope, finalState, planEvidence, planVersion, reviewFindings, transitions } = input;
  const nextObligation = scope.reviewPolicy.subagentEnabled
    ? findLatestObligation(finalState.reviewAssurance?.obligations ?? [], 'plan', 0, planVersion)
    : null;
  const reviewInstruction = buildPlanReviewInstruction({
    scope,
    obligation: nextObligation,
    iteration: 0,
    planVersion,
    subjectLabel: 'full plan text and ticket text',
  });
  const response: Record<string, unknown> = {
    phase: finalState.phase,
    status: 'Plan submitted (v' + planVersion + ').',
    planDigest: planEvidence.digest,
    selfReviewIteration: 0,
    maxSelfReviewIterations: scope.maxSelfReviewIterations,
    reviewMode: scope.reviewPolicy.subagentEnabled ? 'subagent' : 'self',
    ...reviewObligationResponseFields(nextObligation),
    next: reviewInstruction.next,
    reviewInvocation: reviewInstruction.reviewInvocation,
    _audit: { transitions },
  };
  if (reviewFindings) response.latestReview = latestPlanReviewSummary(reviewFindings, planVersion);
  return response;
}

export function buildPlanReviewInstruction(input: {
  scope: PlanExecutionScope;
  obligation: ReturnType<typeof findLatestObligation>;
  iteration: number;
  planVersion: number;
  subjectLabel: string;
}) {
  const platform = resolveRuntimeReviewPlatform();
  const mode = resolveReviewOrchestrationMode({
    platform,
    reviewInvocationPolicy: input.scope.policy.reviewInvocationPolicy,
    nativeReviewerAvailable: platform === 'unknown' ? false : true,
    manualAttestedAllowed: input.scope.policy.reviewInvocationPolicy !== 'host_task_required',
  });
  return buildPendingReviewInstruction({
    mode,
    platform,
    reviewKind: 'plan',
    obligation: input.obligation,
    iteration: input.iteration,
    planVersion: input.planVersion,
    subjectLabel: input.subjectLabel,
  });
}

export function latestPlanReviewSummary(
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

export function convergedPlanResponse(input: ConvergedPlanReviewInput): Record<string, unknown> {
  const { scope, finalState, ev, transitions, revision, iteration, forcedConvergence } = input;
  return {
    phase: finalState.phase,
    status: forcedConvergence
      ? `Independent review reached the iteration limit (${iteration}/${scope.maxSelfReviewIterations}) without reviewer approval (last verdict: ${revision.verdict}). Workflow advanced to ${finalState.phase}.`
      : `Independent review converged at iteration ${iteration}. Workflow advanced to ${finalState.phase}.`,
    planDigest: revision.currentPlan.digest,
    selfReviewIteration: iteration,
    next: formatEval(ev),
    _audit: { transitions },
  };
}

export async function convergedPlanReviewCardResponse(
  input: ConvergedPlanReviewInput,
): Promise<Record<string, unknown>> {
  const { scope, finalState, ev, transitions, revision, iteration, forcedConvergence } = input;
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
    forcedConvergence,
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
    status: forcedConvergence
      ? `Independent review reached the iteration limit (${iteration}/${scope.maxSelfReviewIterations}) without reviewer approval (last verdict: ${revision.verdict}). Your decision is required.`
      : `Independent review converged at iteration ${iteration}. Plan ready for approval.`,
    planDigest: revision.currentPlan.digest,
    selfReviewIteration: iteration,
    reviewCard,
    next: formatEval(ev),
    _audit: { transitions },
  };
  if (artifactErr) response.artifactWarning = artifactErr;
  return response;
}

export async function persistConvergedPlanReview(input: ConvergedPlanReviewInput): Promise<string> {
  const { scope, finalState } = input;
  await writeStateWithArtifacts(scope.sessDir, finalState);
  if (finalState.phase !== 'PLAN_REVIEW') {
    return appendNextAction(JSON.stringify(convergedPlanResponse(input)), finalState);
  }

  const response = await convergedPlanReviewCardResponse(input);
  return appendNextAction(JSON.stringify(response), finalState);
}

export async function persistNonConvergedPlanReview(
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
        reviewProfile: resolveFrozenReviewProfile(finalState.policySnapshot),
        profileSource: 'policy_default',
        policySnapshot: finalState.policySnapshot,
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

export function nonConvergedPlanResponse(
  scope: PlanExecutionScope,
  finalState: SessionState,
  transitions: unknown,
  revision: PlanRevisionResult,
  nextObligation: Parameters<typeof reviewObligationResponseFields>[0],
): Record<string, unknown> {
  const nextPlanVersion = revision.history.length + 1;
  const reviewInstruction = buildPlanReviewInstruction({
    scope,
    obligation: nextObligation,
    iteration: scope.state.selfReview!.iteration + 1,
    planVersion: nextPlanVersion,
    subjectLabel: 'revised plan text and ticket text',
  });
  return {
    phase: finalState.phase,
    status: `Independent review iteration ${scope.state.selfReview!.iteration + 1}/${scope.maxSelfReviewIterations}. Verdict: ${revision.verdict}.`,
    planDigest: revision.currentPlan.digest,
    selfReviewIteration: scope.state.selfReview!.iteration + 1,
    revisionDelta: revision.revisionDelta,
    reviewMode: 'subagent',
    ...reviewObligationResponseFields(nextObligation),
    next: reviewInstruction.next,
    reviewInvocation: reviewInstruction.reviewInvocation,
    _audit: { transitions },
  };
}

export async function persistPlanReview(
  scope: PlanExecutionScope,
  revision: PlanRevisionResult,
  effectiveFindings: ReviewFindings | null,
  consumedAssurance: ReturnType<typeof import('../review/assurance.js').consumeReviewObligation>,
  buildReviewedPlanState: (
    scope: PlanExecutionScope,
    revision: PlanRevisionResult,
    effectiveFindings: ReviewFindings | null,
    consumedAssurance: ReturnType<typeof import('../review/assurance.js').consumeReviewObligation>,
  ) => SessionState,
): Promise<string> {
  const nextState = buildReviewedPlanState(scope, revision, effectiveFindings, consumedAssurance);
  const evalFn = (s: SessionState) => evaluate(s, scope.policy);
  const advanced = autoAdvance(nextState, evalFn, scope.ctx);
  // #428: fail closed on overflow BEFORE persisting — no partially-advanced write.
  if (advanced.kind === 'overflow') {
    return formatAutoAdvanceOverflow(advanced);
  }
  const { state: finalState, evalResult: ev, transitions } = advanced;
  const iteration = scope.state.selfReview!.iteration + 1;
  const approvedConverged = revision.revisionDelta === 'none' && revision.verdict === 'accept';
  const maxReached = iteration >= scope.maxSelfReviewIterations;

  // Force-convergence: the review loop exhausted its iteration budget without
  // an approving verdict. Parity with the implementation-review flow
  // (implement.ts handleApprovedReview): NEVER block here. Route through the
  // converged path so human-gated modes stop at PLAN_REVIEW for the human to
  // decide, and auto-approve modes continue with an honest, audit-visible
  // status. The previous hard block stranded the session at PLAN_REVIEW while
  // its recovery told the user to run /plan — which is inadmissible at that
  // phase — leaving the flow wedged.
  const forcedConvergence = maxReached && !approvedConverged;

  if (forcedConvergence) {
    getAdapterLogger().warn(
      'flowguard_plan',
      'Plan review force-converged at iteration limit without reviewer approval',
      {
        sessionId: scope.context.sessionID,
        iteration,
        maxIterations: scope.maxSelfReviewIterations,
        lastVerdict: revision.verdict,
        phase: finalState.phase,
        planDigest: revision.currentPlan.digest,
      },
    );
  }

  if (approvedConverged || forcedConvergence) {
    return persistConvergedPlanReview({
      scope,
      finalState,
      ev,
      transitions,
      revision,
      iteration,
      forcedConvergence,
    });
  }
  return persistNonConvergedPlanReview(scope, finalState, transitions, revision, iteration);
}
