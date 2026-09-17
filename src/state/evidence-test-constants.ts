/**
 * @module state/evidence-test-constants
 * @description Shared test constants for evidence-module tests.
 */

import type { ReviewDispatchRecord, ReviewInvocationEvidence } from './evidence-review.js';
import type { PlanEvidence, SelfReviewLoop } from './evidence-plan.js';
import type { ImplReviewResult } from './evidence-impl.js';
import type { ValidationExecutionObservation } from './evidence-validation.js';
import { computeRecordDigest } from './evidence-plan.js';
import { hashText } from '../shared/hashing.js';

export const FIXED_TIME = '2026-01-01T00:00:00.000Z';
export const FIXED_UUID = '00000000-0000-4000-8000-000000000001';

/**
 * Canonical execution-observation fixture for validation attempts: one
 * unchanged session-state continuity (observed digest === pre-commit digest).
 */
export const TEST_EXECUTION_OBSERVATION: ValidationExecutionObservation = Object.freeze({
  executionObservedStateDigest: hashText('test-execution-observed-state'),
  preCommitStateDigest: hashText('test-execution-observed-state'),
});

const PLAN_DIGEST = hashText('## Plan\n1. Fix auth\n2. Add tests');

/**
 * Canonical converged/pending plan and implementation review-loop fixtures.
 * They live here (and are re-exported by `fixtures.ts`) so the shared fixture
 * base stays within the production file-size budget.
 */
export const SELF_REVIEW_CONVERGED: SelfReviewLoop = {
  iteration: 1,
  reviewCycle: 1,
  maxIterations: 3,
  prevDigest: null,
  currDigest: PLAN_DIGEST,
  revisionDelta: 'none',
  verdict: 'accept',
};

export const SELF_REVIEW_PENDING: SelfReviewLoop = {
  iteration: 1,
  reviewCycle: 1,
  maxIterations: 3,
  prevDigest: null,
  currDigest: PLAN_DIGEST,
  revisionDelta: 'minor',
  verdict: 'changes_requested',
};

export const IMPL_REVIEW_CONVERGED: ImplReviewResult = {
  iteration: 1,
  reviewCycle: 1,
  maxIterations: 3,
  prevDigest: null,
  currDigest: 'digest-of-impl',
  revisionDelta: 'none',
  verdict: 'accept',
  executedAt: FIXED_TIME,
};

export const IMPL_REVIEW_PENDING_RESULT: ImplReviewResult = {
  iteration: 1,
  reviewCycle: 1,
  maxIterations: 3,
  prevDigest: null,
  currDigest: 'digest-of-impl',
  revisionDelta: 'minor',
  verdict: 'changes_requested',
  executedAt: FIXED_TIME,
};

export interface PlanRevisionInput {
  readonly body: string;
  readonly createdAt?: string;
  readonly revisionId?: string;
  readonly planVersion?: number;
  readonly supersedesRecordDigest?: string | null;
  readonly originatingReviewObligationId?: string | null;
  readonly revisionReason?: string | null;
}

/**
 * Build a lineage-coherent plan revision (`digest = hashText(body)` and
 * `recordDigest = computeRecordDigest(...)`) so fixtures satisfy the PlanRecord
 * state refinement.
 */
export function makePlanRevision(input: PlanRevisionInput): PlanEvidence {
  const body = input.body;
  const digest = hashText(body);
  const planVersion = input.planVersion ?? 1;
  const supersedesRecordDigest = input.supersedesRecordDigest ?? null;
  const originatingReviewObligationId = input.originatingReviewObligationId ?? null;
  const revisionReason = input.revisionReason ?? null;
  const revisionId = input.revisionId ?? FIXED_UUID;
  return {
    body,
    digest,
    sections: [],
    createdAt: input.createdAt ?? FIXED_TIME,
    revisionId,
    recordDigest: computeRecordDigest({
      contentDigest: digest,
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
    lineageStatus: 'verified',
  };
}

/** Chain a new coherent revision onto a predecessor (next planVersion + record digest). */
export function makePlanRevisionAfter(
  predecessor: PlanEvidence,
  input: Omit<PlanRevisionInput, 'planVersion' | 'supersedesRecordDigest'>,
): PlanEvidence {
  return makePlanRevision({
    ...input,
    planVersion: predecessor.planVersion + 1,
    supersedesRecordDigest: predecessor.recordDigest,
  });
}

/**
 * Canonical completed durable-dispatch record for an invocation fixture: the
 * `authorized` dispatch that the invocation's host release closes. The default
 * `dispatchId` is the invocation's attempt id, which is unique per invocation
 * within one assurance state.
 */
export function completedDispatchForInvocation(
  invocation: Pick<
    ReviewInvocationEvidence,
    'attemptId' | 'obligationId' | 'childSessionId' | 'promptHash' | 'invokedAt' | 'fulfilledAt'
  >,
  overrides: Partial<Pick<ReviewDispatchRecord, 'dispatchId' | 'completedAt'>> = {},
): ReviewDispatchRecord {
  return {
    dispatchId: overrides.dispatchId ?? invocation.attemptId,
    attemptId: invocation.attemptId,
    obligationId: invocation.obligationId,
    hostCallId: invocation.childSessionId,
    canonicalPromptDigest: invocation.promptHash,
    dispatchAuthorizedAt: invocation.invokedAt,
    dispatchStatus: 'completed',
    completedAt: overrides.completedAt ?? invocation.fulfilledAt ?? invocation.invokedAt,
  };
}
