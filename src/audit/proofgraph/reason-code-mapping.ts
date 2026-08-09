/**
 * @module audit/proofgraph/reason-code-mapping
 * @description Single mapping authority from enforcement/binding reason codes
 * to registered BlockedReason codes for ProofGraph governance decisions.
 *
 * Both gate and status consume this mapping — no ad-hoc string projection.
 *
 * @version v2
 */

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
  | 'critical_fact_required'
  | 'aggregate_check_mismatch'
  | 'aggregate_candidate_mismatch'
  | 'aggregate_scope_unattested'
  | 'aggregate_extraction_missing'
  | 'aggregate_capability_missing'
  | 'provider_mismatch'
  | 'assertion_mismatch'
  | 'check_mismatch'
  | 'check_only_evidence';

/** Maps enforcement reason codes to registry BlockedReason codes. */
export function mapEnforcementReasonToRegistryCode(reasonCode: EnforcementReasonCode): string {
  return ENFORCEMENT_REGISTRY_MAP[reasonCode] ?? 'PROOFGRAPH_ASSERTION_EVIDENCE_MISSING';
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
  critical_fact_required: 'PROOFGRAPH_CRITICAL_FACT_REQUIRED',
  aggregate_check_mismatch: 'PROOFGRAPH_AGGREGATE_CHECK_MISMATCH',
  aggregate_candidate_mismatch: 'PROOFGRAPH_AGGREGATE_CHECK_MISMATCH',
  aggregate_scope_unattested: 'PROOFGRAPH_AGGREGATE_SCOPE_UNATTESTED',
  aggregate_extraction_missing: 'PROOFGRAPH_AGGREGATE_EXTRACTION_MISSING',
  aggregate_capability_missing: 'PROOFGRAPH_AGGREGATE_CAPABILITY_MISSING',
  provider_mismatch: 'PROOFGRAPH_ASSERTION_PROVIDER_MISMATCH',
  assertion_mismatch: 'PROOFGRAPH_ASSERTION_IDENTITY_MISMATCH',
  check_mismatch: 'PROOFGRAPH_ASSERTION_EVIDENCE_MISSING',
  check_only_evidence: 'PROOFGRAPH_ASSERTION_BINDING_UNAVAILABLE',
};

/** Assertion binding reason codes emitted by the binding projection. */
import type { AssertionBindingReasonCode } from '../../state/proofgraph.js';
export type { AssertionBindingReasonCode };

/**
 * ProofGraph gate decision kinds, projected by computeProofGraphEnforcement.
 * Owned here (with the gate→registry mapping authority) and re-exported by
 * enforcement-projection.ts for consumers, mirroring `EnforcementReasonCode`.
 */
export type EnforcementDecisionKind =
  | 'clear'
  | 'evaluation_unavailable'
  | 'risk_assessment_stale'
  | 'certificate_invalid'
  | 'critical_fact_required'
  | 'facts_unproven';

/**
 * Maps a ProofGraph gate decision kind to its registered BlockedReason code.
 * `clear` is not a gated outcome and maps to null (no registry code).
 * Single authority shared by the review-decision rail and the status surface.
 */
export function mapGateKindToRegistryCode(kind: EnforcementDecisionKind): string | null {
  return GATE_KIND_REGISTRY_MAP[kind] ?? null;
}

const GATE_KIND_REGISTRY_MAP: Partial<Record<EnforcementDecisionKind, string>> = {
  evaluation_unavailable: 'PROOFGRAPH_EVALUATION_UNAVAILABLE',
  risk_assessment_stale: 'PROOFGRAPH_RISK_ASSESSMENT_STALE',
  certificate_invalid: 'PROOFGRAPH_CERTIFICATE_INVALID',
  critical_fact_required: 'PROOFGRAPH_CRITICAL_FACT_REQUIRED',
  facts_unproven: 'PROOFGRAPH_CRITICAL_FACTS_UNPROVEN',
};

export function mapBindingReasonToRegistryCode(reasonCode: AssertionBindingReasonCode): string {
  switch (reasonCode) {
    case 'check_mismatch':
      return 'PROOFGRAPH_ASSERTION_EVIDENCE_MISSING';
    case 'evidence_missing':
      return 'PROOFGRAPH_ASSERTION_EVIDENCE_MISSING';
    case 'check_only_evidence':
      return 'PROOFGRAPH_ASSERTION_BINDING_UNAVAILABLE';
    case 'provider_mismatch':
      return 'PROOFGRAPH_ASSERTION_PROVIDER_MISMATCH';
    case 'assertion_mismatch':
      return 'PROOFGRAPH_ASSERTION_IDENTITY_MISMATCH';
    case 'aggregate_check_mismatch':
      return 'PROOFGRAPH_AGGREGATE_CHECK_MISMATCH';
    case 'aggregate_candidate_mismatch':
      return 'PROOFGRAPH_AGGREGATE_CHECK_MISMATCH';
    case 'aggregate_scope_unattested':
      return 'PROOFGRAPH_AGGREGATE_SCOPE_UNATTESTED';
    case 'aggregate_extraction_missing':
      return 'PROOFGRAPH_AGGREGATE_EXTRACTION_MISSING';
    case 'aggregate_capability_missing':
      return 'PROOFGRAPH_AGGREGATE_CAPABILITY_MISSING';
  }
}
