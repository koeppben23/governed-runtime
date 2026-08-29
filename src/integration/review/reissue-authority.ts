/**
 * @module integration/review/reissue-authority
 * @description Transition authorities for minting NEW attempts on an existing
 *              obligation.
 *
 * The canonical output-repair authority now lives in
 * `src/state/review-continuation.js` (re-exported here for the historical
 * import surface). This module retains the reviewer Task lifecycle re-arm
 * authority, which stays in the integration layer because its budget is the
 * enforcement retry gate at Task dispatch time.
 *
 * @version v1
 */

import type {
  ReviewAssuranceState,
  ReviewAttempt,
  ReviewAttemptOrigin,
  ReviewObligation,
} from '../../state/evidence.js';

export {
  authorizeOutputRepairReissue,
  countOutputRepairAttempts,
  latestAttemptForObligation,
  type OutputRepairAuthorization,
  type ReissueBlockCode,
} from '../../state/review-continuation.js';

export type TaskRearmAuthorization =
  | {
      readonly kind: 'authorized';
      readonly obligation: ReviewObligation;
      readonly origin: Extract<ReviewAttemptOrigin, { readonly kind: 'task_rearm' }>;
    }
  | { readonly kind: 'blocked'; readonly reason: string };

/**
 * Decide whether a spent/interrupted attempt may be re-armed by the reviewer
 * Task lifecycle. The settled-obligation guard lives here so the re-arm path
 * cannot mint attempts on fulfilled, consumed, or blocked obligations.
 *
 * The re-arm budget is the existing enforcement retry gate (Task dispatch),
 * deliberately NOT the output-repair budget.
 */
export function authorizeTaskLifecycleRearm(
  assurance: ReviewAssuranceState,
  spent: ReviewAttempt,
): TaskRearmAuthorization {
  const obligation = assurance.obligations.find((o) => o.obligationId === spent.obligationId);
  if (!obligation) {
    return { kind: 'blocked', reason: 'rearm_obligation_not_found' };
  }
  if (
    obligation.status === 'fulfilled' ||
    obligation.status === 'consumed' ||
    obligation.status === 'blocked'
  ) {
    return { kind: 'blocked', reason: 'rearm_obligation_settled' };
  }
  const triggerReason =
    spent.status === 'created'
      ? 'interrupted'
      : spent.status === 'rejected'
        ? 'rejected'
        : spent.status === 'stale'
          ? 'stale'
          : 'expired';
  return {
    kind: 'authorized',
    obligation,
    origin: {
      kind: 'task_rearm',
      predecessorAttemptId: spent.attemptId,
      triggerReason,
    },
  };
}
