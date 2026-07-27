import { describe, it, expect } from 'vitest';

import { makeState, VALIDATION_PASSED, IMPL_EVIDENCE } from '../../fixtures.js';
import { implValidationEvidenceGate } from './implement-review.js';

// Gap 3 — defense-in-depth: reviewer acceptance must not advance to
// EVIDENCE_REVIEW unless the active verification checks have passing execution
// evidence for the current implementation. The gate reuses the canonical
// machine guard (implValidationPassed) so it cannot drift from the topology gate.

function parseCode(result: string): string {
  return (JSON.parse(result) as { code: string }).code;
}

describe('implValidationEvidenceGate', () => {
  it('passes when every active check has passing implValidation evidence', () => {
    // makeState default activeChecks = ['test','lint']; VALIDATION_PASSED covers both.
    const state = makeState('IMPL_REVIEW', {
      implementation: IMPL_EVIDENCE,
      implValidation: VALIDATION_PASSED,
    });
    expect(implValidationEvidenceGate(state)).toBeNull();
  });

  it('blocks when implValidation is empty but active checks exist', () => {
    const state = makeState('IMPL_REVIEW', {
      implementation: IMPL_EVIDENCE,
      implValidation: [],
    });
    const result = implValidationEvidenceGate(state);
    expect(result).not.toBeNull();
    expect(parseCode(result!)).toBe('IMPL_VALIDATION_EVIDENCE_REQUIRED');
    // The block names exactly the unsatisfied checks.
    expect(result!).toContain('test');
    expect(result!).toContain('lint');
  });

  it('blocks when only some active checks have passing evidence', () => {
    const state = makeState('IMPL_REVIEW', {
      implementation: IMPL_EVIDENCE,
      implValidation: [VALIDATION_PASSED[0]!], // only 'test' passes; 'lint' missing
    });
    const result = implValidationEvidenceGate(state);
    expect(result).not.toBeNull();
    expect(parseCode(result!)).toBe('IMPL_VALIDATION_EVIDENCE_REQUIRED');
    expect(result!).toContain('lint');
    expect(result!).not.toContain('test,'); // 'test' is satisfied, not listed as missing
  });

  it('blocks when an active check has failing evidence', () => {
    const state = makeState('IMPL_REVIEW', {
      implementation: IMPL_EVIDENCE,
      implValidation: [
        { ...VALIDATION_PASSED[0]!, passed: false },
        VALIDATION_PASSED[1]!,
      ],
    });
    const result = implValidationEvidenceGate(state);
    expect(result).not.toBeNull();
    expect(parseCode(result!)).toBe('IMPL_VALIDATION_EVIDENCE_REQUIRED');
    expect(result!).toContain('test');
  });

  it('passes vacuously when there are no active checks (zero-check sessions unaffected)', () => {
    // This preserves the deliberate solo/team behavior: a repo with no
    // discoverable verification commands is not forced to run checks here.
    const state = makeState('IMPL_REVIEW', {
      implementation: IMPL_EVIDENCE,
      activeChecks: [],
      implValidation: [],
    });
    expect(implValidationEvidenceGate(state)).toBeNull();
  });
});
