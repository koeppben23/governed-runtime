/**
 * @module integration/review/review-execution-projection
 * @description Read-only projection of durable reviewer invocation evidence.
 *
 * This is presentation/provenance only. The persisted ReviewInvocationEvidence
 * remains the single authority; no second review-execution state is stored.
 */

import type { SessionState } from '../../state/schema.js';
import type { ReviewInvocationEvidence } from '../../state/evidence-review-invocation.js';

export interface ReviewExecutionProjection {
  readonly reviewAttemptId: string;
  readonly obligationId: string;
  readonly agentType: string;
  readonly parentSessionId: string;
  readonly childSessionId: string;
  readonly host: 'opencode';
  readonly invocationMode: ReviewInvocationEvidence['invocationMode'];
  readonly visible: boolean;
  readonly transcriptNavigable: boolean;
  readonly structuredOutput: boolean;
  readonly invokedAt: string;
  readonly fulfilledAt: string | null;
}

export function projectReviewExecution(
  invocation: ReviewInvocationEvidence,
): ReviewExecutionProjection {
  return {
    reviewAttemptId: invocation.attemptId,
    obligationId: invocation.obligationId,
    agentType: invocation.agentType,
    parentSessionId: invocation.parentSessionId,
    childSessionId: invocation.childSessionId,
    host: 'opencode',
    invocationMode: invocation.invocationMode,
    visible: invocation.hostVisible,
    transcriptNavigable: invocation.transcriptNavigable === true,
    structuredOutput: invocation.structuredOutputUsed,
    invokedAt: invocation.invokedAt,
    fulfilledAt: invocation.fulfilledAt,
  };
}

/** Latest durable reviewer execution, if any. */
export function projectLatestReviewExecution(
  state: Pick<SessionState, 'reviewAssurance'>,
): ReviewExecutionProjection | undefined {
  const invocation = state.reviewAssurance?.invocations.at(-1);
  return invocation ? projectReviewExecution(invocation) : undefined;
}
