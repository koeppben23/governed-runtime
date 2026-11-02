/**
 * @module integration/review/orchestration-mode
 * @description Host-neutral reviewer orchestration mode projection.
 *
 * This module does not approve, block, mutate state, bind evidence, or consume
 * obligations. Host adapters report semantic capabilities; the review owner only
 * projects the instruction mode. No host name or environment lookup participates.
 */

export type ReviewOrchestrationMode =
  | 'host_structured'
  | 'external_instruction_pending'
  | 'unsupported_blocked';

export interface ReviewOrchestrationModeInput {
  readonly nativeStructuredReview: boolean;
  readonly externalInstructionTransport?: boolean;
}

export function resolveReviewOrchestrationMode(
  input: ReviewOrchestrationModeInput,
): ReviewOrchestrationMode {
  if (input.nativeStructuredReview) return 'host_structured';
  if (input.externalInstructionTransport === true) return 'external_instruction_pending';
  return 'unsupported_blocked';
}
