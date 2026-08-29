/**
 * @module state/review-continuation
 * @description Canonical, flow-neutral resolution of the next legal step for
 *              a review obligation type, derived SOLELY from durable review
 *              assurance state.
 *
 * `/plan`, `/architecture`, and `/review` share one lifecycle authority: a
 * re-invocation of the originating command must route on the DURABLE
 * obligation/attempt state, never on transient host state.
 *
 *   awaiting_task  — a bindable attempt exists; re-emit the review instruction
 *                    for it. No new attempt, no new obligation.
 *   interrupted_dispatch — a bindable attempt exists whose durable dispatch
 *                    ledger still reports an unresolved `authorized` outcome
 *                    (a crash/restart between Before and After). The attempt
 *                    must be re-armed durably by re-invoking the originating
 *                    command (/plan, /architecture): the old dispatch becomes
 *                    `outcome_unknown`, the spent attempt is staled, and a
 *                    fresh append-only attempt is minted on the same
 *                    obligation.
 *   output_repair  — the latest attempt is rejected with a canonically
 *                    repairable output-contract reason and the frozen repair
 *                    budget remains; the originating command re-invocation is
 *                    the authorized trigger to mint a fresh attempt on the
 *                    SAME obligation.
 *   awaiting_verdict — valid evidence is bound and awaits verdict submission.
 *   integrity_blocked — the frozen subject/material binding is broken. This is
 *                    an integrity failure, NOT a non-repairable reviewer
 *                    output: no attempt minting, no staling, no obligation
 *                    blocking may follow.
 *   blocked        — the obligation was deterministically blocked (no legal
 *                    continuation). Recovery is flow-specific: a fresh
 *                    orchestration may replace it (same artifact revision,
 *                    new obligation) — never a repair of the old obligation.
 *   none           — no obligation of this type exists, or the latest one is
 *                    consumed.
 *
 * This module lives in the state layer so BOTH the machine layer (NextAction
 * projection) and the integration layer (re-invocation routing) consume the
 * same authority. Integration modules re-export the moved pieces to preserve
 * their historical import surfaces.
 *
 * @version v1
 */

import type {
  FrozenReviewSubject,
  ReviewAssuranceState,
  ReviewAttempt,
  ReviewAttemptRejectionReason,
  ReviewMaterial,
  ReviewObligation,
  ReviewObligationType,
  ReviewSubjectScope,
} from './evidence.js';
import { hashCanonicalReviewContent, normalizeReviewContent } from '../shared/review-subject.js';

// ─── Material envelope / anchor contract ─────────────────────────────────────

/** Typed anchor contract describing the finding-relation contract for a reviewed-subject kind. */
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

// ─── Frozen material integrity verification ──────────────────────────────────

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
 * Verify the persisted bytes and all frozen digest bindings before reviewer
 * prompt injection. This is deliberately the sole constructor for standalone
 * context.
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
 * Verify the frozen material binding of an artifact-scoped obligation
 * (plan/ADR): the frozen material generation AND the artifact subject scope
 * must both bind to the exact artifact subject digest.
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
 * integrity policy never depends on which attempt is being served.
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
  if (obligation.obligationType === 'plan' || obligation.obligationType === 'architecture') {
    const artifact = verifyFrozenArtifactMaterial(obligation, reviewMaterial);
    return artifact.kind === 'ok' ? { kind: 'ok', context: null } : artifact;
  }
  const verified = verifyFrozenReviewerContext(obligation, reviewMaterial);
  return verified.kind === 'ok' ? { kind: 'ok', context: verified.context } : verified;
}

// ─── Rejection policy ────────────────────────────────────────────────────────

/** Canonical repairability policy per structural rejection reason. */
export const REVIEW_ATTEMPT_REJECTION_POLICY: Readonly<
  Record<ReviewAttemptRejectionReason, { readonly repair: 'canonical_output_retry' | 'none' }>
