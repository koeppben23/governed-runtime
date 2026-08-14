/**
 * @module integration/review/reissue-authority
 * @description Transition authorities for minting NEW attempts on an existing
 *              obligation.
 *
 * Two strictly separated authority domains:
 *
 * 1. `authorizeOutputRepairReissue` — obligation-level output repair. Authorizes
 *    exactly one new `output_repair` attempt when the latest attempt was
 *    rejected with a canonically repairable output-contract reason and the
 *    FROZEN obligation budget (`maxReviewerOutputRepairAttempts`) still has
 *    capacity. Budget consumption is derived exclusively from the attempt
 *    history (origins), never from a mutable counter.
 *
 * 2. `authorizeTaskLifecycleRearm` — reviewer Task lifecycle re-arm
 *    (interrupted Task, or a Task re-invoked after its attempt was spent).
 *    Budgeted by the existing enforcement retry gate at Task dispatch time,
 *    NOT by the output-repair budget. Produces `task_rearm` origins.
 *
 * Neither function mints attempts itself; both return the authority outcome
 * and `createAttemptForExistingObligation` is only reachable through them
 * (enforced by an architecture test on the productive call sites).
 *
 * @version v1
 */

import type {
  ReviewAssuranceState,
  ReviewAttempt,
  ReviewAttemptOrigin,
  ReviewAttemptRejectionReason,
  ReviewObligation,
} from '../../state/evidence.js';
import {
  ensureReviewAssurance,
  findBindableAttempt,
  latestReviewMaterial,
} from './attempt-lifecycle.js';
import { isCanonicallyRepairable } from './enforcement/rejection-policy.js';
import { verifyFrozenMaterialForObligation } from './frozen-reviewer-context.js';

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
      /**
       * The frozen review subject/material binding is broken. This is an
       * integrity failure, NOT a non-repairable reviewer output: callers must
       * refuse with `REVIEW_MATERIAL_INTEGRITY_FAILED` and perform ZERO state
       * mutation (no attempt minting, no staling, no obligation blocking).
       */
      readonly kind: 'integrity_blocked';
      readonly code: 'REVIEW_MATERIAL_INTEGRITY_FAILED';
      readonly reason: string;
    };

/**
 * Stall detection: a targeted repair that reproduced the IDENTICAL schema
 * error set gained no new information — another LLM repair is token burn, not
 * recovery. Canonical fingerprint comparison only; different error sets keep
 * the normal budget. Fails safe when either fingerprint is absent (e.g.
 * SDK-path rejections without machine-readable issues).
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
 *   verifyFrozenReviewerContext(obligation, latestReviewMaterial) == ok
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
  // Single frozen-material authority: artifact-scoped obligations bind their
  // material generation to the exact artifact subject digest; standalone
  // subjects verify through the full frozen context.
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

export type TaskRearmAuthorization =
  | {
      readonly kind: 'authorized';
      readonly obligation: ReviewObligation;
      readonly origin: Extract<ReviewAttemptOrigin, { readonly kind: 'task_rearm' }>;
    }
  | { readonly kind: 'blocked'; readonly reason: string };

/**
 * Decide whether a spent/interrupted attempt may be re-armed by the reviewer
 * Task lifecycle. The settled-obligation guard lives here so the re-arm path
 * cannot mint attempts on fulfilled, consumed, or blocked obligations.
 *
 * The re-arm budget is the existing enforcement retry gate (Task dispatch),
 * deliberately NOT the output-repair budget.
 */
export function authorizeTaskLifecycleRearm(
  assurance: ReviewAssuranceState,
  spent: ReviewAttempt,
): TaskRearmAuthorization {
  const obligation = assurance.obligations.find((o) => o.obligationId === spent.obligationId);
  if (!obligation) {
    return { kind: 'blocked', reason: 'rearm_obligation_not_found' };
  }
  if (
    obligation.status === 'fulfilled' ||
    obligation.status === 'consumed' ||
    obligation.status === 'blocked'
  ) {
    return { kind: 'blocked', reason: 'rearm_obligation_settled' };
  }
  const triggerReason =
    spent.status === 'created'
      ? 'interrupted'
      : spent.status === 'rejected'
        ? 'rejected'
        : spent.status === 'stale'
          ? 'stale'
          : 'expired';
  return {
    kind: 'authorized',
    obligation,
    origin: {
      kind: 'task_rearm',
      predecessorAttemptId: spent.attemptId,
      triggerReason,
    },
  };
}
