/**
 * @module audit/proofgraph/enforcement-projection
 * @description Governance/blocking projection over already-evaluated ProofGraph claims.
 *
 * Consumes evaluated ProofClaims (verification states assigned by the evaluator)
 * and projects governance-relevant enforcement decisions: which claims block,
 * why they block, and the overall gate disposition.
 *
 * This module does NOT evaluate claims — the evaluator (evaluate.ts) owns
 * ClaimVerificationState. This module owns governance interpretation.
 *
 * Pure function: no side effects, no state access, deterministic.
 *
 * @version v2
 */

import type { ProofGraphSummary } from './summary.js';
import type { ProofClaim } from '../../state/proofgraph.js';
import type { ClaimVerificationState } from '../../state/proofgraph-primitives.js';
import type { SpecificRiskTrigger } from '../../state/risk-trigger.js';
import type { AssertionBindingReasonCode } from './assertion-evidence-binding.js';
import {
  mapBindingReasonToRegistryCode,
  mapEnforcementReasonToRegistryCode,
} from './reason-code-mapping.js';
import type { EnforcementReasonCode } from './reason-code-mapping.js';

// Re-export for consumers
export type { EnforcementReasonCode };

/**
 * ProofGraph gate decision disposition, projected by computeProofGraphEnforcement.
 * Owned here with the decision shape; registry codes are derived exclusively
 * from `reasonCode` via mapEnforcementReasonToRegistryCode.
 */
export type EnforcementDecisionKind =
  | 'clear'
  | 'evaluation_unavailable'
  | 'risk_assessment_stale'
  | 'certificate_invalid'
  | 'critical_fact_required'
  | 'risk_trigger_uncovered'
  | 'facts_unproven';

/** Reason codes emitted by the enforcement projection. */

export interface ClaimEnforcementState {
  readonly claimId: string;
  readonly statement: string;
  readonly critical: boolean;
  readonly signalClass: string;
  readonly gateEligible: boolean;
  readonly verificationState: ClaimVerificationState;
  readonly reasonCodes: readonly EnforcementReasonCode[];
  /** Registry code derived from the primary blocking reason. */
  readonly registryCode?: string;
}

export interface BlockingClaim {
  readonly claimId: string;
  readonly state: 'CONTRADICTED' | 'NOT_VERIFIED' | 'STALE' | 'BLOCKED' | 'UNPROVEN';
  readonly reasonCode: EnforcementReasonCode;
  /** Registry code derived from the binding diagnostic, or generic enforcement mapping. */
  readonly registryCode: string;
}

