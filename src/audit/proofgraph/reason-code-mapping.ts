/**
 * @module audit/proofgraph/reason-code-mapping
 * @description Single mapping authority from enforcement/binding reason codes
 * to registered BlockedReason codes for ProofGraph governance decisions.
 *
 * Both gate and status consume this mapping — no ad-hoc string projection.
 *
 * @version v3
 */

/** Reason codes emitted by the enforcement projection. */
export type EnforcementReasonCode =
  | import('../../state/proofgraph.js').AssertionBindingReasonCode
  | 'proven'
  | 'counterexample_observed'
  | 'evidence_missing'
  | 'evidence_stale'
  | 'evidence_unproven'
  | 'provider_execution_error'
  | 'provenance_missing'
  | 'evaluation_unavailable'
  | 'risk_assessment_stale'
  | 'certificate_invalid'
  | 'critical_fact_required'
  | 'risk_trigger_uncovered';

/** Maps enforcement reason codes to registry BlockedReason codes. */
export function mapEnforcementReasonToRegistryCode(reasonCode: EnforcementReasonCode): string {
  return ENFORCEMENT_REGISTRY_MAP[reasonCode];
}

const ENFORCEMENT_REGISTRY_MAP: Record<EnforcementReasonCode, string> = {
  proven: 'PROOFGRAPH_EVIDENCE_PROVEN',
  counterexample_observed: 'PROOFGRAPH_COUNTEREXAMPLE_OBSERVED',
  evidence_missing: 'PROOFGRAPH_ASSERTION_EVIDENCE_MISSING',
  evidence_stale: 'PROOFGRAPH_EVIDENCE_STALE',
  evidence_unproven: 'PROOFGRAPH_CRITICAL_FACTS_UNPROVEN',
  provider_execution_error: 'PROOFGRAPH_PROVIDER_EXECUTION_ERROR',
  provenance_missing: 'PROOFGRAPH_ASSERTION_EVIDENCE_MISSING',
  evaluation_unavailable: 'PROOFGRAPH_EVALUATION_UNAVAILABLE',
  risk_assessment_stale: 'PROOFGRAPH_RISK_ASSESSMENT_STALE',
  certificate_invalid: 'PROOFGRAPH_CERTIFICATE_INVALID',
  critical_fact_required: 'PROOFGRAPH_CRITICAL_FACT_REQUIRED',
  risk_trigger_uncovered: 'PROOFGRAPH_RISK_TRIGGER_UNCOVERED',
  aggregate_check_mismatch: 'PROOFGRAPH_AGGREGATE_CHECK_MISMATCH',
  aggregate_candidate_mismatch: 'PROOFGRAPH_AGGREGATE_CHECK_MISMATCH',
  aggregate_scope_unattested: 'PROOFGRAPH_AGGREGATE_SCOPE_UNATTESTED',
  aggregate_extraction_missing: 'PROOFGRAPH_AGGREGATE_EXTRACTION_MISSING',
  aggregate_capability_missing: 'PROOFGRAPH_AGGREGATE_CAPABILITY_MISSING',
  provider_mismatch: 'PROOFGRAPH_ASSERTION_PROVIDER_MISMATCH',
  assertion_mismatch: 'PROOFGRAPH_ASSERTION_IDENTITY_MISMATCH',
  assertion_identity_ambiguous: 'PROOFGRAPH_ASSERTION_IDENTITY_AMBIGUOUS',
  check_mismatch: 'PROOFGRAPH_ASSERTION_EVIDENCE_MISSING',
  check_only_evidence: 'PROOFGRAPH_ASSERTION_BINDING_UNAVAILABLE',
  evidence_role_collision: 'PROOFGRAPH_EVIDENCE_ROLE_COLLISION',
};
/** Assertion binding reason codes emitted by the binding projection. */
import type { AssertionBindingReasonCode } from '../../state/proofgraph.js';
export type { AssertionBindingReasonCode };

export function mapBindingReasonToRegistryCode(reasonCode: AssertionBindingReasonCode): string {
  return mapEnforcementReasonToRegistryCode(reasonCode);
}
