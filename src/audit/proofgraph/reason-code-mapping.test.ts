/**
 * @module audit/proofgraph/reason-code-mapping.test
 * @description Tests for enforcement and binding reason code mapping.
 */

import { describe, expect, it } from 'vitest';
import {
  mapEnforcementReasonToRegistryCode,
  mapBindingReasonToRegistryCode,
} from './reason-code-mapping.js';

describe('mapEnforcementReasonToRegistryCode', () => {
  it('counterexample_observed → PROOFGRAPH_COUNTEREXAMPLE_OBSERVED', () => {
    expect(mapEnforcementReasonToRegistryCode('counterexample_observed')).toBe(
      'PROOFGRAPH_COUNTEREXAMPLE_OBSERVED',
    );
  });

  it('evidence_stale → PROOFGRAPH_EVIDENCE_STALE', () => {
    expect(mapEnforcementReasonToRegistryCode('evidence_stale')).toBe('PROOFGRAPH_EVIDENCE_STALE');
  });

  it('evidence_unproven → PROOFGRAPH_CRITICAL_FACTS_UNPROVEN', () => {
    expect(mapEnforcementReasonToRegistryCode('evidence_unproven')).toBe(
      'PROOFGRAPH_CRITICAL_FACTS_UNPROVEN',
    );
  });

  it('risk_assessment_stale → PROOFGRAPH_RISK_ASSESSMENT_STALE', () => {
    expect(mapEnforcementReasonToRegistryCode('risk_assessment_stale')).toBe(
      'PROOFGRAPH_RISK_ASSESSMENT_STALE',
    );
  });

  it('certificate_invalid → PROOFGRAPH_CERTIFICATE_INVALID', () => {
    expect(mapEnforcementReasonToRegistryCode('certificate_invalid')).toBe(
      'PROOFGRAPH_CERTIFICATE_INVALID',
    );
  });

  it('critical_fact_required → PROOFGRAPH_CRITICAL_FACT_REQUIRED', () => {
    expect(mapEnforcementReasonToRegistryCode('critical_fact_required')).toBe(
      'PROOFGRAPH_CRITICAL_FACT_REQUIRED',
    );
  });

  it('every enforcement code maps to a defined value', () => {
    const codes: Parameters<typeof mapEnforcementReasonToRegistryCode>[0][] = [
      'proven',
      'counterexample_observed',
      'evidence_missing',
      'evidence_stale',
      'evidence_unproven',
      'provider_execution_error',
      'provenance_missing',
      'evaluation_unavailable',
      'risk_assessment_stale',
      'certificate_invalid',
      'critical_fact_required',
    ];
    for (const code of codes) {
      expect(mapEnforcementReasonToRegistryCode(code)).toBeTruthy();
    }
  });
});

describe('mapBindingReasonToRegistryCode', () => {
  it('check_only_evidence → PROOFGRAPH_ASSERTION_BINDING_UNAVAILABLE', () => {
    expect(mapBindingReasonToRegistryCode('check_only_evidence')).toBe(
      'PROOFGRAPH_ASSERTION_BINDING_UNAVAILABLE',
    );
  });

  it('provider_mismatch → PROOFGRAPH_ASSERTION_PROVIDER_MISMATCH', () => {
    expect(mapBindingReasonToRegistryCode('provider_mismatch')).toBe(
      'PROOFGRAPH_ASSERTION_PROVIDER_MISMATCH',
    );
  });

  it('assertion_mismatch → PROOFGRAPH_ASSERTION_IDENTITY_MISMATCH', () => {
    expect(mapBindingReasonToRegistryCode('assertion_mismatch')).toBe(
      'PROOFGRAPH_ASSERTION_IDENTITY_MISMATCH',
    );
  });

  it('check_mismatch → PROOFGRAPH_ASSERTION_EVIDENCE_MISSING', () => {
    expect(mapBindingReasonToRegistryCode('check_mismatch')).toBe(
      'PROOFGRAPH_ASSERTION_EVIDENCE_MISSING',
    );
  });
});
