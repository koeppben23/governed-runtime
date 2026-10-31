/** Native V2 budgeting: do not carry the V1 maxOutputTokens workaround forward. */
import type { ReviewerOutputCapErrorCode, ReviewerOutputCapFailure } from './review/types.js';
export type { ReviewerOutputCapErrorCode, ReviewerOutputCapFailure };

export class ReviewerOutputCapError extends Error {
  constructor(
    readonly code: ReviewerOutputCapErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ReviewerOutputCapError';
  }
}

/** Host budgeting remains untouched. Explicit overrides require their own V2 wire/headroom proof. */
export function validateNativeReviewerOutputLimit(
  configured: number | 'host',
  configReadError?: unknown,
): void {
  if (configReadError !== undefined) {
    throw new ReviewerOutputCapError(
      'REVIEWER_OUTPUT_CAP_CONFIG_UNREADABLE',
      `FlowGuard configuration is unreadable: ${configReadError instanceof Error ? configReadError.message : String(configReadError)}`,
    );
  }
  if (configured === 'host') return;
  if (!Number.isInteger(configured) || configured < 1) {
    throw new ReviewerOutputCapError(
      'REVIEWER_OUTPUT_CAP_CONFIG_INVALID',
      'Reviewer output limit must be host or a positive integer.',
    );
  }
  throw new ReviewerOutputCapError(
    'REVIEWER_OUTPUT_CAP_MODEL_LIMIT_UNKNOWN',
    'The explicit reviewer output override has no verified V2 native budgeting/headroom and final-wire proof. Use native host budgeting; no limit was rewritten.',
  );
}
