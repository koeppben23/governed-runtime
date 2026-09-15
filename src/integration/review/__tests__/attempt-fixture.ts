/**
 * @module integration/review/__tests__/attempt-fixture
 * @description Test-only factory for a minimal bindable review attempt.
 *
 * The host-observed SDK path requires a pre-authorized attempt (`created`,
 * unbound, non-repository-governed) before it may write a durable dispatch
 * authorization or bind reviewer evidence.
 */

import type { ReviewAttempt } from '../../../state/evidence-review.js';

export const ATTEMPT_FIXTURE_TIME = '2026-01-01T00:00:00.000Z';

export function makePendingReviewAttempt(input: {
  readonly attemptId: string;
  readonly obligationId: string;
  readonly obligationType: ReviewAttempt['obligationType'];
  readonly subjectDigest: string;
  readonly createdAt?: string;
}): ReviewAttempt {
  return {
    attemptId: input.attemptId,
    obligationId: input.obligationId,
    obligationType: input.obligationType,
    subjectDigest: input.subjectDigest,
    ordinal: 0,
    status: 'created',
    origin: { kind: 'initial' },
    repositoryDiscovery: { kind: 'not_applicable' },
    observations: [],
    createdAt: input.createdAt ?? ATTEMPT_FIXTURE_TIME,
  };
}
