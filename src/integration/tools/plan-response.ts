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
import { formatEval, formatBlocked, appendNextAction, writeStateWithArtifacts } from './helpers.js';
import {
  PHASE_LABELS,
  buildProductNextAction,
  buildPlanReviewCard,
} from '../../presentation/index.js';
import { materializeReviewCardArtifact } from '../../adapters/workspace/index.js';
import { resolveNextAction } from '../../machine/next-action.js';
import { evaluate } from '../../machine/evaluate.js';
import { autoAdvance } from '../../rails/types.js';
import {
  reviewObligationResponseFields,
  createReviewObligation,
  findLatestObligation,
  appendReviewObligation,
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

export async function convergedPlanReviewCardResponse(
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