> = {
  // Output-contract defects: a fresh reviewer attempt can plausibly repair
  // these against the same frozen subject.
  schema_invalid: { repair: 'canonical_output_retry' },
  extraction_invalid: { repair: 'canonical_output_retry' },
  attestation_invalid: { repair: 'canonical_output_retry' },
  relation_invalid: { repair: 'canonical_output_retry' },
  // Governance/integrity failures: never re-issuable via this path.
  scope_invalid: { repair: 'none' },
  evidence_unavailable: { repair: 'none' },
  material_integrity_failed: { repair: 'none' },
  subject_mismatch: { repair: 'none' },
  consistency_invalid: { repair: 'none' },
  // Execution failures: separate availability/execution domain.
  reviewer_unavailable: { repair: 'none' },
  task_failed: { repair: 'none' },
};

/** Whether a structural rejection reason authorizes an output-repair reissue. */
export function isCanonicallyRepairable(reason: ReviewAttemptRejectionReason): boolean {
  return REVIEW_ATTEMPT_REJECTION_POLICY[reason].repair === 'canonical_output_retry';
}

// ─── Assurance container primitives ──────────────────────────────────────────
// `emptyReviewAssurance` / `ensureReviewAssurance` and the durable dispatch
// ledger helpers live in `state/review-dispatch.ts`; imported here for local
// use and re-exported for the historical import surface.

import { ensureReviewAssurance, hasUnresolvedDispatch } from './review-dispatch.js';

export {
  appendReviewDispatch,
  completeReviewDispatch,
  emptyReviewAssurance,
  ensureReviewAssurance,
  hasUnresolvedDispatch,
  markDispatchOutcomeUnknown,
} from './review-dispatch.js';

/**
 * The attempt a host Task can still be bound to for `obligationId`.
 *
 * Bindable means: created but not yet correlated with a reviewer child
 * session, and not superseded (minting a newer attempt stales earlier ones, so
 * at most one attempt per obligation qualifies). Returns the highest ordinal
 * if that invariant is ever violated, and null when no attempt can accept a
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

// ─── Output-repair reissue authority ─────────────────────────────────────────

export type ReissueBlockCode =
  | 'REVIEW_REPAIR_UNAVAILABLE'
  | 'REVIEWER_OUTPUT_RETRY_EXHAUSTED'
  | 'REVIEWER_OUTPUT_REPAIR_STALLED';

/** The attempt with the highest ordinal for an obligation, or null. */
export function latestAttemptForObligation(
  assurance: ReviewAssuranceState | undefined,
  obligationId: string,
): ReviewAttempt | null {
  const candidates = (assurance?.attempts ?? []).filter((a) => a.obligationId === obligationId);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, a) => (a.ordinal > best.ordinal ? a : best));
}

/**
 * Number of attempts minted as authorized output repairs for this obligation.
 * Derived exclusively from attempt origins — no separate counter exists.
 */
export function countOutputRepairAttempts(
  assurance: ReviewAssuranceState | undefined,
  obligationId: string,
): number {
  return (assurance?.attempts ?? []).filter(
    (a) => a.obligationId === obligationId && a.origin.kind === 'output_repair',
  ).length;
}

export type OutputRepairAuthorization =
  | { readonly kind: 'bindable_exists'; readonly attemptId: string }
  | {
      readonly kind: 'authorized';
      readonly predecessorAttemptId: string;
      readonly triggerReason: ReviewAttemptRejectionReason;
    }
  | {
      readonly kind: 'blocked';
      readonly code: ReissueBlockCode;
      readonly reason: string;
    }
  | {
      readonly kind: 'integrity_blocked';
      readonly code: 'REVIEW_MATERIAL_INTEGRITY_FAILED';
      readonly reason: string;
    };

/**
 * Stall detection: a targeted repair that reproduced the IDENTICAL schema
 * error set gained no new information — another LLM repair is token burn, not
 * recovery. Canonical fingerprint comparison only; different error sets keep
 * the normal budget.
 */
