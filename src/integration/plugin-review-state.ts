/**
 * @module integration/plugin-review-state
 * @description Pure review state helpers extracted from plugin.ts.
 *
 * These helpers do not perform I/O. They return updated SessionState
 * values and are intended for use inside updateReviewAssurance callbacks.
 *
 * @version v1
 */

import type { SessionState } from '../state/schema.js';
import type { ReviewObligation } from '../state/evidence.js';
import { ensureReviewAssurance } from './review-assurance.js';

/**
 * Apply a transform to the review obligation with the given ID.
 *
 * This is the core pattern repeated 6 times in the orchestrator block:
 *  1. Get or create the review assurance
 *  2. Map over obligations, matching by obligationId
 *  3. Apply the transform to the matched obligation
 *  4. Return updated state
 *
 * @param state - Current session state
 * @param obligationId - The obligation ID to match
 * @param transform - Function to transform the matched obligation
 * @returns Updated session state with transformed review assurance
 */
export function updateObligation(
  state: SessionState,
  obligationId: string,
  transform: (item: ReviewObligation) => ReviewObligation,
): SessionState {
  const assurance = ensureReviewAssurance(state.reviewAssurance);
  return {
    ...state,
    reviewAssurance: {
      ...assurance,
      obligations: assurance.obligations.map((item) =>
        item.obligationId !== obligationId ? item : transform(item),
      ),
    },
  };
}

/**
 * Mark a review obligation as blocked with a specific reason code.
 *
 * Convenience wrapper around updateObligation for the common
 * blocked-obligation pattern used at 4 call sites.
 *
 * @param state - Current session state
 * @param obligationId - The obligation ID to block
 * @param blockedCode - Reason code for the block
 * @returns Updated session state
 */
export function blockObligation(
  state: SessionState,
  obligationId: string,
  blockedCode: string,
): SessionState {
  return updateObligation(state, obligationId, (item) => ({
    ...item,
    status: 'blocked',
    blockedCode,
  }));
}
