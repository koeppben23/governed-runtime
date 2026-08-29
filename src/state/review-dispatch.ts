/**
 * @module state/review-dispatch
 * @description Canonical authority for the durable reviewer-dispatch ledger.
 *
 * P1 (durable dispatch recovery) requires that every reviewer Task dispatch is
 * durably recorded BEFORE the host may release it, so a crash between Before
 * and After can never be mistaken for "never dispatched" after a restart. This
 * module owns the append-only ledger mutators used by every controlled writer
 * (`appendReviewDispatch`, `markDispatchOutcomeUnknown`,
 * `completeReviewDispatch`, `hasUnresolvedDispatch`) together with the shared
 * base `emptyReviewAssurance` / `ensureReviewAssurance` constructors.
 *
 * The ledger record schema lives on `ReviewAssuranceState` in
 * `evidence-review.ts` (the canonical state authority); this module consumes
 * those types so no circular dependency exists between the layers.
 *
 * The ledger is append-only and fail-closed: an entry left `authorized` after a
 * restart forces a fresh append-only re-arm, never a duplicate bind.
 *
 * @version v1
 */

import type { ReviewAssuranceState, ReviewDispatchRecord } from './evidence-review.js';

/** Whether the attempt carries a durable dispatch whose outcome is still unknown. */
export function hasUnresolvedDispatch(
  assurance: ReviewAssuranceState | undefined,
  attemptId: string,
): boolean {
  return (assurance?.dispatches ?? []).some(
    (record) => record.attemptId === attemptId && record.dispatchStatus === 'authorized',
  );
}

/** The canonical empty assurance state. All requirement-bearing fields are present. */
export function emptyReviewAssurance(): ReviewAssuranceState {
  return {
    assuranceSchemaVersion: 'review-assurance.v5',
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

/** Mark the dispatch for a host call ID as completed (After observed the Task). */
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
