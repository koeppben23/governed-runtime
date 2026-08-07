/**
 * @module audit/proofgraph/reason-code-mapping
 * @description Single mapping authority from enforcement/binding reason codes
 * to registered BlockedReason codes for ProofGraph governance decisions.
 *
 * Both gate and status consume this mapping — no ad-hoc string projection.
 *
 * @version v1
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
  | 'critical_fact_required';

/** Maps enforcement reason codes to registry BlockedReason codes. */
export function mapEnforcementReasonToRegistryCode(reasonCode: EnforcementReasonCode): string {
  switch (reasonCode) {
    case 'proven':
      return 'PROOFGRAPH_EVIDENCE_PROVEN';
    case 'counterexample_observed':
      return 'PROOFGRAPH_COUNTEREXAMPLE_OBSERVED';
    case 'evidence_missing':
      return 'PROOFGRAPH_ASSERTION_EVIDENCE_MISSING';
    case 'evidence_stale':
      return 'PROOFGRAPH_EVIDENCE_STALE';
    case 'evidence_unproven':
      return 'PROOFGRAPH_CRITICAL_FACTS_UNPROVEN';
    case 'provider_execution_error':
      return 'PROOFGRAPH_PROVIDER_EXECUTION_ERROR';
    case 'provenance_missing':
      return 'PROOFGRAPH_ASSERTION_EVIDENCE_MISSING';
    case 'evaluation_unavailable':
      return 'PROOFGRAPH_EVALUATION_UNAVAILABLE';
    case 'risk_assessment_stale':
      return 'PROOFGRAPH_RISK_ASSESSMENT_STALE';
    case 'critical_fact_required':
      return 'PROOFGRAPH_CRITICAL_FACT_REQUIRED';
  }
}

/** Maps AssertionBindingReasonCode to registry BlockedReason codes. */
import type { AssertionBindingReasonCode } from '../../state/proofgraph.js';
export type { AssertionBindingReasonCode };

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
  }
}
