/**
 * @module audit/proofgraph/gate
 * @description Pure ProofGraph gate decision.
 *
 * Encodes the gating invariants without touching workflow transitions: only
 * critical, evidence-backed `fact` claims are gate-eligible. `derived_signal`
 * and `hypothesis` claims are never gate-eligible — they remain advisory.
 *
 * Enforcement is UNCONDITIONAL. A policy switch would mean that a user declares
 * a claim as critical, has it human-approved, and the system then ignores
 * whether it was ever proven — which contradicts the meaning of `critical`. The
 * blast radius is already narrow by construction: a session without critical
 * fact claims has nothing to gate.
 *
 * The decision is computed and surfaced; it does not itself block a governed
 * transition.
 *
 * @version v1
 */

import type { ProofGraphSummary } from './summary.js';
import type { ProofClaim } from '../../state/proofgraph.js';

/** The evaluated ProofGraph gate decision. */
export interface ProofGraphGateDecision {
  /**
   * Compatibility field. ProofGraph enforcement is unconditional for eligible
   * claims and no longer depends on policy; retained as a constant so the
   * `flowguard_status({ proofGraph: true })` projection stays stable for
   * consumers. Removal belongs to an explicit schema version.
   */
  readonly enforced: true;
  /** Whether the gate blocks. */
  readonly gated: boolean;
  /** Critical, certificate-authorized fact claims that are not PROVEN. */
  readonly blockingClaimIds: readonly string[];
  /** Human-readable rationale. */
  readonly reason: string;
}

/**
 * Whether a claim may block at all.
 *
 * Certificate authorization is required, not merely `fact` provenance: only a
 * declaration that passed the human plan/ADR approval carries an `approval`
 * binding. A claim self-declared after implementation (via
 * `flowguard_declare_contract`) has provenance but no certificate, and must stay
 * advisory — otherwise an author could impose a blocking obligation on their own
 * approval without any human having approved that obligation.
 */
function isGateEligible(claim: ProofClaim): boolean {
  if (!claim.critical || claim.signalClass !== 'fact') return false;
  return (
    claim.provenance?.kind === 'canonical_authority' && claim.provenance.approval !== undefined
  );
}

/**
 * Evaluate the ProofGraph gate for a session summary.
 *
 * @param summary The session's ProofGraph summary.
 */
export function evaluateProofGraphGate(
  summary: Pick<ProofGraphSummary, 'projection'>,
): ProofGraphGateDecision {
  const blockingClaimIds = summary.projection.claims
    .filter((claim) => isGateEligible(claim) && claim.verificationState !== 'PROVEN')
    .map((claim) => claim.claimId);
  return {
    enforced: true,
    gated: blockingClaimIds.length > 0,
    blockingClaimIds,
    reason:
      blockingClaimIds.length > 0
        ? `${blockingClaimIds.length} critical fact claim(s) are not PROVEN.`
        : 'All critical fact claims are PROVEN.',
  };
}
