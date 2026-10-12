/**
 * @module evidence-gate-decision
 * @description Canonical classification of the recorded review decision for the
 * CURRENT evidence gate.
 *
 * A positive decision is preserved across gates (a plan approval survives into
 * validation and implementation), so the mere presence of an approving
 * `reviewDecision` never proves that the decision belongs to the final
 * evidence gate. This authority separates a current-gate decision from a
 * carried historical one by binding the decision time to the evidence revision
 * (the implementation-review acceptance, or the recorded implementation under
 * reduced ceremony). Historical decisions remain untouched as evidence; they
 * neither authorize nor block a new gate.
 *
 * @version v1
 */

import type { SessionState } from './schema.js';
import type { ReviewDecision } from './evidence.js';

/**
 * The recorded decision when it belongs to THIS evidence revision, otherwise
 * null (a carried plan approval or an unreadable timestamp). Without a
 * recorded evidence revision the decision cannot be classified as carried and
 * is returned as-is; the authorization boundary still requires its fresh
 * gate-bound receipt.
 */
export function evidenceGateDecisionOf(state: SessionState): ReviewDecision | null {
  const decision = state.reviewDecision;
  if (decision === null) return null;
  const evidenceRevisionAt = state.implReview?.executedAt ?? state.implementation?.executedAt;
  if (evidenceRevisionAt === undefined) return decision;
  const decidedAt = Date.parse(decision.decidedAt);
  const revisionAt = Date.parse(evidenceRevisionAt);
  if (Number.isNaN(decidedAt) || Number.isNaN(revisionAt) || decidedAt < revisionAt) return null;
  return decision;
}
