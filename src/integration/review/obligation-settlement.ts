/**
 * @module integration/review/obligation-settlement
 * @description Canonical settlement of a review obligation after an attempt
 *              rejection has been persisted.
 *
 * A pending review obligation MUST always have exactly one legal continuation:
 *
 *   - a bindable/executable attempt, OR
 *   - an authorized canonical output repair, OR
 *   - valid evidence awaiting verdict submission (obligation `fulfilled`).
 *
 * When a rejected attempt removes the last legal continuation, the obligation
 * is deterministically blocked instead of staying `pending`. A `pending`
 * obligation with no continuation is an illegal persisted state: it wedges the
 * workflow (no reviewer Task can be dispatched, no repair can be authorized,
 * no verdict can be submitted).
 *
 * Flow-neutral: `/review`, `/plan`, `/architecture`, and `/implement` all
 * settle through this authority. Workflow-specific recovery of a `blocked`
 * obligation (restart, re-run, revision) is the concern of the owning command.
 *
 * Frozen-authority integrity failures are NEVER settled here: a broken frozen
 * subject/material binding must not be papered over by blocking the obligation
 * (zero obligation-status mutation, matching the `integrity_blocked` contract
 * of the reissue authority).
 *
 * @version v1
 */

import type { SessionState } from '../../state/schema.js';
import { ensureReviewAssurance, findBindableAttempt } from './assurance.js';
import { authorizeOutputRepairReissue } from './reissue-authority.js';
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

  const authorization = authorizeOutputRepairReissue(assurance, obligation);
  if (authorization.kind === 'authorized' || authorization.kind === 'bindable_exists') {
    // A legal output repair exists (or an attempt is already open).
    return state;
  }
  if (authorization.kind === 'integrity_blocked') {
    // Broken frozen subject/material binding: refuse with ZERO obligation
    // status mutation. The rejection persistence itself remains the only
    // recorded fact.
    return state;
  }

  // No legal continuation remains: terminate the obligation instead of
  // leaving an impossible `pending` state behind.
  return blockObligation(state, obligationId, authorization.code);
}
