/**
 * @module integration/review/review-continuation
 * @description Flow-neutral resolution of the next legal step for a review
 *              obligation type.
 *
 * `/plan`, `/architecture`, and `/review` share one lifecycle authority: a
 * re-invocation of the originating command must route on the DURABLE
 * obligation/attempt state, never on transient host state.
 *
 *   awaiting_task  — a bindable attempt exists; re-emit the review instruction
 *                    for it. No new attempt, no new obligation.
 *   output_repair  — the latest attempt is rejected with a canonically
 *                    repairable output-contract reason and the frozen repair
 *                    budget remains; the originating command re-invocation is
 *                    the authorized trigger to mint a fresh attempt on the
 *                    SAME obligation.
 *   awaiting_verdict — valid evidence is bound and awaits verdict submission.
 *   blocked        — the obligation was deterministically blocked (no legal
 *                    continuation). Recovery is flow-specific: a fresh
 *                    orchestration may replace it (same artifact revision,
 *                    new obligation) — never a repair of the old obligation.
 *   none           — no obligation of this type exists, or the latest one is
 *                    consumed.
 *
 * @version v1
 */

import type {
  ReviewAssuranceState,
  ReviewObligation,
  ReviewObligationType,
} from '../../state/evidence.js';
import { ensureReviewAssurance, findBindableAttempt } from './assurance.js';
import {
  authorizeOutputRepairReissue,
  type OutputRepairAuthorization,
} from './reissue-authority.js';

export type ReviewContinuation =
  | {
      readonly kind: 'awaiting_task';
      readonly obligation: ReviewObligation;
      readonly attemptId: string;
    }
  | {
      readonly kind: 'output_repair';
      readonly obligation: ReviewObligation;
      readonly authorization: Extract<OutputRepairAuthorization, { readonly kind: 'authorized' }>;
    }
  | {
      readonly kind: 'integrity_blocked';
      readonly obligation: ReviewObligation;
      readonly code: string;
      readonly reason: string;
    }
  | { readonly kind: 'awaiting_verdict'; readonly obligation: ReviewObligation }
  | { readonly kind: 'blocked'; readonly obligation: ReviewObligation }
  | { readonly kind: 'none' };

function latestObligationOfType(
  obligations: readonly ReviewObligation[],
  obligationType: ReviewObligationType,
): ReviewObligation | undefined {
  return [...obligations].reverse().find((o) => o.obligationType === obligationType);
}

/**
 * Resolve the next legal step for the latest obligation of the given type.
 * Pure: reads only the durable assurance state.
 */
export function resolveReviewContinuation(
  reviewAssurance: ReviewAssuranceState | undefined,
  obligationType: ReviewObligationType,
): ReviewContinuation {
  const assurance = ensureReviewAssurance(reviewAssurance);
  const obligation = latestObligationOfType(assurance.obligations, obligationType);
  if (!obligation) return { kind: 'none' };

  if (obligation.status === 'blocked') return { kind: 'blocked', obligation };
  if (obligation.status === 'fulfilled') return { kind: 'awaiting_verdict', obligation };
  if (obligation.status !== 'pending') return { kind: 'none' };

  const bindable = findBindableAttempt(assurance, obligation.obligationId);
  if (bindable) {
    return { kind: 'awaiting_task', obligation, attemptId: bindable.attemptId };
  }
  const authorization = authorizeOutputRepairReissue(assurance, obligation);
  if (authorization.kind === 'authorized') {
    return { kind: 'output_repair', obligation, authorization };
  }
  if (authorization.kind === 'integrity_blocked') {
    return {
      kind: 'integrity_blocked',
      obligation,
      code: authorization.code,
      reason: authorization.reason,
    };
  }
  return { kind: 'none' };
}
