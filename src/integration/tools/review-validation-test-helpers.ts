/**
 * Shared test fixtures for the review-validation host-task resolution family.
 * Import target only — never executed as a test suite.
 */

import { randomUUID } from 'node:crypto';
import type { ReviewAssuranceState } from '../../state/evidence-review.js';
import { hashText } from '../review/assurance.js';

/**
 * Canonical host-task dispatch fixture for a persisted attempt. Reuses the
 * attempt's existing active dispatch (an attempt can hold at most one) so a
 * re-recorded invocation stays coherent with the durable ledger; otherwise
 * mints a fresh completed dispatch whose host call id and canonical prompt
 * digest belong to the invocation being recorded.
 */
export function hostTaskDispatchPlan(input: {
  readonly isHostTask: boolean;
  readonly dispatches: ReviewAssuranceState['dispatches'];
  readonly attemptId: string;
  readonly obligationId: string;
  readonly at: string;
}): {
  readonly hostTaskCallId: string | undefined;
  readonly canonicalPromptDigest: string | undefined;
  readonly dispatch: ReviewAssuranceState['dispatches'][number] | undefined;
} {
  if (!input.isHostTask) {
    return { hostTaskCallId: undefined, canonicalPromptDigest: undefined, dispatch: undefined };
  }
  const existing = input.dispatches.find(
    (record) => record.attemptId === input.attemptId && record.dispatchStatus !== 'outcome_unknown',
  );
  if (existing) {
    return {
      hostTaskCallId: existing.hostCallId,
      canonicalPromptDigest: existing.canonicalPromptDigest,
      dispatch: undefined,
    };
  }
  const hostTaskCallId = `call-${randomUUID()}`;
  const canonicalPromptDigest = hashText(`host-task:${input.obligationId}:${input.attemptId}`);
  return {
    hostTaskCallId,
    canonicalPromptDigest,
    dispatch: {
      dispatchId: randomUUID(),
      attemptId: input.attemptId,
      obligationId: input.obligationId,
      hostCallId: hostTaskCallId,
      canonicalPromptDigest,
      dispatchAuthorizedAt: input.at,
      dispatchStatus: 'completed',
      completedAt: input.at,
    },
  };
}
