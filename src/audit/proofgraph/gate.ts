/**
 * @module audit/proofgraph/gate
 * @description Pure ProofGraph gate decision.
 *
 * Encodes the gating invariants without touching workflow transitions: only
 * critical, evidence-backed `fact` claims are gate-eligible. `derived_signal`
 * and `hypothesis` claims are never gate-eligible — they remain advisory.
 *
 * The decision is computed and surfaced; it does not itself block a governed
 * transition.
 *
 * Gate now delegates to computeProofGraphEnforcement() as the single source
 * of truth — no duplicate traversal or second interpretation of claims.
 *
 * @version v2 — enforcement-projection is SSOT
 */

import type { ProofGraphSummary } from './summary.js';
import type { RiskTrigger } from '../../state/schema.js';
import {
  computeProofGraphEnforcement,
  type EnforcementDecisionKind,
} from './enforcement-projection.js';

/** The evaluated ProofGraph gate decision. */
export interface ProofGraphGateDecision {
  readonly enforced: true;
  readonly gated: boolean;
  readonly blockingClaimIds: readonly string[];
  readonly reason: string;
  readonly kind: EnforcementDecisionKind;
  readonly relevantTriggers: readonly Exclude<RiskTrigger, 'ceremony_only'>[];
}

export interface ImplementationRiskAssessmentForGate {
  readonly implementationDigest: string;
  readonly riskTriggers?: readonly RiskTrigger[];
}

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

export function evaluateProofGraphGate(input: {
  readonly projection?: ProofGraphSummary['projection'];
  readonly authorizedCriticalClaimIds?: readonly string[];
  readonly implementationDigest?: string;
  readonly riskAssessment?: ImplementationRiskAssessmentForGate;
}): ProofGraphGateDecision {
  const triggers = relevantTriggers(input.riskAssessment);

  const riskStale =
    input.riskAssessment !== undefined &&
    input.implementationDigest !== undefined &&
    !isRiskAssessmentCurrent(input.riskAssessment, input.implementationDigest);

  const enforcement = computeProofGraphEnforcement({
    projection: input.projection,
    authorizedCriticalClaimIds: input.authorizedCriticalClaimIds,
    implementationDigest: input.implementationDigest,
    riskAssessmentActive: riskStale,
    riskTriggersPresent: triggers.length > 0,
  });

  return {
    enforced: true,
    gated: !enforcement.satisfied,
    blockingClaimIds: enforcement.blockingClaims.map((b) => b.claimId),
    reason: enforcement.reason,
    kind: enforcement.decisionKind,
    relevantTriggers: triggers,
  };
}
