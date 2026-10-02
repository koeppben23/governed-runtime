/**
 * @module shared/review-artifact-text
 * @description Canonical text identity for plan/ADR review artifacts at the
 * freeze and continuation-guard boundaries.
 *
 * This is intentionally NOT `normalizeReviewContent` (review-subject.ts):
 * - `normalizeReviewContent` canonicalizes review-material BYTES (CRLF/CR → LF)
 *   for content-addressed hashing of frozen review material.
 * - `normalizeReviewArtifactText` defines the IDENTITY of a plan/ADR artifact
 *   submitted by the host agent: surrounding whitespace never changes which
 *   artifact revision a submission refers to.
 *
 * Invariant: the freeze path and the changed-subject guard MUST digest the
 * same normalized text. A submission that differs only in leading/trailing
 * whitespace is the same artifact revision and must re-arm the frozen
 * obligation instead of reporting REVIEW_SUBJECT_CHANGED_WHILE_PENDING.
 *
 * @version v1
 */

/** Artifact identity normalization used by every plan/ADR freeze and guard. */
export function normalizeReviewArtifactText(text: string): string {
  return text.trim();
}