function repairStallBlock(
  assurance: ReviewAssuranceState | undefined,
  latest: ReviewAttempt,
): { readonly code: ReissueBlockCode; readonly reason: string } | null {
  if (latest.rejectionReason !== 'schema_invalid' || latest.origin.kind !== 'output_repair') {
    return null;
  }
  const origin = latest.origin;
  const predecessor = (assurance?.attempts ?? []).find(
    (a) => a.attemptId === origin.predecessorAttemptId,
  );
  if (
    latest.schemaErrorFingerprint &&
    predecessor?.schemaErrorFingerprint &&
    latest.schemaErrorFingerprint === predecessor.schemaErrorFingerprint
  ) {
    return {
      code: 'REVIEWER_OUTPUT_REPAIR_STALLED',
      reason:
        'the targeted repair reproduced the identical schema error set; no further reviewer repair is authorized',
    };
  }
  return null;
}

/**
 * Decide whether a pending obligation may receive a new `output_repair` attempt.
 *
 * The immutable authority is verified FIRST — a broken frozen subject/material
 * binding blocks the transition before any other condition is consulted and
 * before any state can be mutated:
 *   verifyFrozenMaterialForObligation(obligation, latestReviewMaterial) == ok
 *   AND obligation.status === 'pending'
 *   AND no bindable attempt exists (an open attempt is returned as-is)
 *   AND the latest attempt exists and is `rejected`
 *   AND it carries an explicit structured rejectionReason
 *   AND the rejection policy classifies that reason as `canonical_output_retry`
 *   AND the repair did NOT reproduce the identical schema error set (stall)
 *   AND the frozen budget has remaining capacity
 *
 * Everything else blocks — fail-closed, no defaulting anywhere.
 */
export function authorizeOutputRepairReissue(
  assurance: ReviewAssuranceState | undefined,
  obligation: ReviewObligation,
): OutputRepairAuthorization {
  const material = latestReviewMaterial(ensureReviewAssurance(assurance), obligation.obligationId);
  const materialVerification = verifyFrozenMaterialForObligation(obligation, material);
  if (materialVerification.kind === 'blocked') {
    return {
      kind: 'integrity_blocked',
      code: materialVerification.code,
      reason: materialVerification.reason,
    };
  }
  if (obligation.status !== 'pending') {
    return {
      kind: 'blocked',
      code: 'REVIEW_REPAIR_UNAVAILABLE',
      reason: `review obligation is ${obligation.status}, not pending`,
    };
  }
  const bindable = findBindableAttempt(assurance, obligation.obligationId);
  if (bindable) {
    return { kind: 'bindable_exists', attemptId: bindable.attemptId };
  }
  const latest = latestAttemptForObligation(assurance, obligation.obligationId);
  if (!latest || latest.status !== 'rejected') {
    return {
      kind: 'blocked',
      code: 'REVIEW_REPAIR_UNAVAILABLE',
      reason: 'no rejected attempt exists to repair',
    };
  }
  const reason = latest.rejectionReason;
  if (!reason) {
    return {
      kind: 'blocked',
      code: 'REVIEW_REPAIR_UNAVAILABLE',
      reason: 'latest attempt was rejected without a structured rejection reason',
    };
  }
  if (!isCanonicallyRepairable(reason)) {
    return {
      kind: 'blocked',
      code: 'REVIEW_REPAIR_UNAVAILABLE',
      reason: `rejection reason ${reason} does not authorize an output repair`,
    };
  }
  const stall = repairStallBlock(assurance, latest);
  if (stall) {
    return { kind: 'blocked', code: stall.code, reason: stall.reason };
  }
  const used = countOutputRepairAttempts(assurance, obligation.obligationId);
  if (used >= obligation.maxReviewerOutputRepairAttempts) {
    return {
      kind: 'blocked',
      code: 'REVIEWER_OUTPUT_RETRY_EXHAUSTED',
      reason: `output-repair budget exhausted (${used}/${obligation.maxReviewerOutputRepairAttempts})`,
    };
  }
  return {
    kind: 'authorized',
    predecessorAttemptId: latest.attemptId,
    triggerReason: reason,
  };
}

// ─── Continuation resolution ─────────────────────────────────────────────────

