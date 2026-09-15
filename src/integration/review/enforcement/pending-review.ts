import type { PendingReview, PendingReviewTool } from './types.js';

/** Host identifiers published by the tool that emitted a review signal. */
export type ReviewSignalBinding = {
  readonly attemptId?: string | null;
  readonly obligationId?: string | null;
};

/** Build the host-owned pending-review record from one canonical review signal. */
export function buildPendingReview(
  reviewTool: PendingReviewTool,
  now: string,
  binding: ReviewSignalBinding,
): PendingReview {
  return {
    tool: reviewTool,
    requestedAt: now,
    attemptId: binding.attemptId ?? null,
    obligationId: binding.obligationId ?? null,
  };
}
