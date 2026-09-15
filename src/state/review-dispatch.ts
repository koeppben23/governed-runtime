/**
 * @module state/review-dispatch
 * @description Canonical authority for the durable reviewer-dispatch ledger.
 *
 * Durable dispatch recovery requires that every reviewer dispatch is durably
 * recorded BEFORE the host may release it, so a crash between release and
 * completion can never be mistaken for "never dispatched" after a restart.
 * This module owns the append-only ledger mutators used by every controlled
 * writer (`appendReviewDispatch`, `markDispatchOutcomeUnknown`,
 * `completeReviewDispatch`, `abandonReviewDispatch`, `hasReleasedDispatch`)
 * together with the shared base `emptyReviewAssurance` /
 * `ensureReviewAssurance` constructors.
 *
 * The ledger record schema lives on `ReviewAssuranceState` in
 * `evidence-review.ts` (the canonical state authority); this module consumes
 * those types so no circular dependency exists between the layers.
 *
 * The ledger is append-only and fail-closed: a bindable attempt whose ledger
 * already records a release (unresolved or spent) forces a fresh append-only
 * re-arm, never a duplicate dispatch on the same attempt.
 *
 * @version v1
 */

import {
  REVIEW_ASSURANCE_SCHEMA_VERSION,
  type ReviewAssuranceState,
  type ReviewDispatchRecord,
} from './evidence-review.js';

/**
 * Whether the attempt was already released to the host at least once.
 *
 * `completed` implies the attempt is bound (never bindable), so on a still
 * bindable attempt ANY dispatch record means a host release already happened:
 * `authorized` = outcome unresolved (crash/restart), `outcome_unknown` = the
 * call concluded without bindable evidence (spent). Both must never be
 * silently re-released on the same attempt — the originating command must
 * re-arm a fresh attempt, which consumes the frozen reviewer-attempt budget.
 */
export function hasReleasedDispatch(
  assurance: ReviewAssuranceState | undefined,
  attemptId: string,
): boolean {
  return (assurance?.dispatches ?? []).some((record) => record.attemptId === attemptId);
}

/** The canonical empty assurance state. All requirement-bearing fields are present. */
export function emptyReviewAssurance(): ReviewAssuranceState {
  return {
    assuranceSchemaVersion: REVIEW_ASSURANCE_SCHEMA_VERSION,
    obligations: [],
    invocations: [],
    attempts: [],
    dispatches: [],
  };
}

/** Resolve an undefined assurance to the canonical empty state. */
export function ensureReviewAssurance(
  assurance: ReviewAssuranceState | undefined,
): ReviewAssuranceState {
  return assurance ?? emptyReviewAssurance();
}

/** Append a dispatch record to the durable, append-only dispatch ledger. */
export function appendReviewDispatch(
  assurance: ReviewAssuranceState | undefined,
  record: ReviewDispatchRecord,
): ReviewAssuranceState {
  const base = ensureReviewAssurance(assurance);
  return { ...base, dispatches: [...(base.dispatches ?? []), record] };
}

/**
 * Mark every dispatch of the superseded attempt as `outcome_unknown`. Called
 * when a task-lifecycle re-arm supersedes an interrupted attempt: a late
 * completion of the old dispatch must remain historical evidence and can never
 * fulfill the current obligation.
 */
export function markDispatchOutcomeUnknown(
  assurance: ReviewAssuranceState | undefined,
  attemptId: string,
): ReviewAssuranceState {
  const base = ensureReviewAssurance(assurance);
  return {
    ...base,
    dispatches: (base.dispatches ?? []).map((record) =>
      record.attemptId === attemptId && record.dispatchStatus !== 'outcome_unknown'
        ? { ...record, dispatchStatus: 'outcome_unknown' as const }
        : record,
    ),
  };
}

/** Mark the dispatch for a host call ID as completed (bound evidence observed). */
export function completeReviewDispatch(
  assurance: ReviewAssuranceState | undefined,
  hostCallId: string,
  completedAt: string,
): ReviewAssuranceState {
  const base = ensureReviewAssurance(assurance);
  return {
    ...base,
    dispatches: (base.dispatches ?? []).map((record) =>
      record.hostCallId === hostCallId && record.dispatchStatus === 'authorized'
        ? { ...record, dispatchStatus: 'completed' as const, completedAt }
        : record,
    ),
  };
}

/** Whether a durable `authorized` dispatch exists for the exact host call and attempt. */
export function hasAuthorizedDispatch(
  assurance: ReviewAssuranceState | undefined,
  hostCallId: string,
  attemptId: string,
): boolean {
  return (assurance?.dispatches ?? []).some(
    (record) =>
      record.hostCallId === hostCallId &&
      record.attemptId === attemptId &&
      record.dispatchStatus === 'authorized',
  );
}

/**
 * Mark the dispatch for a host call ID as `outcome_unknown`. Used when a host
 * call concluded without producing bound evidence (transport failure, timeout,
 * contract violation, rejected findings). A late or unobserved completion of
 * that call can never satisfy the durable-before-release contract again.
 */
export function abandonReviewDispatch(
  assurance: ReviewAssuranceState | undefined,
  hostCallId: string,
): ReviewAssuranceState {
  const base = ensureReviewAssurance(assurance);
  return {
    ...base,
    dispatches: (base.dispatches ?? []).map((record) =>
      record.hostCallId === hostCallId && record.dispatchStatus === 'authorized'
        ? { ...record, dispatchStatus: 'outcome_unknown' as const }
        : record,
    ),
  };
}
