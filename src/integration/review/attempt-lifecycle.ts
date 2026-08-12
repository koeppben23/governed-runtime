/**
 * @module integration/review/attempt-lifecycle
 * @description Review ATTEMPT lifecycle: creation, reissue, resolution, and
 *              status transitions of the invocation envelopes a reviewer Task
 *              binds to, plus the assurance-state container primitives.
 *
 * Extracted from assurance.ts along the attempt-lifecycle boundary. This module
 * is the single authority for how an attempt becomes (or stops being) bindable;
 * assurance.ts re-exports it so consumers keep one import surface.
 *
 * @version v1
 */

import { randomUUID } from 'node:crypto';
import type {
  ReviewAssuranceState,
  ReviewAttempt,
  ReviewMaterial,
  ReviewObligation,
  ReviewObligationType,
} from '../../state/evidence.js';

export function emptyReviewAssurance(): ReviewAssuranceState {
  return { obligations: [], invocations: [], attempts: [] };
}

export function ensureReviewAssurance(
  assurance: ReviewAssuranceState | undefined,
): ReviewAssuranceState {
  return assurance ?? emptyReviewAssurance();
}

export function createReviewAttempt(input: {
  obligationId: string;
  obligationType: ReviewObligationType;
  subjectDigest: string;
  reviewMaterial?: ReviewMaterial;
  ordinal: number;
  childSessionId?: string;
  now: string;
}): ReviewAttempt {
  return {
    attemptId: randomUUID(),
    obligationId: input.obligationId,
    obligationType: input.obligationType,
    subjectDigest: input.subjectDigest,
    ...(input.reviewMaterial === undefined ? {} : { reviewMaterial: input.reviewMaterial }),
    ordinal: input.ordinal,
    childSessionId: input.childSessionId,
    status: 'created',
    createdAt: input.now,
  };
}

/**
 * Create a new attempt for an EXISTING obligation (retry / re-invocation).
 *
 * Unlike createObligationAndAttempt (which creates a new obligation), this
 * attaches a new attempt to an already-persisted obligation. Previous
 * non-bound attempts for this obligation are staled — so a late callback
 * from the previous reviewer invocation is hard-rejected.
 *
 * `childSessionId` is supplied only when the reviewer child session is already
 * known (late correlation of an in-flight Task). A reissue that precedes the
 * reviewer Task MUST omit it: `findBindableAttempt` only accepts attempts that
 * carry no child session yet, so a pre-correlated attempt would be created
 * unbindable and the host could never hand the reviewer a prompt again.
 *
 * @returns Updated assurance state plus the attempt that was appended.
 */
export function createAttemptForExistingObligation(
  assurance: ReviewAssuranceState | undefined,
  obligation: ReviewObligation,
  childSessionId: string | undefined,
  now: string,
): { assurance: ReviewAssuranceState; attempt: ReviewAttempt } {
  const base = ensureReviewAssurance(assurance);
  const ordinal =
    (base.attempts?.filter((a) => a.obligationId === obligation.obligationId).length ?? 0) + 1;
  const attempt = createReviewAttempt({
    obligationId: obligation.obligationId,
    obligationType: obligation.obligationType,
    subjectDigest: obligation.subjectDigest,
    reviewMaterial: latestReviewMaterial(base, obligation.obligationId),
    ordinal,
    ...(childSessionId === undefined ? {} : { childSessionId }),
    now,
  });
  const withAttempt = appendReviewAttempt(base, attempt);
  return {
    assurance: staleObligationAttempts(
      withAttempt,
      obligation.obligationId,
      attempt.attemptId,
      now,
    ),
    attempt,
  };
}

export function latestReviewMaterial(
  assurance: ReviewAssuranceState,
  obligationId: string,
): ReviewMaterial | undefined {
  for (let index = assurance.attempts.length - 1; index >= 0; index--) {
    const attempt = assurance.attempts[index];
    if (attempt?.obligationId === obligationId && attempt.reviewMaterial) {
      return attempt.reviewMaterial;
    }
  }
  return undefined;
}

export function appendReviewAttempt(
  assurance: ReviewAssuranceState,
  attempt: ReviewAttempt,
): ReviewAssuranceState {
  const base = ensureReviewAssurance(assurance);
  return { ...base, attempts: [...(base.attempts ?? []), attempt] };
}

export function resolveAttempt(
  assurance: ReviewAssuranceState | undefined,
  childSessionId: string,
): ReviewAttempt | null {
  const base = ensureReviewAssurance(assurance);
  return (
    base.attempts?.find(
      (a) => a.childSessionId === childSessionId && a.status !== 'stale' && a.status !== 'expired',
    ) ?? null
  );
}

/**
 * The attempt a host Task can still be bound to for `obligationId`.
 *
 * Bindable means: created but not yet correlated with a reviewer child session,
 * and not superseded (`appendObligationWithAttempt` stales earlier attempts, so
 * at most one attempt per obligation qualifies). Returns the highest ordinal if
 * that invariant is ever violated, and null when no attempt can accept a
 * binding — callers must not fall back to an arbitrary attempt.
 */
export function findBindableAttempt(
  assurance: ReviewAssuranceState | undefined,
  obligationId: string,
): ReviewAttempt | null {
  const base = ensureReviewAssurance(assurance);
  const candidates = (base.attempts ?? []).filter(
    (a) => a.obligationId === obligationId && a.status === 'created' && !a.childSessionId,
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((best, a) => (a.ordinal > best.ordinal ? a : best));
}

export function updateAttemptStatus(
  assurance: ReviewAssuranceState,
  attemptId: string,
  status: ReviewAttempt['status'],
  now: string,
  childSessionId?: string,
): ReviewAssuranceState {
  const base = ensureReviewAssurance(assurance);
  if (!base.attempts) return base;
  return {
    ...base,
    attempts: base.attempts.map((a) =>
      a.attemptId !== attemptId
        ? a
        : {
            ...a,
            status,
            completedAt: status !== 'created' ? now : a.completedAt,
            ...(childSessionId && !a.childSessionId ? { childSessionId } : {}),
          },
    ),
  };
}

export function staleObligationAttempts(
  assurance: ReviewAssuranceState,
  obligationId: string,
  exceptAttemptId: string,
  now: string,
): ReviewAssuranceState {
  const base = ensureReviewAssurance(assurance);
  if (!base.attempts) return base;
  return {
    ...base,
    attempts: base.attempts.map((a) =>
      a.obligationId === obligationId && a.attemptId !== exceptAttemptId && a.status !== 'bound'
        ? { ...a, status: 'stale' as const, completedAt: now }
        : a,
    ),
  };
}
