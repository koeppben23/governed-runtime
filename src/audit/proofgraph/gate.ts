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
import type { ProofGraphProjection } from '../../state/proofgraph.js';
import type { RiskTrigger } from '../../state/schema.js';
import type { AssertionBindingReasonCode } from './assertion-evidence-binding.js';
import {
  computeProofGraphEnforcement,
  type EnforcementDecisionKind,
  type EnforcementReasonCode,
  type BlockingClaim,
} from './enforcement-projection.js';

function readDiagnosticsFromProjection(
  projection?: ProofGraphProjection,
): ReadonlyMap<string, AssertionBindingReasonCode> | undefined {
  if (!projection?.claimDiagnostics) return undefined;
  const map = new Map<string, AssertionBindingReasonCode>();
  for (const [key, value] of Object.entries(projection.claimDiagnostics)) {
    if (isValidBindingCode(value)) {
      map.set(key, value);
    }
  }
  return map.size > 0 ? map : undefined;
}

function isValidBindingCode(value: string): value is AssertionBindingReasonCode {
  return (
    value === 'check_mismatch' ||
    value === 'evidence_missing' ||
    value === 'check_only_evidence' ||
    value === 'provider_mismatch' ||
    value === 'assertion_mismatch' ||
    value === 'aggregate_check_mismatch' ||
    value === 'aggregate_candidate_mismatch' ||
    value === 'aggregate_scope_unattested' ||
    value === 'aggregate_extraction_missing' ||
    value === 'aggregate_capability_missing'
  );
}

/** The evaluated ProofGraph gate decision. */
export interface ProofGraphGateDecision {
  readonly gated: boolean;
  readonly blockingClaimIds: readonly string[];
  /** Per-claim blocking details with typed reason codes. */
  readonly blockingClaims: readonly BlockingClaim[];
  /** Enforcement reason code for the gate decision. */
  readonly reasonCode: EnforcementReasonCode;
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
  readonly certificateValid?: boolean;
  readonly implementationDigest?: string;
  readonly riskAssessment?: ImplementationRiskAssessmentForGate;
  /** Per-claim binding diagnostics for enforcement surface. */
  readonly claimDiagnostics?: ReadonlyMap<string, AssertionBindingReasonCode>;
}): ProofGraphGateDecision {
  const triggers = relevantTriggers(input.riskAssessment);

  const riskStale =
    input.riskAssessment !== undefined &&
    input.implementationDigest !== undefined &&
    !isRiskAssessmentCurrent(input.riskAssessment, input.implementationDigest);

  const enforcement = computeProofGraphEnforcement({
    projection: input.projection,
    authorizedCriticalClaimIds: input.authorizedCriticalClaimIds,
    certificateValid: input.certificateValid,
    implementationDigest: input.implementationDigest,
    riskAssessmentStale: riskStale,
    riskTriggersPresent: triggers.length > 0,
    claimDiagnostics: input.claimDiagnostics ?? readDiagnosticsFromProjection(input.projection),
  });

  return {
    gated: !enforcement.satisfied,
    blockingClaimIds: enforcement.blockingClaims.map((b) => b.claimId),
    blockingClaims: enforcement.blockingClaims,
    reasonCode: enforcement.reasonCode,
    reason: enforcement.reason,
    kind: enforcement.decisionKind,
    relevantTriggers: triggers,
  };
}
