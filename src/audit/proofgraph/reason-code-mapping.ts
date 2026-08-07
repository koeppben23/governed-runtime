/**
 * @module audit/proofgraph/reason-code-mapping
 * @description Single mapping authority from EnforcementReasonCode to
 * registered BlockedReason codes for ProofGraph governance decisions.
 *
 * Both gate and status consume this mapping — no ad-hoc string projection.
 *
 * @version v1
 */

import type { EnforcementReasonCode } from './enforcement-projection.js';

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
export type AssertionBindingReasonCode =
  | 'check_mismatch'
  | 'evidence_missing'
  | 'check_only_evidence'
  | 'provider_mismatch'
  | 'assertion_mismatch';

export function mapBindingReasonToRegistryCode(reasonCode: AssertionBindingReasonCode): string {
  switch (reasonCode) {
    case 'check_mismatch':
      return 'PROOFGRAPH_ASSERTION_IDENTITY_MISMATCH';
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
