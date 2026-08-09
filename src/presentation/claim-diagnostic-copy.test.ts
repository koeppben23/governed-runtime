import { describe, it, expect } from 'vitest';
import { BINDING_DIAGNOSTIC_COPY } from './claim-diagnostic-copy.js';
import { AssertionBindingReasonCodeSchema } from '../state/proofgraph.js';

describe('claim-diagnostic-copy', () => {
  it('exhaustively covers every AssertionBindingReasonCode member', () => {
    const codes = AssertionBindingReasonCodeSchema.options;
    const covered = Object.keys(BINDING_DIAGNOSTIC_COPY);
    expect(covered.sort()).toEqual([...codes].sort());
  });

  it('every code has non-empty headline and explanation', () => {
    const codes = AssertionBindingReasonCodeSchema.options;
    for (const code of codes) {
      const entry = BINDING_DIAGNOSTIC_COPY[code];
      expect(entry, `${code} missing`).toBeTruthy();
      expect(entry.headline.length, `${code} headline empty`).toBeGreaterThan(0);
      expect(entry.explanation.length, `${code} explanation empty`).toBeGreaterThan(0);
    }
  });

  it('aggregate_scope_unattested produces the expected explanation', () => {
    const entry = BINDING_DIAGNOSTIC_COPY.aggregate_scope_unattested;
    expect(entry.explanation).toContain('complete-check evidence');
    expect(entry.explanation).toContain('execution scope');
  });

  it('evidence_missing produces the expected explanation', () => {
    const entry = BINDING_DIAGNOSTIC_COPY.evidence_missing;
    expect(entry.explanation).toContain('Compatible assertion evidence');
  });

  it('provider_mismatch produces the expected explanation', () => {
    const entry = BINDING_DIAGNOSTIC_COPY.provider_mismatch;
    expect(entry.explanation).toContain('different provider');
  });
});
