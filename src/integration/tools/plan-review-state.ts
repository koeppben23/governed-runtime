/**
 * @module integration/tools/plan-review-state
 * @description Plan reviewer-verdict resolution, revision application, and
 * reviewed plan session state construction.
 *
 * Extracted from `plan.ts` along the review-state boundary: resolving the
 * host-captured findings against the pending plan obligation, applying the
 * reviewer verdict to the plan record, and assembling the reviewed session
 * state (obligation consumption + review completion).
 *
 * @version v1
 */

import { IntegrationInvariantError } from '../errors.js';
import { formatBlocked } from '../blocked-result.js';

import type { SessionState } from '../../state/schema.js';
import type { LoopVerdict, RevisionDelta, ReviewFindings } from '../../state/evidence.js';
import { resolvePlanReviewCompletion } from '../../state/evidence-plan.js';
import { resolveStructuredEffectiveFindings } from '../review/review-validation.js';
import { collectPreviouslyUsedChallengeIds } from '../review/challenge-history.js';
import { buildReviewChallengeContract } from '../review/challenge-contract.js';
import {
  consumeReviewObligation,
  ensureReviewAssurance,
  findLatestObligation,
} from '../review/assurance.js';
import type { PlanArgs, PlanExecutionScope, PlanRevisionResult } from './plan-types.js';
import {
  appendClaimSubmissionHistory,
  buildPlanEvidence,
  currentClaimSubmissionDiagnostics,
  submittedPlanClaimDeclarations,
} from './plan-submission-state.js';

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

export function resolveEffectivePlanFindings(scope: PlanExecutionScope) {
  const selfReview = scope.state.selfReview;
  const plan = scope.state.plan;
  if (!selfReview || !plan) {
    throw new IntegrationInvariantError(
      'PLAN_REVIEW_STATE_REQUIRED',
      'plan review finding resolution requires plan and self-review state',
    );
  }
  const { assuranceBase, pendingObligation } = findUnconsumedPlanObligation(scope.state);
  const expectedIteration = pendingObligation?.iteration ?? selfReview.iteration;
  const expectedPlanVersion = pendingObligation?.planVersion ?? plan.history.length + 1;
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

export function blockedInvalidPlanFindings(
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

export function applyPlanRevision(
  scope: PlanExecutionScope,
  originatingReviewObligationId?: string | null,
): PlanRevisionResult | string {
  const state = scope.state;
  const plan = state.plan;
  if (!plan) {
    throw new IntegrationInvariantError('NO_PLAN', 'plan revision requires a plan in state');
  }
  const verdict = scope.args.reviewVerdict as LoopVerdict;
  const prevDigest = plan.current.digest;
  let currentPlan = plan.current;
  let history = [...plan.history];
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

export function buildReviewedPlanState(
  scope: PlanExecutionScope,
  revision: PlanRevisionResult,
  effectiveFindings: ReviewFindings,
  consumedAssurance: ReturnType<typeof consumeReviewObligation>,
): SessionState {
  const selfReview = scope.state.selfReview;
  if (!selfReview) {
    throw new IntegrationInvariantError(
      'NO_SELF_REVIEW',
      'plan review persistence requires a self-review loop in state',
    );
  }
  // Only host-captured effective findings are ever appended.
  const existingReviewFindings = scope.state.plan?.reviewFindings;
  const newReviewFindings = [...(existingReviewFindings ?? []), effectiveFindings];
  const nextIteration = selfReview.iteration + 1;

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

export function consumePlanObligation(
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
