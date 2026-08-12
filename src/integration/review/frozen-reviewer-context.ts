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

/** Material envelope contract — the review material follows this marker verbatim. */
export const FROZEN_REVIEW_MATERIAL_CONTRACT =
  'The exact persisted review material begins immediately after the canonical anchor. ' +
  'Do not append, replace, or supplement it.';

/**
 * Typed anchor contract describing the finding-relation contract that the
 * reviewer must follow for this reviewed-subject kind.
 */
export type ReviewAnchorContract =
  | {
      readonly kind: 'repository_change';
      readonly allowedSubjectAnchorKinds: readonly string[];
      readonly allowedRevisionAliases: readonly string[];
      readonly contractText: string;
    }
  | {
      readonly kind: 'content';
      readonly requiredSubjectDigest: string;
      readonly contractText: string;
    };

function buildAnchorContract(subject: FrozenReviewSubject): ReviewAnchorContract {
  if (subject.kind === 'repository_change') {
    return {
      kind: 'repository_change',
      allowedSubjectAnchorKinds: ['repository_location'],
      allowedRevisionAliases: ['base', 'head'],
      contractText:
        'Repository review: subjectAnchors must use kind=repository_location with ' +
        'paths inside the reviewed file set. revision is "base" or "head" — never a SHA. ' +
        'evidenceLocations may reference any repository file and MAY be empty.',
    };
  }
  return {
    kind: 'content',
    requiredSubjectDigest: subject.subjectDigest,
    contractText:
      'Content review: subjectAnchors must use kind=content with the exact ' +
      'frozen subjectDigest. evidenceLocations MAY be empty.',
  };
}

export interface FrozenReviewerContext {
  readonly reviewMaterial: ReviewMaterial;
  readonly reviewSubject: FrozenReviewSubject;
  readonly reviewSubjectScope: ReviewSubjectScope;
  readonly anchorContract: ReviewAnchorContract;
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
      anchorContract: buildAnchorContract(obligation.reviewSubject),
    },
  };
}
