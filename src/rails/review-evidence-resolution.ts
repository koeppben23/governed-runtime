/**
 * @module review-evidence-resolution
 * @description Canonical review evidence resolution for the /review-decision
 * rail: binds approval certificates to the review-assurance chain (obligations
 * + invocations), never to `latestReview` correlation.
 *
 * Linkage contract (CE2 hardening): `obligation.invocationId` is the ONLY
 * canonical resolver key. The `obligationId` field on invocation evidence is
 * retained as diagnostic/provenance information only — it is never used as a
 * resolver key or rescue path. Evidence without canonical linkage resolves to
 * nothing, and the certificate authority must fail closed.
 */

import type { SessionState } from '../state/schema.js';
import type { ArchitectureReviewCompletion } from '../state/evidence-primitives.js';
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
  // Canonical linkage ONLY: `obligation.invocationId` is the single resolver
  // key. Obligations fulfilled by a writer that never recorded the invocation
  // id (pre-canonical states) resolve to nothing — no obligationId-scoped,
  // newest-first rescue fallback exists anymore.
  if (!obligation.invocationId) return null;
  const invocation = assurance.invocations.find(
    (i) => i.invocationId === obligation.invocationId && i.findingsHash.length > 0,
  );
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
 * A bound certificate must not contradict the captured reviewer verdict
 * (CE1 hardening):
 * - Evidence that explicitly rejected acceptance never co-signs a
 *   `current_review` certificate (`completion_contradiction`).
 * - An `accept` verdict on the last bound evidence contradicts
 *   `review_exhausted` (acceptance was NOT obtained) and likewise surfaces as
 *   `completion_contradiction`.
 * - Evidence WITHOUT a captured verdict is `verdict_missing` — never silently
 *   admissible. The verdict must be present and coherent; only the legacy
 *   `approve` vocabulary is normalized at hydration, never manufactured here.
 */
export type ArchitectureReviewEvidenceResolution =
  | { kind: 'bound'; binding: ArchitectureReviewBinding }
  | { kind: 'unavailable' }
  | { kind: 'verdict_missing' }
  | {
      kind: 'completion_contradiction';
      capturedVerdict: string;
      reviewCompletion: ArchitectureReviewCompletion;
    };

export function resolveArchitectureReviewEvidence(
  state: SessionState,
  architecture: NonNullable<SessionState['architecture']>,
): ArchitectureReviewEvidenceResolution {
  if (architecture.reviewCompletion === 'reviewer_accepted') {
    const exact = resolveBoundReviewEvidenceForSubject(state, 'architecture', architecture.digest);
    if (!exact) return { kind: 'unavailable' };
    if (exact.reviewerVerdict === undefined) return { kind: 'verdict_missing' };
    if (exact.reviewerVerdict !== 'accept') {
      return {
        kind: 'completion_contradiction',
        capturedVerdict: exact.reviewerVerdict,
        reviewCompletion: 'reviewer_accepted',
      };
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
    if (latest.reviewerVerdict === undefined) return { kind: 'verdict_missing' };
    if (latest.reviewerVerdict === 'accept') {
      return {
        kind: 'completion_contradiction',
        capturedVerdict: latest.reviewerVerdict,
        reviewCompletion: 'review_exhausted',
      };
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

/**
 * Plan review evidence resolved under the same canonical-only, exact-subject
 * contract as the architecture path (CE4 hardening): ONLY obligations whose
 * `subjectDigest` equals the plan subject being approved bind; the
 * `subjectMatched ?? latest` cross-subject fallback is gone. The caller's gate
 * enforces verdict presence and coherence; the resolver is a pure read.
 */
export interface ResolvedPlanReviewEvidence {
  readonly obligationId: string;
  readonly invocationId: string;
  readonly findingsHash: string;
  readonly subjectDigest: string;
  readonly reviewerVerdict?: string;
}

export function resolvePlanReviewEvidence(
  state: SessionState,
  planSubjectDigest: string,
): ResolvedPlanReviewEvidence | null {
  const assurance = state.reviewAssurance;
  if (!assurance) return null;
  const candidates = assurance.obligations
    .filter(
      (o) =>
        o.obligationType === 'plan' &&
        (o.status === 'fulfilled' || o.status === 'consumed') &&
        o.subjectDigest === planSubjectDigest,
    )
    .sort(latestBoundFirst);
  for (const obligation of candidates) {
    if (!obligation.invocationId) continue;
    const invocation = assurance.invocations.find(
      (i) => i.invocationId === obligation.invocationId && i.findingsHash.length > 0,
    );
    if (!invocation) continue;
    return {
      obligationId: obligation.obligationId,
      invocationId: invocation.invocationId,
      findingsHash: invocation.findingsHash,
      subjectDigest: obligation.subjectDigest,
      ...(invocation.capturedVerdict ? { reviewerVerdict: invocation.capturedVerdict } : {}),
    };
  }
  return null;
}

/**
 * Latest bound plan review evidence regardless of subject. Intended ONLY for
 * the plan `review_exhausted_override` path, where the result's `subjectDigest`
 * documents what was actually reviewed. Unlike the architecture override, the
 * plan gate requires `reviewedSubjectDigest === approvedSubjectDigest` — the
 * caller enforces that divergence is never releasable.
 */
export function resolveLatestPlanReviewEvidence(
  state: SessionState,
): ResolvedPlanReviewEvidence | null {
  const assurance = state.reviewAssurance;
  if (!assurance) return null;
  const candidates = assurance.obligations
    .filter(
      (o) => o.obligationType === 'plan' && (o.status === 'fulfilled' || o.status === 'consumed'),
    )
    .sort(latestBoundFirst);
  for (const obligation of candidates) {
    if (!obligation.invocationId) continue;
    const invocation = assurance.invocations.find(
      (i) => i.invocationId === obligation.invocationId && i.findingsHash.length > 0,
    );
    if (!invocation) continue;
    return {
      obligationId: obligation.obligationId,
      invocationId: invocation.invocationId,
      findingsHash: invocation.findingsHash,
      subjectDigest: obligation.subjectDigest,
      ...(invocation.capturedVerdict ? { reviewerVerdict: invocation.capturedVerdict } : {}),
    };
  }
  return null;
}
