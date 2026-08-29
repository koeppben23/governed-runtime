/**
 * @module integration/tools/implement-unable-review
 * @description Fail-closed persistence and retry preparation for a bound
 *              implementation-review unable_to_review verdict.
 */

import type { SessionState } from '../../state/schema.js';
import {
  activateImplementationReviewObligation,
  type ImplementRuntime,
} from './implement-shared.js';
import { appendNextAction, formatBlocked, writeStateWithArtifacts } from './helpers.js';

export async function handleUnableToReview(input: {
  runtime: ImplementRuntime;
  reviewedState: SessionState;
  iteration: number;
  planVersion: number;
  obligationId: string;
}): Promise<string> {
  const reissued = await activateImplementationReviewObligation(input.reviewedState, {
    subagentEnabled: input.runtime.subagentEnabled,
    iteration: input.iteration + 1,
    planVersion: input.planVersion,
    now: input.runtime.ctx.now(),
    worktree: input.runtime.worktree,
  });

  if (reissued.blocked || !reissued.obligation || !reissued.attemptId) {
    // The received verdict is still durable audit evidence even when a fresh
    // reviewer context cannot be minted.
    await writeStateWithArtifacts(input.runtime.sessDir, input.reviewedState);
    return appendNextAction(
      formatBlocked('SUBAGENT_UNABLE_TO_REVIEW', {
        obligationId: input.obligationId,
        recovery: reissued.blocked?.reason ?? 'a fresh reviewer obligation could not be activated',
      }),
      input.reviewedState,
    );
  }

  await writeStateWithArtifacts(input.runtime.sessDir, reissued.state);
  return appendNextAction(
    formatBlocked('SUBAGENT_UNABLE_TO_REVIEW', {
      obligationId: input.obligationId,
      retryObligationId: reissued.obligation.obligationId,
      retryAttemptId: reissued.attemptId,
    }),
    reissued.state,
  );
}
