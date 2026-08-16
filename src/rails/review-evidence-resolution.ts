/**
 * @module review-evidence-resolution
 * @description Canonical architecture review evidence resolution for the
 * /review-decision rail: binds approval certificates to the review-assurance
 * chain (obligations + invocations), never to `latestReview` correlation.
 */

import type { SessionState } from '../state/schema.js';
import type { ReviewObligation } from '../state/evidence-review.js';
import type { ArchitectureReviewBinding } from '../state/proofgraph-approval.js';

/**
 * Evidence resolved from the canonical review-assurance chain (obligations +
 * invocations), never from `latestReview` correlation. `reviewerVerdict` is the
 * host-captured verdict (`invocation.capturedVerdict`) when present; its
 * absence means legacy evidence without a captured verdict.
 */
export interface ResolvedBoundReviewEvidence {
  readonly obligationId: string;
  readonly invocationId: string;
  readonly findingsHash: string;
  readonly subjectDigest: string;
  readonly reviewerVerdict?: string;
}

function latestBoundFirst(a: ReviewObligation, b: ReviewObligation): number {
  return b.iteration - a.iteration || b.createdAt.localeCompare(a.createdAt);
}

function evidenceForObligation(
  state: SessionState,
  obligation: ReviewObligation,
): ResolvedBoundReviewEvidence | null {
  const assurance = state.reviewAssurance;
  if (!assurance) return null;
  // Canonical linkage is `obligation.invocationId`; direct host-task captures
  // may leave it unset on the obligation while the invocation carries the
  // obligationId (plugin hooks set it in production, direct tool flows do
  // not). Resolve either way — never from `latestReview` correlation.
  const candidates = assurance.invocations
    .filter((i) => i.findingsHash.length > 0)
    .filter((i) =>
      obligation.invocationId
        ? i.invocationId === obligation.invocationId
        : i.obligationId === obligation.obligationId,
    )
    .sort((a, b) => b.invokedAt.localeCompare(a.invokedAt));
  // Prefer the invocation the obligation was consumed with; fall back to the
  // newest bound invocation (retries leave several bound invocations behind).
  const consumed = candidates.find((i) => i.consumedByObligationId === obligation.obligationId);
  const invocation = consumed ?? candidates[0];
  if (!invocation) return null;
  return {
    obligationId: obligation.obligationId,
    invocationId: invocation.invocationId,
    findingsHash: invocation.findingsHash,
    subjectDigest: obligation.subjectDigest,
    ...(invocation.capturedVerdict ? { reviewerVerdict: invocation.capturedVerdict } : {}),
  };
}

/**
 * Resolve bound review evidence for EXACTLY one subject digest. There is no
 * cross-digest fallback: evidence reviewed a different revision must never be
 * attributed to the requested subject.
 */
export function resolveBoundReviewEvidenceForSubject(
  state: SessionState,
  obligationType: 'architecture',
  subjectDigest: string,
): ResolvedBoundReviewEvidence | null {
  const assurance = state.reviewAssurance;
  if (!assurance) return null;
  const candidates = assurance.obligations
    .filter(
      (o) =>
        o.obligationType === obligationType &&
        (o.status === 'fulfilled' || o.status === 'consumed') &&
        o.subjectDigest === subjectDigest,
    )
    .sort(latestBoundFirst);
  for (const obligation of candidates) {
    const evidence = evidenceForObligation(state, obligation);
    if (evidence) return evidence;
  }
  return null;
}

/**
 * Resolve the latest bound review evidence of a type, regardless of subject.
 * Intended ONLY for the `review_exhausted_override` path, where the result's
 * `subjectDigest` documents what was actually reviewed — never the approved
 * subject.
 */
export function resolveLatestBoundReviewEvidence(
  state: SessionState,
  obligationType: 'architecture',
): ResolvedBoundReviewEvidence | null {
  const assurance = state.reviewAssurance;
  if (!assurance) return null;
  const candidates = assurance.obligations
    .filter(
      (o) =>
        o.obligationType === obligationType &&
        (o.status === 'fulfilled' || o.status === 'consumed'),
    )
    .sort(latestBoundFirst);
  for (const obligation of candidates) {
    const evidence = evidenceForObligation(state, obligation);
    if (evidence) return evidence;
  }
  return null;
}

/**
 * Resolution result for the architecture certificate binding, determined from
 * the gate path ONLY. `reviewer_accepted` requires exact-subject evidence
 * (`current_review`); `review_exhausted` mints an explicit override binding —
 * even when the last reviewed digest happens to equal the approved one. The
 * binding kind is never normalized afterwards from digest equality.
 *
 * A bound certificate must not contradict the captured reviewer verdict:
 * evidence that explicitly rejected acceptance never co-signs a
 * `current_review` certificate, and an `accept` verdict on the last bound
 * evidence contradicts `review_exhausted` (acceptance was NOT obtained).
 * Evidence without a captured verdict stays legacy-tolerant, because
 * `capturedVerdict` is optional at capture time (SDK attestations and older
 * evidence may not carry one).
 */
export type ArchitectureReviewEvidenceResolution =
  | { kind: 'bound'; binding: ArchitectureReviewBinding }
  | { kind: 'unavailable' }
  | { kind: 'exhaustion_contradiction'; capturedVerdict: string };

export function resolveArchitectureReviewEvidence(
  state: SessionState,
  architecture: NonNullable<SessionState['architecture']>,
): ArchitectureReviewEvidenceResolution {
  if (architecture.reviewCompletion === 'reviewer_accepted') {
    const exact = resolveBoundReviewEvidenceForSubject(state, 'architecture', architecture.digest);
    if (!exact || (exact.reviewerVerdict !== undefined && exact.reviewerVerdict !== 'accept')) {
      return { kind: 'unavailable' };
    }
    return {
      kind: 'bound',
      binding: {
        kind: 'current_review',
        reviewObligationId: exact.obligationId,
        reviewEvidenceDigest: exact.findingsHash,
        reviewedSubjectDigest: exact.subjectDigest,
      },
    };
  }
  if (architecture.reviewCompletion === 'review_exhausted') {
    const latest = resolveLatestBoundReviewEvidence(state, 'architecture');
    if (!latest) return { kind: 'unavailable' };
    if (latest.reviewerVerdict === 'accept') {
      return { kind: 'exhaustion_contradiction', capturedVerdict: latest.reviewerVerdict };
    }
    return {
      kind: 'bound',
      binding: {
        kind: 'review_exhausted_override',
        lastReviewObligationId: latest.obligationId,
        lastReviewEvidenceDigest: latest.findingsHash,
        reviewedSubjectDigest: latest.subjectDigest,
        approvedSubjectDigest: architecture.digest,
      },
    };
  }
  return { kind: 'unavailable' };
}
