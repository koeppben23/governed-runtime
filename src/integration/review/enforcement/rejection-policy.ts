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

export {
  REVIEW_ATTEMPT_REJECTION_POLICY,
  isCanonicallyRepairable,
} from '../../../state/review-continuation.js';

/**
 * Canonical mapping from every host-task bind outcome to the structural
 * rejection reason persisted on a rejected attempt.
 *
 * Deliberately a TOTAL record (satisfies the full outcome type): extending
 * `HostTaskBindOutcome` without adding a key here is a compile error, so a
 * new outcome can never silently degrade to a reason-less rejection.
 *
 * `null` entries are outcomes that never produce a persisted `rejected`
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
export const BIND_OUTCOME_TO_REASON = {
  bound: null,
  no_matched_record: null,
  no_child_session: null,
  no_obligation_type: null,
  no_findings: null,
  extraction_invalid: 'extraction_invalid',
  // Lineage failure: the attempt names a missing/consumed obligation.
  no_matching_obligation: 'subject_mismatch',
  // Cycle-binding echo (iteration/planVersion/attested obligation) is a
  // reviewer attestation defect — repairable by a fresh reviewer output.
  field_mismatch: 'attestation_invalid',
  duplicate_evidence: null,
  // Output-contract defect (repairable).
  schema_invalid: 'schema_invalid',
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
  // Repository evidenceLocations without a matching authoritative Observation.
  // The citation is a claim, not proof: evidence_unavailable, never repairable.
  repository_evidence_unbound: 'evidence_unavailable',
  // Cross-artifact subject digest mismatch — integrity failure.
  subject_mismatch: 'material_integrity_failed',
  stale_attempt: null,
  idempotent_bound: null,
  idempotent_rejected: null,
  unknown_attempt: null,
} satisfies Readonly<Record<HostTaskBindOutcome, ReviewAttemptRejectionReason | null>>;

export function bindOutcomeToRejectionReason(
  outcome: HostTaskBindOutcome,
): ReviewAttemptRejectionReason | null {
  return BIND_OUTCOME_TO_REASON[outcome];
}
