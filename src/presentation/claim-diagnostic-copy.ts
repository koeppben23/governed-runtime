/**
 * @module presentation/claim-diagnostic-copy
 * @description Single authority for human copy per AssertionBindingReasonCode.
 *
 * Exhaustive, compiler-enforced mapping: adding a new binding diagnostic code
 * to the domain forces a presentation-layer decision. No renderer may define
 * its own `AssertionBindingReasonCode -> prose` map (enforced by the
 * architecture SSOT guard).
 *
 * @version v1
 */

import type { AssertionBindingReasonCode } from '../state/proofgraph.js';

export interface BindingDiagnosticCopy {
  readonly headline: string;
  readonly explanation: string;
}

export const BINDING_DIAGNOSTIC_COPY: Readonly<
  Record<AssertionBindingReasonCode, BindingDiagnosticCopy>
> = {
  check_mismatch: {
    headline: 'Check mismatch',
    explanation: 'The evidence check does not match the check required by this claim.',
  },
  evidence_missing: {
    headline: 'Evidence missing',
    explanation: 'Compatible assertion evidence required by this claim is missing.',
  },
  check_only_evidence: {
    headline: 'Check-only evidence',
    explanation:
      'The check only provides check-level evidence, but this claim requires assertion-level evidence.',
  },
  provider_mismatch: {
    headline: 'Provider mismatch',
    explanation: 'Evidence was produced by a different provider than the claim requires.',
  },
  assertion_mismatch: {
    headline: 'Assertion mismatch',
    explanation: 'The executed assertion does not match the required assertion for this claim.',
  },
  aggregate_check_mismatch: {
    headline: 'Check mismatch',
    explanation: 'The executed check does not match the aggregate check required by this claim.',
  },
  aggregate_candidate_mismatch: {
    headline: 'Candidate mismatch',
    explanation: 'The evidence was produced by a different candidate than the claim requires.',
  },
  aggregate_scope_unattested: {
    headline: 'Scope unattested',
    explanation:
      'This suite-level claim requires complete-check evidence, but full execution scope could not be confirmed.',
  },
  aggregate_extraction_missing: {
    headline: 'Extraction missing',
    explanation: 'No structured aggregate evidence could be extracted from the check result.',
  },
  aggregate_capability_missing: {
    headline: 'Capability missing',
    explanation: 'The check does not support aggregate evidence extraction required by this claim.',
  },
};
