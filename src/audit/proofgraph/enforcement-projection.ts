/**
 * @module audit/proofgraph/enforcement-projection
 * @description Centralized ProofGraph enforcement projection.
 *
 * Single source of truth for claim verification decisions. Both the gate
 * (`evaluateProofGraphGate`) and `flowguard_status` consume this projection
 * — no duplicate traversal, no second interpretation of claims.
 *
 * Pure function: no side effects, no state access, deterministic.
 *
 * @version v1
 */

import type { ProofGraphSummary } from './summary.js';
import type { ProofClaim } from '../../state/proofgraph.js';
import type { ClaimVerificationState, Freshness } from '../../state/proofgraph-primitives.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ClaimEnforcementState {
  readonly claimId: string;
  readonly statement: string;
  readonly critical: boolean;
  readonly signalClass: string;
  readonly gateEligible: boolean;
  readonly verificationState: ClaimVerificationState;
  readonly freshness?: Freshness;
  readonly reasons: readonly string[];
}

export interface BlockingClaim {
  readonly claimId: string;
  readonly state: 'CONTRADICTED' | 'NOT_VERIFIED' | 'STALE' | 'BLOCKED' | 'UNPROVEN';
  readonly reason: string;
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
  readonly reason: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isGateEligible(claim: ProofClaim): boolean {
  if (!claim.critical || claim.signalClass !== 'fact') return false;
  return (
    claim.provenance?.kind === 'canonical_authority' && claim.provenance.approval !== undefined
  );
}

function claimReasons(claim: ProofClaim): string[] {
  const reasons: string[] = [];
  if (!claim.provenance) {
    reasons.push('provenance_missing');
  } else if (claim.verificationState === 'NOT_VERIFIED') {
    reasons.push('evidence_not_verified');
  } else if (claim.verificationState === 'STALE') {
    reasons.push('evidence_stale');
  } else if (claim.verificationState === 'CONTRADICTED') {
    reasons.push('counterexample_observed');
  } else if (claim.verificationState === 'BLOCKED') {
    reasons.push('provider_execution_error');
  } else if (claim.verificationState === 'UNPROVEN') {
    reasons.push('evidence_unproven');
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
        reason: 'evaluation_unavailable',
      })),
      satisfied: false,
      decisionKind: 'evaluation_unavailable',
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
    const reasons = claimReasons(claim);
    claims.push({
      claimId: claim.claimId,
      statement: claim.statement,
      critical: claim.critical,
      signalClass: claim.signalClass,
      gateEligible: true,
      verificationState: claim.verificationState,
      freshness: claim.freshness,
      reasons,
    });

    if (claim.verificationState !== 'PROVEN') {
      satisfied = false;
      const bs = blockingStateFor(claim.verificationState);
      if (bs) {
        blockingClaims.push({ claimId: claim.claimId, state: bs, reason: reasons.join('; ') });
      }
    }
  }

  return {
    claims,
    blockingClaims,
    satisfied,
    decisionKind: satisfied ? 'clear' : 'facts_unproven',
    reason: satisfied
      ? 'All critical fact claims are PROVEN.'
      : `${blockingClaims.length} critical fact claim(s) are not PROVEN.`,
  };
}
