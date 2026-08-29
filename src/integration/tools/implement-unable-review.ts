/**
 * @module integration/tools/implement-unable-review
 * @description Fail-closed persistence and retry preparation for a bound
 *              implementation-review unable_to_review verdict.
 */

import type { SessionState } from '../../state/schema.js';
import type { ImplementRuntime } from './implement-shared.js';
import type { ReviewAttempt, ReviewObligation } from '../../state/evidence.js';
import { appendNextAction, formatBlocked, writeStateWithArtifacts } from './helpers.js';

export async function handleUnableToReview(input: {
  runtime: ImplementRuntime;
  reviewedState: SessionState;
  obligationId: string;
  retryObligation: ReviewObligation;
  retryAttempt: ReviewAttempt;
}): Promise<string> {
  const assurance = input.reviewedState.reviewAssurance!;
  const finalState: SessionState = {
    ...input.reviewedState,
    reviewAssurance: {
      ...assurance,
      obligations: [...assurance.obligations, input.retryObligation],
      attempts: [...assurance.attempts, input.retryAttempt],
    },
  };
  await writeStateWithArtifacts(input.runtime.sessDir, finalState);
  return appendNextAction(
    formatBlocked('SUBAGENT_UNABLE_TO_REVIEW', {
      obligationId: input.obligationId,
      retryObligationId: input.retryObligation.obligationId,
      retryAttemptId: input.retryAttempt.attemptId,
    }),
    finalState,
  );
}
