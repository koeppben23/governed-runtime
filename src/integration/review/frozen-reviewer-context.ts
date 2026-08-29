/**
 * @module integration/review/frozen-reviewer-context
 * @description Re-export barrel preserving the historical import surface for
 *              frozen-material integrity verification. The canonical authority
 *              lives in `src/state/review-continuation.js` so the machine layer
 *              can consume the same verification without importing this layer.
 */

import type { ReviewSubjectScope } from '../../state/evidence.js';

export {
  type FrozenArtifactMaterialVerification,
  type FrozenMaterialVerificationResult,
  type FrozenReviewerContext,
  type FrozenReviewerContextResult,
  type ReviewAnchorContract,
  verifyFrozenArtifactMaterial,
  verifyFrozenMaterialForObligation,
  verifyFrozenReviewerContext,
} from '../../state/review-continuation.js';

/** Material envelope contract — the review material follows this marker verbatim. */
export const FROZEN_REVIEW_MATERIAL_CONTRACT =
  'The exact persisted review material begins immediately after the canonical anchor. ' +
  'Do not append, replace, or supplement it.';

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
