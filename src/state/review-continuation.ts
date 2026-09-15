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
 *                    ledger already records a host release: either an
 *                    unresolved `authorized` outcome (a crash/restart between
 *                    release and completion) or an `outcome_unknown` spent
 *                    call. The attempt must be re-armed durably by re-invoking
 *                    the originating command: the old dispatch becomes
 *                    `outcome_unknown`, the spent attempt is staled, and a
 *                    fresh append-only attempt is minted on the same
 *                    obligation (consuming the shared attempt budget).
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
      reason: 'frozen review material is unavailable for this obligation',
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
      reason: 'frozen review material is unavailable for this obligation',
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

// ─── Assurance container primitives ──────────────────────────────────────────
// `emptyReviewAssurance` / `ensureReviewAssurance` and the durable dispatch
// ledger helpers live in `state/review-dispatch.ts`; imported here for local
// use and re-exported for the historical import surface.

import { ensureReviewAssurance, hasReleasedDispatch } from './review-dispatch.js';

export {
  abandonReviewDispatch,
  appendReviewDispatch,
  completeReviewDispatch,
  emptyReviewAssurance,
  ensureReviewAssurance,
  hasReleasedDispatch,
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

// ─── Dispatch-rearm budget ───────────────────────────────────────────────────

/**
 * Number of attempts minted as authorized dispatch-recovery re-arms for this
 * obligation. Derived exclusively from attempt origins — no separate counter
 * exists.
 */
export function countReviewAttempts(
  assurance: ReviewAssuranceState | undefined,
  obligationId: string,
): number {
  return (assurance?.attempts ?? []).filter(
    (a) => a.obligationId === obligationId && a.origin.kind === 'dispatch_rearm',
  ).length;
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
       * bindable attempt exists and output repair is no longer authorized.
       * This is never a state a self-review iteration can repair — it requires
       * an explicit flow recovery (deterministic closure or a fresh attempt
       * authority), never a silent fall-through.
       */
      readonly kind: 'missing_attempt';
      readonly obligation: ReviewObligation;
      readonly code: 'REVIEW_ATTEMPT_UNAVAILABLE';
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
    // A bindable attempt whose durable ledger already records a host release
    // can NEVER be re-emitted as a plain awaiting_task:
    // - `authorized` = crash/restart between release and completion (outcome
    //   unknown);
    // - `outcome_unknown` = the call concluded without bindable evidence
    //   (spent attempt).
    // Both must go through a durable re-arm, which consumes the shared frozen
    // reviewer-attempt budget. Re-dispatching the same attempt would reset the
    // technical retry budget on every command invocation.
    if (hasReleasedDispatch(assurance, bindable.attemptId)) {
      return { kind: 'interrupted_dispatch', obligation, attemptId: bindable.attemptId };
    }
    return { kind: 'awaiting_task', obligation, attemptId: bindable.attemptId };
  }
  // No bindable attempt remains. The frozen-material authority is verified
  // FIRST: a broken binding is an integrity failure (no closure, no state
  // mutation), while intact material with no legal attempt closes
  // deterministically through the missing-attempt route.
  const material = verifyFrozenMaterialForObligation(obligation, obligation.reviewMaterial);
  if (material.kind === 'blocked') {
    return {
      kind: 'integrity_blocked',
      obligation,
      code: material.code,
      reason: material.reason,
    };
  }
  return {
    kind: 'missing_attempt',
    obligation,
    code: 'REVIEW_ATTEMPT_UNAVAILABLE',
    reason: 'no bindable reviewer attempt exists and output repair is no longer authorized',
  };
}
