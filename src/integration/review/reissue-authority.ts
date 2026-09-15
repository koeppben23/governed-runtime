/**
 * @module integration/review/reissue-authority
 * @description Transition authority for minting NEW attempts on an existing
 *              obligation.
 *
 * The ONLY current producer of a non-initial attempt is the transport-neutral
 * dispatch-recovery re-arm: an attempt whose durable dispatch ledger already
 * records a host release is spent, and the originating command re-invokes the
 * flow to mint a fresh append-only attempt on the SAME obligation. The
 * authority stays in the integration layer because its budget is the
 * enforcement retry gate at dispatch time.
 *
 * @version v2
 */

import type {
  ReviewAssuranceState,
  ReviewAttempt,
  ReviewAttemptOrigin,
  ReviewObligation,
} from '../../state/evidence.js';
import { countReviewAttempts } from '../../state/review-continuation.js';

export type DispatchRearmAuthorization =
  | {
      readonly kind: 'authorized';
      readonly obligation: ReviewObligation;
      readonly origin: Extract<ReviewAttemptOrigin, { readonly kind: 'dispatch_rearm' }>;
    }
  | { readonly kind: 'blocked'; readonly reason: string };

type DispatchRearmTrigger = Extract<
  ReviewAttemptOrigin,
  { readonly kind: 'dispatch_rearm' }
>['triggerReason'];

/**
 * Derive the dispatch-recovery trigger from the spent attempt and its durable
 * release record:
 *
 *   created + an unresolved `authorized` dispatch → 'interrupted'
 *   created + only `outcome_unknown` releases     → 'spent'
 * A non-created attempt, an attempt without any durable release, or an
 * attempt with a completed dispatch has no legal re-arm trigger.
 */
function dispatchRearmTrigger(
  assurance: ReviewAssuranceState,
  spent: ReviewAttempt,
): DispatchRearmTrigger | null {
  if (spent.status !== 'created') return null;
  const dispatches = assurance.dispatches.filter((record) => record.attemptId === spent.attemptId);
  if (dispatches.some((record) => record.dispatchStatus === 'authorized')) return 'interrupted';
  if (dispatches.some((record) => record.dispatchStatus === 'outcome_unknown')) return 'spent';
  return null;
}

/**
 * Decide whether a spent/interrupted attempt may be re-armed by the
 * transport-neutral dispatch-recovery path. The settled-obligation guard lives
 * here so the re-arm path cannot mint attempts on fulfilled, consumed, or
 * blocked obligations.
 *
 * Every re-arm draws on the frozen per-obligation reviewer-attempt budget: an
 * obligation cannot mint unbounded reviewer attempts, regardless of how the
 * predecessor was spent.
 */
export function authorizeDispatchRearm(
  assurance: ReviewAssuranceState,
  spent: ReviewAttempt,
): DispatchRearmAuthorization {
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
  const rearms = countReviewAttempts(assurance, obligation.obligationId);
  if (rearms >= obligation.maxReviewerAttempts) {
    return {
      kind: 'blocked',
      reason: `reviewer re-arm budget exhausted (${rearms}/${obligation.maxReviewerAttempts})`,
    };
  }
  const triggerReason = dispatchRearmTrigger(assurance, spent);
  if (!triggerReason) {
    return {
      kind: 'blocked',
      reason: `reviewer attempt ${spent.attemptId} has no released dispatch to recover from`,
    };
  }
  return {
    kind: 'authorized',
    obligation,
    origin: {
      kind: 'dispatch_rearm',
      predecessorAttemptId: spent.attemptId,
      triggerReason,
    },
  };
}
