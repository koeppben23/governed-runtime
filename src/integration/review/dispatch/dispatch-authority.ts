/**
 * @module integration/review/dispatch-authority
 * @description Canonical construction authority for review dispatch projections.
 *
 * A response may only project `reviewDispatch.required` together with the exact
 * current review obligation AND its bindable reviewer attempt. This module is
 * the single resolver allowed to produce that pair; it proves the complete
 * invariant before any producer may emit a dispatch:
 *
 *   obligation pending + current generation
 *   attempt bindable (created, unbound, exact obligation and subject digest)
 *   attempt not already released to the host
 *
 * The response-field projection and the child-session instruction both require
 * this authority, so an obligation without its attempt is not constructible.
 */

import type {
  ReviewAssuranceState,
  ReviewAttempt,
  ReviewObligation,
} from '../../../state/evidence.js';
import { hasReleasedDispatch } from '../../../state/review-dispatch.js';
import { ensureReviewAssurance } from '../../../state/review-dispatch.js';
import { findBindableAttempt } from '../../../state/review-continuation.js';
import { isCurrentReviewGeneration } from '../obligations/assurance.js';

/** The exact obligation/attempt pair a review dispatch may be bound to. */
export interface ReviewDispatchAuthority {
  readonly obligation: ReviewObligation;
  readonly attempt: ReviewAttempt;
}

export type ReviewDispatchAuthorityResult =
  | { readonly kind: 'ok'; readonly authority: ReviewDispatchAuthority }
  | {
      readonly kind: 'blocked';
      readonly code: 'REVIEW_ATTEMPT_UNAVAILABLE';
      readonly reason: string;
    };

/**
 * Resolve the canonical dispatch authority for one obligation.
 *
 * Every failure is a hard block: a pending obligation without a safe, current,
 * unreleased bindable attempt is an inconsistent review authority, never a
 * reason to synthesize a fresh attempt or reuse a released one.
 */
export function resolveReviewDispatchAuthority(
  assurance: ReviewAssuranceState | undefined,
  obligationId: string,
): ReviewDispatchAuthorityResult {
  const base = ensureReviewAssurance(assurance);
  const obligation = base.obligations.find((item) => item.obligationId === obligationId);
  if (!obligation || obligation.status !== 'pending') {
    return blocked(`review obligation ${obligationId} is not pending`);
  }
  if (!isCurrentReviewGeneration(obligation)) {
    return blocked(`review obligation ${obligationId} is not the current review generation`);
  }
  const attempt = findBindableAttempt(base, obligationId);
  if (!attempt) {
    return blocked(`no bindable reviewer attempt exists for obligation ${obligationId}`);
  }
  if (
    attempt.obligationId !== obligation.obligationId ||
    attempt.status !== 'created' ||
    attempt.subjectDigest !== obligation.subjectDigest
  ) {
    return blocked(
      `reviewer attempt ${attempt.attemptId} is not the exact bindable attempt for obligation ${obligationId}`,
    );
  }
  if (hasReleasedDispatch(base, attempt.attemptId)) {
    return blocked(
      `reviewer attempt ${attempt.attemptId} was already released to the host; the dispatch must be re-armed before it can be projected again`,
    );
  }
  return { kind: 'ok', authority: { obligation, attempt } };
}

function blocked(reason: string): ReviewDispatchAuthorityResult {
  return { kind: 'blocked', code: 'REVIEW_ATTEMPT_UNAVAILABLE', reason };
}

/**
 * Response fields for a dispatch-bearing FlowGuard response.
 *
 * Requires the full authority; there is deliberately no obligation-only or
 * attempt-id-only variant, because exactly that separation produced dispatch
 * responses the native Task could never bind to.
 */
export function reviewObligationResponseFields(
  authority: ReviewDispatchAuthority,
): Record<string, unknown> {
  const { obligation, attempt } = authority;
  return {
    reviewObligation: {
      obligationId: obligation.obligationId,
      obligationType: obligation.obligationType,
      iteration: obligation.iteration,
      planVersion: obligation.planVersion,
      criteriaVersion: obligation.criteriaVersion,
      mandateDigest: obligation.mandateDigest,
      requiredChallengeCount: obligation.requiredChallengeCount,
      requiredChallengeKind: obligation.requiredChallengeKind,
    },
    requiredChallengeCount: obligation.requiredChallengeCount,
    requiredChallengeKind: obligation.requiredChallengeKind,
    reviewAttemptId: attempt.attemptId,
  };
}
