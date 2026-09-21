/**
 * @module integration/review/obligation-settlement
 * @description Canonical settlement of a review obligation after an attempt
 *              rejection has been persisted.
 *
 * A pending review obligation MUST always have exactly one legal continuation:
 *
 *   - a bindable/executable attempt, OR
 *   - valid evidence awaiting verdict submission (obligation `fulfilled`).
 *
 * When a rejected attempt removes the last legal continuation, the obligation
 * is deterministically blocked instead of staying `pending`. A `pending`
 * obligation with no continuation is an illegal persisted state: it wedges the
 * workflow (no reviewer Task can be dispatched, no reissue exists, no verdict
 * can be submitted). There is deliberately no repairable model-output
 * rejection: a rejected attempt never authorizes a fresh attempt on the same
 * obligation.
 *
 * Flow-neutral: `/review`, `/plan`, `/architecture`, and `/implement` all
 * settle through this authority. Workflow-specific recovery of a `blocked`
 * obligation (restart, re-run, revision) is the concern of the owning command.
 *
 * Frozen-authority integrity failures are NEVER settled here: a broken frozen
 * subject/material binding must not be papered over by blocking the obligation
 * (zero obligation-status mutation, matching the `integrity_blocked` contract
 * of the continuation authority).
 *
 * @version v2
 */

import type { SessionState } from '../../../state/schema.js';
import { ensureReviewAssurance, findBindableAttempt } from './assurance.js';
import { verifyFrozenMaterialForObligation } from '../../../state/review-continuation.js';
import { blockObligation } from './obligation-state.js';

/**
 * Settle a review obligation after its attempt was rejected.
 *
 * Pure relative to the caller's snapshot: returns the input state unchanged
 * when a legal continuation exists (or the obligation is not pending), and
 * returns the state with the obligation blocked otherwise.
 */
export function settleReviewObligationAfterAttempt(
  state: SessionState,
  obligationId: string,
): SessionState {
  const assurance = ensureReviewAssurance(state.reviewAssurance);
  const obligation = assurance.obligations.find((o) => o.obligationId === obligationId);
  if (!obligation || obligation.status !== 'pending') return state;

  // A bindable attempt keeps the obligation pending: the reviewer Task can
  // still be dispatched against it.
  if (findBindableAttempt(assurance, obligationId)) return state;

  // Broken frozen subject/material binding: refuse with ZERO obligation
  // status mutation. The rejection persistence itself remains the only
  // recorded fact.
  const material = verifyFrozenMaterialForObligation(obligation, obligation.reviewMaterial);
  if (material.kind === 'blocked') return state;

  // No legal continuation remains: terminate the obligation instead of
  // leaving an impossible `pending` state behind.
  return blockObligation(state, obligationId, 'REVIEW_ATTEMPT_UNAVAILABLE');
}
