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

import { randomBytes, randomUUID } from 'node:crypto';
import type {
  ReviewAssuranceState,
  ReviewAttempt,
  ReviewAttemptDiscoveryContext,
  ReviewAttemptOrigin,
  ReviewAttemptRejectionReason,
  ReviewMaterial,
  ReviewObligation,
  ReviewObligationType,
} from '../../state/evidence.js';
import { ensureReviewAssurance } from '../../state/review-continuation.js';
import { resolveObservationRevisions } from './observation-access.js';

export {
  emptyReviewAssurance,
  ensureReviewAssurance,
  findBindableAttempt,
  latestReviewMaterial,
} from '../../state/review-continuation.js';

/**
 * Mint an opaque, attempt-bound observation capability. Cryptographically
 * unguessable (256-bit). The reviewer echoes it as routing only; authority
 * always resolves host-side against the owning attempt.
 */
export function mintObservationCapability(): string {
  return `fgc_${randomBytes(32).toString('hex')}`;
}

/**
 * Mint an attempt-bound observation capability ONLY when the owning obligation
 * actually backs at least one frozen repository revision. This is the
 * authority-derived minting decision used by every attempt-creation wrapper:
 * no resolvable frozen revision means no capability, so the reviewer prompt
 * advertises no executable observation contract.
 */
export function mintObservationCapabilityIfResolvable(obligation: ReviewObligation): string | null {
  return resolveObservationRevisions(obligation).length > 0 ? mintObservationCapability() : null;
}

export function createReviewAttempt(input: {
  obligationId: string;
  obligationType: ReviewObligationType;
  subjectDigest: string;
  reviewMaterial?: ReviewMaterial;
  ordinal: number;
  childSessionId?: string;
  /**
   * Authority-derived observation permission. The attempt carries ONLY the
   * opaque capability derived from the owning obligation's frozen repository
   * authority — the frozen authority itself remains authoritative on the
   * obligation, never duplicated here. `null` when no frozen repository
   * revision is resolvable: the reviewer prompt then advertises no executable
   * observation contract.
   */
  observationCapability: string | null;
  /**
   * Authority-bearing origin. Every attempt must name how it came into
   * existence: `initial` at obligation creation, `output_repair` after an
   * authorized output-repair reissue, or `task_rearm` after a task-lifecycle
   * re-arm. There is no origin-less attempt.
   */
  origin: ReviewAttemptOrigin;
  /**
   * Attempt-bound repository Discovery context, resolved BEFORE the attempt is
   * minted: `repository` with a host-owned snapshot for repository-governed
   * reviews, `not_applicable` otherwise. Never mutated after creation.
   */
  repositoryDiscovery: ReviewAttemptDiscoveryContext;
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
    origin: input.origin,
    repositoryDiscovery: input.repositoryDiscovery,
    ...(input.observationCapability === null
      ? {}
      : { observationCapability: input.observationCapability }),
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
  /**
   * Mint authority, supplied by the caller ONLY after the matching transition
   * authority was satisfied (`authorizeOutputRepairReissue` or
   * `authorizeTaskLifecycleRearm`) and the attempt-bound Discovery context was
   * resolved BEFORE this mint. An architecture test whitelists the productive
   * call sites so this parameter cannot become a public backdoor.
   */
  transition: {
    readonly origin: ReviewAttemptOrigin;
    readonly repositoryDiscovery: ReviewAttemptDiscoveryContext;
  },
): { assurance: ReviewAssuranceState; attempt: ReviewAttempt } {
  const base = ensureReviewAssurance(assurance);
  const ordinal =
    (base.attempts?.filter((a) => a.obligationId === obligation.obligationId).length ?? 0) + 1;
  const attempt = createReviewAttempt({
    obligationId: obligation.obligationId,
    obligationType: obligation.obligationType,
    subjectDigest: obligation.subjectDigest,
    reviewMaterial: obligation.reviewMaterial,
    ordinal,
    ...(childSessionId === undefined ? {} : { childSessionId }),
    origin: transition.origin,
    repositoryDiscovery: transition.repositoryDiscovery,
    observationCapability: mintObservationCapabilityIfResolvable(obligation),
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
 * Attempt statuses that may AUTHORIZE repository evidence. Only a `bound`
 * attempt holds authoritative evidence; `captured` would need an explicit
 * justification and dedicated tests before joining this set. Rejected, stale,
 * expired, and created attempts are audit-only and can never strengthen
 * later findings.
 */
export const EVIDENCE_AUTHORIZING_ATTEMPT_STATUSES: ReadonlySet<ReviewAttempt['status']> = new Set([
  'bound',
]);

/**
 * Fail-closed evidence-authorizing attempt resolution for DIRECT submitted
 * findings (manual/SDK transports). A child session may be reused after a
 * rejected attempt, so generic session lookup could pick an OLDER rejected
 * attempt and let its audit-only observations strengthen new findings. This
 * resolver requires:
 *
 * ```text
 * attempt.obligationId === obligationId
 * attempt.childSessionId === childSessionId
 * attempt.status is evidence-authorizing
 * EXACTLY ONE eligible attempt
 * ```
 *
 * Returns null otherwise — ambiguity or absence fails closed.
 */
export function resolveEvidenceAuthorizingAttempt(
  assurance: ReviewAssuranceState | undefined,
  obligationId: string,
  childSessionId: string,
): ReviewAttempt | null {
  const base = ensureReviewAssurance(assurance);
  const eligible = base.attempts.filter(
    (a) =>
      a.obligationId === obligationId &&
      a.childSessionId === childSessionId &&
      EVIDENCE_AUTHORIZING_ATTEMPT_STATUSES.has(a.status),
  );
  return eligible.length === 1 ? eligible[0]! : null;
}

export function updateAttemptStatus(
  assurance: ReviewAssuranceState,
  attemptId: string,
  status: ReviewAttempt['status'],
  now: string,
  extra?: {
    /** Correlate the attempt with a reviewer child session. */
    childSessionId?: string;
    /** Structured rejection reason, persisted only for `rejected` status. */
    rejectionReason?: ReviewAttemptRejectionReason;
    /**
     * Canonical schema-error-set fingerprint, persisted only for `rejected`
     * status. Repair diagnostics — feeds the stall detection of the
     * output-repair gate, never authority.
     */
    schemaErrorFingerprint?: string;
  },
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
            ...(extra?.childSessionId && !a.childSessionId
              ? { childSessionId: extra.childSessionId }
              : {}),
            ...(status === 'rejected' && extra?.rejectionReason
              ? { rejectionReason: extra.rejectionReason }
              : {}),
            ...(status === 'rejected' && extra?.schemaErrorFingerprint
              ? { schemaErrorFingerprint: extra.schemaErrorFingerprint }
              : {}),
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