export interface ProofGraphEnforcement {
  readonly claims: readonly ClaimEnforcementState[];
  readonly blockingClaims: readonly BlockingClaim[];
  readonly satisfied: boolean;
  readonly decisionKind: EnforcementDecisionKind;
  readonly reasonCode: EnforcementReasonCode;
  readonly reason: string;
  /** Specific triggers detected for the current implementation but not covered. */
  readonly uncoveredTriggers: readonly SpecificRiskTrigger[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isGateEligible(claim: ProofClaim): boolean {
  if (!claim.critical || claim.signalClass !== 'fact') return false;
  return (
    claim.provenance?.kind === 'canonical_authority' && claim.provenance.approval !== undefined
  );
}

function claimReasonCodes(
  claim: ProofClaim,
  diagnostics?: ReadonlyMap<string, AssertionBindingReasonCode>,
): EnforcementReasonCode[] {
  const reasons: EnforcementReasonCode[] = [];
  if (!claim.provenance) {
    reasons.push('provenance_missing');
  }
  const diag = diagnostics?.get(claim.claimId);
  switch (claim.verificationState) {
    case 'PROVEN':
      reasons.push('proven');
      break;
    case 'CONTRADICTED':
      reasons.push('counterexample_observed');
      break;
    case 'NOT_VERIFIED':
      reasons.push(diag ?? 'evidence_missing');
      break;
    case 'STALE':
      reasons.push('evidence_stale');
      break;
    case 'BLOCKED':
      reasons.push('provider_execution_error');
      break;
    case 'UNPROVEN':
      reasons.push('evidence_unproven');
      break;
  }
  return reasons;
}

function primaryRegistryCode(
  enforcementCodes: readonly EnforcementReasonCode[],
  bindingDiag?: AssertionBindingReasonCode,
): string {
  if (bindingDiag) {
    return mapBindingReasonToRegistryCode(bindingDiag);
  }
  const primary = enforcementCodes[0] ?? 'evidence_missing';
  return mapEnforcementReasonToRegistryCode(primary);
}

function blockingStateFor(state: ClaimVerificationState): BlockingClaim['state'] | null {
  switch (state) {
    case 'CONTRADICTED':
    case 'NOT_VERIFIED':
    case 'STALE':
    case 'BLOCKED':
    case 'UNPROVEN':
      return state;
    case 'PROVEN':
      return null;
  }
}

function primaryReason(reasons: EnforcementReasonCode[]): EnforcementReasonCode {
  return reasons[0] ?? 'evidence_missing';
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface ComputeEnforcementInput {
  readonly projection?: ProofGraphSummary['projection'];
  readonly authorizedCriticalClaimIds?: readonly string[];
  /** A current certificate is required before any final-evidence approval. */
  readonly certificateValid?: boolean;
  readonly implementationDigest?: string;
  readonly riskAssessmentStale?: boolean;
  /** Specific triggers detected for the current implementation (`ceremony_only` excluded). */
  readonly riskTriggers?: readonly SpecificRiskTrigger[];
  /**
   * Certificate-bound coverage relation (critical claim id -> approved
   * triggers). Coverage is enforced from THIS relation, never from the
   * persisted projection's `coversRiskTriggers`, so a tampered or stale
   * projection cannot widen the approved contract.
   */
  readonly authorizedRiskTriggerCoverage?: ReadonlyMap<string, readonly SpecificRiskTrigger[]>;
  /** Per-claim binding diagnostic codes from counterexample evaluation. */
  readonly claimDiagnostics?: ReadonlyMap<string, AssertionBindingReasonCode>;
}

/**
 * Specific triggers that no authorized and gate-eligible claim covers.
 *
 * A coverage entry counts only when its claim is present and eligible in the
 * projection; the per-claim loop separately requires every eligible claim to be
 * PROVEN.
 */
function uncoveredRiskTriggers(
  input: ComputeEnforcementInput,
  eligibleClaims: readonly ProofClaim[],
): readonly SpecificRiskTrigger[] {
  const eligibleIds = new Set(eligibleClaims.map((claim) => claim.claimId));
  const covered = new Set<SpecificRiskTrigger>();
  for (const [claimId, triggers] of input.authorizedRiskTriggerCoverage ?? []) {
    if (!eligibleIds.has(claimId)) continue;
    for (const trigger of triggers) covered.add(trigger);
  }
  return (input.riskTriggers ?? []).filter((trigger) => !covered.has(trigger));
}

function evaluatePreconditions(
  input: ComputeEnforcementInput,
  eligibleClaims: readonly ProofClaim[],
): ProofGraphEnforcement | null {
  const triggers = input.riskTriggers ?? [];
  if (input.certificateValid === false) {
    return {
      claims: [],
      blockingClaims: [],
      satisfied: false,
      decisionKind: 'certificate_invalid',
      reasonCode: 'certificate_invalid',
      reason: 'The plan approval certificate is missing, stale, or does not bind the current plan.',
      uncoveredTriggers: [],
    };
  }
  const eligibleIds = new Set(eligibleClaims.map((c) => c.claimId));
  const missingIds = (input.authorizedCriticalClaimIds ?? []).filter((id) => !eligibleIds.has(id));
  if (missingIds.length > 0) {
    return {
      claims: [],
      blockingClaims: missingIds.map((id) => ({
        claimId: id,
        state: 'NOT_VERIFIED' as const,
        reasonCode: 'evaluation_unavailable' as const,
        registryCode: mapEnforcementReasonToRegistryCode('evaluation_unavailable'),
      })),
      satisfied: false,
      decisionKind: 'evaluation_unavailable',
      reasonCode: 'evaluation_unavailable',
      reason:
        'Certificate-authorized critical plan claim(s) have no persisted ProofGraph evaluation.',
      uncoveredTriggers: [],
    };
  }

  if (input.riskAssessmentStale === true) {
    return {
      claims: [],
      blockingClaims: [],
      satisfied: false,
      decisionKind: 'risk_assessment_stale',
      reasonCode: 'risk_assessment_stale',
      reason:
        'The implementation risk assessment is missing, stale, or predates trigger classification.',
      uncoveredTriggers: [],
    };
  }

  // Authority invariant: zero eligible claims + specific triggers → a critical
  // fact claim is required. Zero claims + no triggers → clear (satisfied).
  if (eligibleClaims.length === 0 && triggers.length > 0) {
    return {
      claims: [],
      blockingClaims: [],
      satisfied: false,
      decisionKind: 'critical_fact_required',
      reasonCode: 'critical_fact_required',
      reason:
        'A critical, certificate-authorized fact claim is required for the current risk triggers.',
      uncoveredTriggers: [],
    };
  }

  // Coverage invariant: every detected specific trigger must be explicitly
  // covered by an eligible claim. Coverage is declared, never inferred.
  const uncovered = uncoveredRiskTriggers(input, eligibleClaims);
  if (uncovered.length > 0) {
    return {
      claims: [],
      blockingClaims: [],
      satisfied: false,
      decisionKind: 'risk_trigger_uncovered',
      reasonCode: 'risk_trigger_uncovered',
      reason: `Risk trigger(s) have no certificate-authorized critical claim coverage: ${uncovered.join(', ')}.`,
      uncoveredTriggers: uncovered,
    };
  }

  return null;
}

export function computeProofGraphEnforcement(
  input: ComputeEnforcementInput,
): ProofGraphEnforcement {
  const eligibleClaims = (input.projection?.claims ?? []).filter(isGateEligible);
  const precondition = evaluatePreconditions(input, eligibleClaims);
  if (precondition) return precondition;

  const claims: ClaimEnforcementState[] = [];
  const blockingClaims: BlockingClaim[] = [];
  let satisfied = true;

  for (const claim of eligibleClaims) {
    const reasonCodes = claimReasonCodes(claim, input.claimDiagnostics);
    const registryCode = primaryRegistryCode(
      reasonCodes,
      input.claimDiagnostics?.get(claim.claimId),
    );
    claims.push({
      claimId: claim.claimId,
      statement: claim.statement,
      critical: claim.critical,
      signalClass: claim.signalClass,
      gateEligible: true,
      verificationState: claim.verificationState,
      reasonCodes,
      registryCode,
    });

    if (claim.verificationState !== 'PROVEN') {
      satisfied = false;
      const bs = blockingStateFor(claim.verificationState);
      if (bs) {
        blockingClaims.push({
          claimId: claim.claimId,
          state: bs,
          reasonCode: primaryReason(reasonCodes),
          registryCode,
        });
      }
    }
  }

  const reasonCode: EnforcementReasonCode = satisfied ? 'proven' : 'evidence_unproven';
  return {
    claims,
    blockingClaims,
    satisfied,
    decisionKind: satisfied ? 'clear' : 'facts_unproven',
    reasonCode,
    reason: satisfied
      ? 'All critical fact claims are PROVEN.'
      : `${blockingClaims.length} critical fact claim(s) are not PROVEN.`,
    uncoveredTriggers: [],
  };
}
