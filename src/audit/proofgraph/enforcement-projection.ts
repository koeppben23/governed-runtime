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
 * @version v1
 */

import type { ProofGraphSummary } from './summary.js';
import type { ProofClaim } from '../../state/proofgraph.js';
import type { ClaimVerificationState } from '../../state/proofgraph-primitives.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Reason codes emitted by the enforcement projection. */
export type EnforcementReasonCode =
  | 'proven'
  | 'counterexample_observed'
  | 'evidence_missing'
  | 'evidence_stale'
  | 'evidence_unproven'
  | 'provider_execution_error'
  | 'provenance_missing'
  | 'evaluation_unavailable'
  | 'risk_assessment_stale'
  | 'critical_fact_required';

export interface ClaimEnforcementState {
  readonly claimId: string;
  readonly statement: string;
  readonly critical: boolean;
  readonly signalClass: string;
  readonly gateEligible: boolean;
  readonly verificationState: ClaimVerificationState;
  readonly reasonCodes: readonly EnforcementReasonCode[];
}

export interface BlockingClaim {
  readonly claimId: string;
  readonly state: 'CONTRADICTED' | 'NOT_VERIFIED' | 'STALE' | 'BLOCKED' | 'UNPROVEN';
  readonly reasonCode: EnforcementReasonCode;
}

export type EnforcementDecisionKind =
  | 'clear'
  | 'evaluation_unavailable'
  | 'risk_assessment_stale'
  | 'critical_fact_required'
  | 'facts_unproven';

export interface ProofGraphEnforcement {
  readonly claims: readonly ClaimEnforcementState[];
  readonly blockingClaims: readonly BlockingClaim[];
  readonly satisfied: boolean;
  readonly decisionKind: EnforcementDecisionKind;
  readonly reasonCode: EnforcementReasonCode;
  readonly reason: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isGateEligible(claim: ProofClaim): boolean {
  if (!claim.critical || claim.signalClass !== 'fact') return false;
  return (
    claim.provenance?.kind === 'canonical_authority' && claim.provenance.approval !== undefined
  );
}

function claimReasonCodes(claim: ProofClaim): EnforcementReasonCode[] {
  const reasons: EnforcementReasonCode[] = [];
  if (!claim.provenance) {
    reasons.push('provenance_missing');
  }
  switch (claim.verificationState) {
    case 'PROVEN':
      reasons.push('proven');
      break;
    case 'CONTRADICTED':
      reasons.push('counterexample_observed');
      break;
    case 'NOT_VERIFIED':
      reasons.push('evidence_missing');
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
  readonly implementationDigest?: string;
  readonly riskAssessmentActive?: boolean;
  readonly riskTriggersPresent?: boolean;
}

function evaluatePreconditions(
  input: ComputeEnforcementInput,
  eligibleClaims: readonly ProofClaim[],
): ProofGraphEnforcement | null {
  const eligibleIds = new Set(eligibleClaims.map((c) => c.claimId));
  const missingIds = (input.authorizedCriticalClaimIds ?? []).filter((id) => !eligibleIds.has(id));
  if (missingIds.length > 0) {
    return {
      claims: [],
      blockingClaims: missingIds.map((id) => ({
        claimId: id,
        state: 'NOT_VERIFIED' as const,
        reasonCode: 'evaluation_unavailable' as const,
      })),
      satisfied: false,
      decisionKind: 'evaluation_unavailable',
      reasonCode: 'evaluation_unavailable',
      reason:
        'Certificate-authorized critical plan claim(s) have no persisted ProofGraph evaluation.',
    };
  }

  if (input.riskAssessmentActive === true) {
    return {
      claims: [],
      blockingClaims: [],
      satisfied: false,
      decisionKind: 'risk_assessment_stale',
      reasonCode: 'risk_assessment_stale',
      reason:
        'The implementation risk assessment is missing, stale, or predates trigger classification.',
    };
  }

  if (eligibleClaims.length === 0 && input.riskTriggersPresent === true) {
    return {
      claims: [],
      blockingClaims: [],
      satisfied: false,
      decisionKind: 'critical_fact_required',
      reasonCode: 'critical_fact_required',
      reason:
        'A critical, certificate-authorized fact claim is required for the current risk triggers.',
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
    const reasonCodes = claimReasonCodes(claim);
    claims.push({
      claimId: claim.claimId,
      statement: claim.statement,
      critical: claim.critical,
      signalClass: claim.signalClass,
      gateEligible: true,
      verificationState: claim.verificationState,
      reasonCodes,
    });

    if (claim.verificationState !== 'PROVEN') {
      satisfied = false;
      const bs = blockingStateFor(claim.verificationState);
      if (bs) {
        blockingClaims.push({
          claimId: claim.claimId,
          state: bs,
          reasonCode: primaryReason(reasonCodes),
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
  };
}
