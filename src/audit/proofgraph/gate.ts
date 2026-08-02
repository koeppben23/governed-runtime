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
import type { RiskTrigger } from '../../state/schema.js';

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
  /** Why the decision gates, or `clear` when it does not. */
  readonly kind:
    | 'clear'
    | 'evaluation_unavailable'
    | 'risk_assessment_stale'
    | 'critical_fact_required'
    | 'facts_unproven';
  /** Specific persisted authority triggers relevant to the requirement. */
  readonly relevantTriggers: readonly Exclude<RiskTrigger, 'ceremony_only'>[];
}

export interface ImplementationRiskAssessmentForGate {
  readonly implementationDigest: string;
  readonly riskTriggers?: readonly RiskTrigger[];
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

/** A gate may use only an assessment bound to this implementation and trigger taxonomy. */
export function isRiskAssessmentCurrent(
  assessment: ImplementationRiskAssessmentForGate | undefined,
  implementationDigest: string | undefined,
): boolean {
  return (
    assessment !== undefined &&
    implementationDigest !== undefined &&
    assessment.implementationDigest === implementationDigest &&
    Array.isArray(assessment.riskTriggers)
  );
}

function relevantTriggers(
  assessment: ImplementationRiskAssessmentForGate | undefined,
): readonly Exclude<RiskTrigger, 'ceremony_only'>[] {
  return (assessment?.riskTriggers ?? []).filter(
    (trigger): trigger is Exclude<RiskTrigger, 'ceremony_only'> => trigger !== 'ceremony_only',
  );
}

/**
 * Evaluate the ProofGraph gate for a session summary.
 *
 * @param summary The session's ProofGraph summary.
 */
export function evaluateProofGraphGate(input: {
  readonly projection?: ProofGraphSummary['projection'];
  /** Critical plan claims independently authorized by the current certificate. */
  readonly authorizedCriticalClaimIds?: readonly string[];
  readonly implementationDigest?: string;
  readonly riskAssessment?: ImplementationRiskAssessmentForGate;
}): ProofGraphGateDecision {
  const triggers = relevantTriggers(input.riskAssessment);
  const eligibleClaims = (input.projection?.claims ?? []).filter(isGateEligible);
  const eligibleClaimIds = new Set(eligibleClaims.map((claim) => claim.claimId));
  const missingAuthorizedClaimIds = (input.authorizedCriticalClaimIds ?? []).filter(
    (claimId) => !eligibleClaimIds.has(claimId),
  );
  if (missingAuthorizedClaimIds.length > 0) {
    return {
      enforced: true,
      gated: true,
      blockingClaimIds: missingAuthorizedClaimIds,
      reason:
        'Certificate-authorized critical plan claim(s) have no persisted ProofGraph evaluation.',
      kind: 'evaluation_unavailable',
      relevantTriggers: triggers,
    };
  }
  // Change-1 assessments exist but lack `riskTriggers`; they are explicitly
  // superseded. Fully legacy sessions without any persisted assessment retain
  // the original claim-only gate because no classification was ever asserted.
  if (
    input.riskAssessment !== undefined &&
    input.implementationDigest !== undefined &&
    !isRiskAssessmentCurrent(input.riskAssessment, input.implementationDigest)
  ) {
    return {
      enforced: true,
      gated: true,
      blockingClaimIds: [],
      reason:
        'The implementation risk assessment is missing, stale, or predates trigger classification; record a fresh implementation assessment before approval.',
      kind: 'risk_assessment_stale',
      relevantTriggers: [],
    };
  }

  if (triggers.length > 0 && eligibleClaims.length === 0) {
    return {
      enforced: true,
      gated: true,
      blockingClaimIds: [],
      reason: `A critical, certificate-authorized fact claim is required for: ${triggers.join(', ')}.`,
      kind: 'critical_fact_required',
      relevantTriggers: triggers,
    };
  }

  const blockingClaimIds = eligibleClaims
    .filter((claim) => claim.verificationState !== 'PROVEN')
    .map((claim) => claim.claimId);
  return {
    enforced: true,
    gated: blockingClaimIds.length > 0,
    blockingClaimIds,
    reason:
      blockingClaimIds.length > 0
        ? `${blockingClaimIds.length} critical fact claim(s) are not PROVEN.`
        : 'All critical fact claims are PROVEN.',
    kind: blockingClaimIds.length > 0 ? 'facts_unproven' : 'clear',
    relevantTriggers: triggers,
  };
}
