/**
 * @module integration/review/frozen-reviewer-context
 * @description Integrity-checked context delivered to standalone-reviewers.
 */

import type {
  FrozenReviewSubject,
  ReviewMaterial,
  ReviewObligation,
  ReviewSubjectScope,
} from '../../state/evidence.js';
import { hashCanonicalReviewContent, normalizeReviewContent } from '../../shared/review-subject.js';

export const FROZEN_REVIEW_ANCHOR_CONTRACT =
  'Content anchor contract: the exact persisted review material begins immediately after the canonical anchor. Do not append, replace, or supplement it.';

export interface FrozenReviewerContext {
  readonly reviewMaterial: ReviewMaterial;
  readonly reviewSubject: FrozenReviewSubject;
  readonly reviewSubjectScope: ReviewSubjectScope;
  readonly anchorContract: typeof FROZEN_REVIEW_ANCHOR_CONTRACT;
}

export type FrozenReviewerContextResult =
  | { readonly kind: 'ok'; readonly context: FrozenReviewerContext }
  | {
      readonly kind: 'blocked';
      readonly code: 'REVIEW_MATERIAL_INTEGRITY_FAILED';
      readonly reason: string;
    };

/**
 * Verify the persisted bytes and all frozen digest bindings before reviewer prompt
 * injection. This is deliberately the sole constructor for standalone context.
 */
export function verifyFrozenReviewerContext(
  obligation: ReviewObligation | null | undefined,
  reviewMaterial: ReviewMaterial | null | undefined,
): FrozenReviewerContextResult {
  if (!obligation?.reviewSubject || !reviewMaterial) {
    return {
      kind: 'blocked',
      code: 'REVIEW_MATERIAL_INTEGRITY_FAILED',
      reason: 'frozen subject or persisted material is missing',
    };
  }
  if (reviewMaterial.content !== normalizeReviewContent(reviewMaterial.content)) {
    return {
      kind: 'blocked',
      code: 'REVIEW_MATERIAL_INTEGRITY_FAILED',
      reason: 'persisted material is not canonically normalized',
    };
  }
  const actualDigest = hashCanonicalReviewContent(reviewMaterial.content);
  if (actualDigest !== reviewMaterial.materialDigest) {
    return {
      kind: 'blocked',
      code: 'REVIEW_MATERIAL_INTEGRITY_FAILED',
      reason: 'persisted material digest does not match its canonical content',
    };
  }
  if (actualDigest !== obligation.reviewSubject.materialDigest) {
    return {
      kind: 'blocked',
      code: 'REVIEW_MATERIAL_INTEGRITY_FAILED',
      reason: 'persisted material digest does not match the frozen review subject',
    };
  }
  if (obligation.subjectDigest !== obligation.reviewSubject.subjectDigest) {
    return {
      kind: 'blocked',
      code: 'REVIEW_MATERIAL_INTEGRITY_FAILED',
      reason: 'obligation subject digest does not match the frozen review subject',
    };
  }
  return {
    kind: 'ok',
    context: {
      reviewMaterial,
      reviewSubject: obligation.reviewSubject,
      reviewSubjectScope: obligation.reviewSubjectScope,
      anchorContract: FROZEN_REVIEW_ANCHOR_CONTRACT,
    },
  };
}