export type ReviewContinuation =
  | {
      readonly kind: 'awaiting_task';
      readonly obligation: ReviewObligation;
      readonly attemptId: string;
    }
  | {
      /**
       * A bindable created attempt exists but its durable dispatch ledger still
       * carries an unresolved `authorized` record (a crash/restart between
       * Before and After). It must NOT be re-emitted as a plain `awaiting_task`:
       * re-invoking the originating command is the authorized trigger to re-arm
       * durably (the spent attempt is staled, its dispatch marked
       * `outcome_unknown`, and a fresh append-only attempt minted on the same
       * obligation).
       */
      readonly kind: 'interrupted_dispatch';
      readonly obligation: ReviewObligation;
      readonly attemptId: string;
    }
  | {
      readonly kind: 'output_repair';
      readonly obligation: ReviewObligation;
      readonly authorization: Extract<OutputRepairAuthorization, { readonly kind: 'authorized' }>;
    }
  | {
      readonly kind: 'integrity_blocked';
      readonly obligation: ReviewObligation;
      readonly code: string;
      readonly reason: string;
    }
  | { readonly kind: 'awaiting_verdict'; readonly obligation: ReviewObligation }
  | { readonly kind: 'blocked'; readonly obligation: ReviewObligation }
  | {
      /**
       * The obligation is pending but has NO legal reviewer attempt: no
       * bindable attempt exists and no output repair is authorized. This is
       * never a state a self-review iteration can repair — it requires an
       * explicit flow recovery (deterministic closure or a fresh attempt
       * authority), never a silent fall-through.
       */
      readonly kind: 'missing_attempt';
      readonly obligation: ReviewObligation;
      readonly code: ReissueBlockCode;
      readonly reason: string;
    }
  | { readonly kind: 'none' };

function latestObligationOfType(
  obligations: readonly ReviewObligation[],
  obligationType: ReviewObligationType,
): ReviewObligation | undefined {
  return [...obligations].reverse().find((o) => o.obligationType === obligationType);
}

/**
 * Resolve the next legal step for the latest obligation of the given type.
 * Pure: reads only the durable assurance state.
 */
export function resolveReviewContinuation(
  reviewAssurance: ReviewAssuranceState | undefined,
  obligationType: ReviewObligationType,
): ReviewContinuation {
  const assurance = ensureReviewAssurance(reviewAssurance);
  const obligation = latestObligationOfType(assurance.obligations, obligationType);
  if (!obligation) return { kind: 'none' };

  if (obligation.status === 'blocked') return { kind: 'blocked', obligation };
  if (obligation.status === 'fulfilled') return { kind: 'awaiting_verdict', obligation };
  if (obligation.status !== 'pending') return { kind: 'none' };

  const bindable = findBindableAttempt(assurance, obligation.obligationId);
  if (bindable) {
    // A created attempt whose durable dispatch ledger still reports an
    // unresolved `authorized` outcome can NEVER be re-emitted as a plain
    // awaiting_task: a crash/restart between Before and After would otherwise
    // be mistaken for "never dispatched" and the spent attempt re-bound. It is
    // an interrupted dispatch that the originating command (/plan,
    // /architecture) must re-arm durably.
    if (hasUnresolvedDispatch(assurance, bindable.attemptId)) {
      return { kind: 'interrupted_dispatch', obligation, attemptId: bindable.attemptId };
    }
    return { kind: 'awaiting_task', obligation, attemptId: bindable.attemptId };
  }
  const authorization = authorizeOutputRepairReissue(assurance, obligation);
  if (authorization.kind === 'authorized') {
    return { kind: 'output_repair', obligation, authorization };
  }
  if (authorization.kind === 'integrity_blocked') {
    return {
      kind: 'integrity_blocked',
      obligation,
      code: authorization.code,
      reason: authorization.reason,
    };
  }
  if (authorization.kind === 'bindable_exists') return { kind: 'none' };
  return {
    kind: 'missing_attempt',
    obligation,
    code: authorization.code,
    reason: authorization.reason,
  };
}
