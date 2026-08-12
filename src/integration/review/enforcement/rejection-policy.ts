/**
 * @module integration/review/enforcement/rejection-policy
 * @description Canonical classification of review-attempt rejections.
 *
 * Maps machine-readable bind outcomes and verdict-time consistency codes to
 * the structural `ReviewAttemptRejectionReason` enum and decides which
 * rejection reasons authorize an obligation-level output-repair reissue.
 *
 * Semantics:
 * - `canonical_output_retry` — the reviewer produced a non-bindable OUTPUT
 *   whose contract defect can plausibly be repaired by a fresh independent
 *   reviewer attempt against the same frozen subject.
 * - `none` — governance, scope, material-integrity, semantic-consistency, or
 *   execution failures. A new reviewer output cannot legitimately repair
 *   these; they never authorize a reissue.
 *
 * Every `HostTaskBindOutcome` must have an explicit mapping (enforced by an
 * architecture test). Outcomes that never persist a rejected attempt map to
 * `null`.
 *
 * @version v1
 */

import type { ReviewAttemptRejectionReason } from '../../../state/evidence.js';
import type { HostTaskBindOutcome } from './types.js';

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

/**
 * Map a host-task bind outcome to the structural rejection reason persisted on
 * a rejected attempt.
 *
 * Returns `null` for outcomes that never produce a persisted `rejected`
 * attempt state:
 * - success (`bound`),
 * - environment outcomes without an attempt record (`no_matched_record`,
 *   `no_child_session`, `no_obligation_type`, `no_findings`, `unknown_attempt`),
 * - lifecycle outcomes (`stale_attempt`, `idempotent_bound`,
 *   `idempotent_rejected`), which carry no attempt in the bind result,
 * - `duplicate_evidence`: the attempt is marked `rejected` by the persistence
 *   path but the duplicate is a lifecycle condition, not a reviewer-output
 *   defect — deliberately left without a structured reason so the reissue
 *   gate fails closed (no reason → not repairable).
 */
const BIND_OUTCOME_TO_REASON: Readonly<
  Partial<Record<HostTaskBindOutcome, ReviewAttemptRejectionReason>>
> = {
  // Output-contract defects (repairable).
  schema_invalid: 'schema_invalid',
  // Cycle-binding echo (iteration/planVersion/attested obligation) is a
  // reviewer attestation defect — repairable by a fresh reviewer output.
  field_mismatch: 'attestation_invalid',
  client_reference_invalid: 'relation_invalid',
  // Single cause at the bind boundary: challenge count mismatch
  // (challenge-binding.ts checkChallengeContract). Semantic challenge
  // inconsistencies surface separately at verdict time as
  // SUBAGENT_CHALLENGE_* codes and map to `consistency_invalid`.
  challenge_contract_violation: 'relation_invalid',
  // Governance failures (never repairable).
  challenge_evidence_unknown: 'consistency_invalid',
  findings_incoherent: 'consistency_invalid',
  review_finding_out_of_scope: 'scope_invalid',
  review_finding_scope_unverifiable: 'scope_invalid',
  no_matching_obligation: 'subject_mismatch',
  // Cross-artifact subject digest mismatch — integrity failure.
  subject_mismatch: 'material_integrity_failed',
};

export function bindOutcomeToRejectionReason(
  outcome: HostTaskBindOutcome,
): ReviewAttemptRejectionReason | null {
  return BIND_OUTCOME_TO_REASON[outcome] ?? null;
}
