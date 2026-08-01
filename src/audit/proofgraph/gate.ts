/**
 * @module audit/proofgraph/gate
 * @description Pure ProofGraph gate decision.
 *
 * Encodes the policy-gating invariants without touching workflow transitions:
 * only critical, evidence-backed `fact` claims are gate-eligible; a claim that
 * is not PROVEN blocks only when gating is enabled by policy. `derived_signal`
 * and `hypothesis` claims are never gate-eligible - they remain advisory.
 *
 * The gate is disabled by default and until rollout validation: an absent or
 * disabled policy yields a non-gating decision. The decision is computed and
 * surfaced; it does not itself block a governed transition.
 *
 * @version v1
 */

import type { ProofGraphSummary } from './summary.js';

/** The evaluated ProofGraph gate decision. */
export interface ProofGraphGateDecision {
  /** Whether the policy has gating enabled at all. */
  readonly enforced: boolean;
  /** Whether the gate would block (only possible when enforced). */
  readonly gated: boolean;
  /** Critical fact claims that are not PROVEN (the blocking set when enforced). */
  readonly blockingClaimIds: readonly string[];
  /** Human-readable rationale. */
  readonly reason: string;
}

/** Structural view of the ProofGraph policy (kept import-free of the config layer). */
export interface ProofGraphGatePolicy {
  readonly enabled: boolean;
}

/**
 * Evaluate the ProofGraph gate for a session summary.
 *
 * @param summary The session's ProofGraph summary.
 * @param policy  The ProofGraph gating policy, or undefined (treated as disabled).
 */
export function evaluateProofGraphGate(
  summary: Pick<ProofGraphSummary, 'projection'>,
  policy: ProofGraphGatePolicy | undefined,
): ProofGraphGateDecision {
  if (policy?.enabled !== true) {
    return {
      enforced: false,
      gated: false,
      blockingClaimIds: [],
      reason: 'ProofGraph gating is disabled by policy.',
    };
  }
  const blockingClaimIds = summary.projection.claims
    .filter(
      (claim) =>
        claim.critical && claim.signalClass === 'fact' && claim.verificationState !== 'PROVEN',
    )
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
