/**
 * @module audit/proofgraph/reason-code-mapping.test
 * @description Tests for enforcement and binding reason code mapping.
 */

import { describe, expect, it } from 'vitest';
import {
  mapEnforcementReasonToRegistryCode,
  mapBindingReasonToRegistryCode,
  mapGateKindToRegistryCode,
} from './reason-code-mapping.js';
import type { EnforcementDecisionKind } from './enforcement-projection.js';

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

describe('mapGateKindToRegistryCode', () => {
  it('clear is not a gated outcome and maps to null', () => {
    expect(mapGateKindToRegistryCode('clear')).toBeNull();
  });

  it('maps each blocking decision kind to its existing registered code', () => {
    const expectations: Array<[EnforcementDecisionKind, string]> = [
      ['evaluation_unavailable', 'PROOFGRAPH_EVALUATION_UNAVAILABLE'],
      ['risk_assessment_stale', 'PROOFGRAPH_RISK_ASSESSMENT_STALE'],
      ['certificate_invalid', 'PROOFGRAPH_CERTIFICATE_INVALID'],
      ['critical_fact_required', 'PROOFGRAPH_CRITICAL_FACT_REQUIRED'],
      ['facts_unproven', 'PROOFGRAPH_CRITICAL_FACTS_UNPROVEN'],
    ];
    for (const [kind, code] of expectations) {
      expect(mapGateKindToRegistryCode(kind)).toBe(code);
    }
  });

  it('every non-clear enforcement decision kind resolves to a defined code', () => {
    const kinds: EnforcementDecisionKind[] = [
      'evaluation_unavailable',
      'risk_assessment_stale',
      'certificate_invalid',
      'critical_fact_required',
      'facts_unproven',
    ];
    for (const kind of kinds) {
      expect(mapGateKindToRegistryCode(kind)).toBeTruthy();
    }
  });
});
