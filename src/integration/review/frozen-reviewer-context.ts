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
        'evidenceLocations MAY reference repository locations within the frozen ' +
        'repository authority of this review and MAY be empty. A cited location does ' +
        'not itself establish observation: it is admissible only when its frozen ' +
        'bytes were obtained through flowguard_observe_repository during this attempt.',
    };
  }
  return {
    kind: 'content',
    requiredSubjectDigest: subject.subjectDigest,
    contractText:
      'Content review: subjectAnchors must use kind=content with the exact ' +
      'frozen subjectDigest. evidenceLocations MUST be empty — content subjects ' +
      'carry no frozen repository authority, so repository evidence is unavailable.',
  };
}

export interface FrozenReviewerContext {
  readonly reviewMaterial: ReviewMaterial;
  readonly reviewSubject?: FrozenReviewSubject;
  readonly reviewSubjectScope?: ReviewSubjectScope;
  readonly anchorContract?: ReviewAnchorContract;
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
  if (!obligation) {
    return {
      kind: 'blocked',
      code: 'REVIEW_MATERIAL_INTEGRITY_FAILED',
      reason: 'review obligation is missing',
    };
  }
  if (!reviewMaterial) {
    return {
      kind: 'blocked',
      code: 'REVIEW_MATERIAL_INTEGRITY_FAILED',
      reason:
        'this obligation predates frozen review material and cannot be safely reconstructed from mutable state',
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
  if (obligation.reviewSubject && actualDigest !== obligation.reviewSubject.materialDigest) {
    return {
      kind: 'blocked',
      code: 'REVIEW_MATERIAL_INTEGRITY_FAILED',
      reason: 'persisted material digest does not match the frozen review subject',
    };
  }
  if (
    obligation.reviewSubject &&
    obligation.subjectDigest !== obligation.reviewSubject.subjectDigest
  ) {
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
      ...(obligation.reviewSubject
        ? {
            reviewSubject: obligation.reviewSubject,
            reviewSubjectScope: obligation.reviewSubjectScope,
            anchorContract: buildAnchorContract(obligation.reviewSubject),
          }
        : {}),
    },
  };
}

export type FrozenArtifactMaterialVerification =
  | { readonly kind: 'ok' }
  | {
      readonly kind: 'blocked';
      readonly code: 'REVIEW_MATERIAL_INTEGRITY_FAILED';
      readonly reason: string;
    };

/**
 * The exact anchor contract the host binder enforces for an artifact-scoped
 * obligation (plan/ADR), rendered into the reviewer prompt: subjectAnchors
 * MUST be artifact_section with the exact artifactKind and artifactDigest,
 * sectionPath MUST be one of the frozen paths, and repository locations are
 * evidenceLocations only.
 */
export function renderArtifactAnchorContract(
  scope: Extract<ReviewSubjectScope, { readonly kind: 'artifact' }>,
): string[] {
  const { kind, digest, sectionPaths } = scope.artifact;
  return [
    '## Frozen Artifact Anchor Contract (host-enforced)',
    `The review subject is a ${kind} artifact. The host binder enforces this exact contract:`,
    '- subjectAnchors MUST use kind "artifact_section"',
    `- artifactKind MUST be "${kind}"`,
    `- artifactDigest MUST be "${digest}"`,
    '- sectionPath MUST be one of the exact frozen section paths below:',
    JSON.stringify(sectionPaths),
    '- Repository paths are evidenceLocations only — never subjectAnchors.',
  ];
}

/**
 * Verify the frozen material binding of an artifact-scoped obligation
 * (plan/ADR). Artifact obligations have no standalone review subject; their
 * frozen material generation AND their artifact subject scope must both bind
 * to the exact artifact subject digest, so the subject identity chain is
 * transitively closed:
 *
 *   material.subjectDigest
 *   == obligation.subjectDigest
 *   == reviewSubjectScope.artifact.digest
 */
export function verifyFrozenArtifactMaterial(
  obligation: ReviewObligation,
  reviewMaterial: ReviewMaterial | null | undefined,
): FrozenArtifactMaterialVerification {
  const expectedArtifactKind =
    obligation.obligationType === 'plan'
      ? ('plan' as const)
      : obligation.obligationType === 'architecture'
        ? ('adr' as const)
        : null;
  const scope = obligation.reviewSubjectScope;
  if (
    !expectedArtifactKind ||
    scope?.kind !== 'artifact' ||
    scope.artifact.kind !== expectedArtifactKind ||
    scope.artifact.digest !== obligation.subjectDigest
  ) {
    return {
      kind: 'blocked',
      code: 'REVIEW_MATERIAL_INTEGRITY_FAILED',
      reason: 'frozen artifact scope does not match the obligation subject digest',
    };
  }
  if (!reviewMaterial) {
    return {
      kind: 'blocked',
      code: 'REVIEW_MATERIAL_INTEGRITY_FAILED',
      reason:
        'this obligation predates frozen review material and cannot be safely reconstructed from mutable state',
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
  if (reviewMaterial.subjectDigest !== obligation.subjectDigest) {
    return {
      kind: 'blocked',
      code: 'REVIEW_MATERIAL_INTEGRITY_FAILED',
      reason: 'frozen material generation does not match the artifact subject digest',
    };
  }
  return { kind: 'ok' };
}

export type FrozenMaterialVerificationResult =
  | { readonly kind: 'ok'; readonly context: FrozenReviewerContext | null }
  | {
      readonly kind: 'blocked';
      readonly code: 'REVIEW_MATERIAL_INTEGRITY_FAILED';
      readonly reason: string;
    };

/**
 * Single frozen-material verification authority. BOTH reviewer prompt
 * emission and output-repair reissue must route through this function so the
 * integrity policy never depends on which attempt is being served:
 *
 *   reviewSubjectScope.kind === 'artifact'
 *     → verifyFrozenArtifactMaterial (exact artifact→material digest binding)
 *   otherwise
 *     → verifyFrozenReviewerContext (standalone subject binding)
 */
export function verifyFrozenMaterialForObligation(
  obligation: ReviewObligation | null | undefined,
  reviewMaterial: ReviewMaterial | null | undefined,
): FrozenMaterialVerificationResult {
  if (!obligation) {
    return {
      kind: 'blocked',
      code: 'REVIEW_MATERIAL_INTEGRITY_FAILED',
      reason: 'review obligation is missing',
    };
  }
  if (obligation.reviewSubjectScope?.kind === 'artifact') {
    const artifact = verifyFrozenArtifactMaterial(obligation, reviewMaterial);
    return artifact.kind === 'ok' ? { kind: 'ok', context: null } : artifact;
  }
  const verified = verifyFrozenReviewerContext(obligation, reviewMaterial);
  return verified.kind === 'ok' ? { kind: 'ok', context: verified.context } : verified;
}
