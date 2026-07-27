import { describe, it, expect } from 'vitest';

import { makeState, VALIDATION_PASSED, IMPL_EVIDENCE } from '../../fixtures.js';
import { implValidationEvidenceGate } from './implement-review.js';
import type { ValidationAttempt } from '../../state/evidence-validation.js';

// Gap 3 — defense-in-depth: reviewer acceptance must not advance to
// EVIDENCE_REVIEW unless the active verification checks have PASSING execution
// evidence bound to the CURRENT implementation digest. Unlike the machine guard
// implValidationPassed (which reads the digest-less implValidation slot), this
// gate binds to state.validationAttempts by implementationDigest, so stale-digest
// evidence can never satisfy acceptance.

const CURRENT_DIGEST = IMPL_EVIDENCE.digest;

function attempt(checkId: string, passed: boolean, digest = CURRENT_DIGEST): ValidationAttempt {
  return {
    attemptId: `00000000-0000-4000-8000-0000000000${checkId === 'test' ? '01' : '02'}`,
    scope: 'implementation',
    implementationDigest: digest,
    result: { ...VALIDATION_PASSED[checkId === 'test' ? 0 : 1]!, checkId, passed },
  } as ValidationAttempt;
}

function parseCode(result: string): string {
  return (JSON.parse(result) as { code: string }).code;
}

describe('implValidationEvidenceGate', () => {
  it('passes when every active check has a passing attempt for the current digest', () => {
    // makeState default activeChecks = ['test','lint'].
    const state = makeState('IMPL_REVIEW', {
      implementation: IMPL_EVIDENCE,
      validationAttempts: [attempt('test', true), attempt('lint', true)],
    });
    expect(implValidationEvidenceGate(state)).toBeNull();
  });

  it('blocks when there are no validation attempts but active checks exist', () => {
    const state = makeState('IMPL_REVIEW', {
      implementation: IMPL_EVIDENCE,
      validationAttempts: [],
    });
    const result = implValidationEvidenceGate(state);
    expect(result).not.toBeNull();
    expect(parseCode(result!)).toBe('IMPL_VALIDATION_EVIDENCE_REQUIRED');
    expect(result!).toContain('test');
    expect(result!).toContain('lint');
  });

  it('blocks when only some active checks have passing evidence', () => {
    const state = makeState('IMPL_REVIEW', {
      implementation: IMPL_EVIDENCE,
      validationAttempts: [attempt('test', true)], // 'lint' missing
    });
    const result = implValidationEvidenceGate(state);
    expect(result).not.toBeNull();
    expect(parseCode(result!)).toBe('IMPL_VALIDATION_EVIDENCE_REQUIRED');
    expect(result!).toContain('lint');
    expect(result!).not.toContain('test,');
  });

  it('blocks when an active check has failing evidence', () => {
    const state = makeState('IMPL_REVIEW', {
      implementation: IMPL_EVIDENCE,
      validationAttempts: [attempt('test', false), attempt('lint', true)],
    });
    const result = implValidationEvidenceGate(state);
    expect(result).not.toBeNull();
    expect(parseCode(result!)).toBe('IMPL_VALIDATION_EVIDENCE_REQUIRED');
    expect(result!).toContain('test');
  });

  it('blocks when passing evidence belongs to a STALE implementation digest (D3)', () => {
    // The core D3 fix: attempts pass, but for a prior implementation revision.
    // The digest-less machine guard would accept this; the gate must not.
    const state = makeState('IMPL_REVIEW', {
      implementation: IMPL_EVIDENCE,
      validationAttempts: [
        attempt('test', true, 'stale-digest'),
        attempt('lint', true, 'stale-digest'),
      ],
    });
    const result = implValidationEvidenceGate(state);
    expect(result).not.toBeNull();
    expect(parseCode(result!)).toBe('IMPL_VALIDATION_EVIDENCE_REQUIRED');
    expect(result!).toContain('test');
    expect(result!).toContain('lint');
  });

  it('blocks when there is no current implementation digest', () => {
    const state = makeState('IMPL_REVIEW', {
      implementation: null,
      validationAttempts: [attempt('test', true), attempt('lint', true)],
    });
    const result = implValidationEvidenceGate(state);
    expect(result).not.toBeNull();
    expect(parseCode(result!)).toBe('IMPL_VALIDATION_EVIDENCE_REQUIRED');
  });

  it('ignores baseline-scope attempts (only implementation scope counts)', () => {
    const baseline = {
      attemptId: '00000000-0000-4000-8000-0000000000ba',
      scope: 'baseline' as const,
      planDigest: 'plan-digest',
      result: { ...VALIDATION_PASSED[0]!, checkId: 'test', passed: true },
    } as ValidationAttempt;
    const state = makeState('IMPL_REVIEW', {
      implementation: IMPL_EVIDENCE,
      validationAttempts: [baseline, attempt('lint', true)],
    });
    const result = implValidationEvidenceGate(state);
    expect(result).not.toBeNull();
    // 'test' only has a baseline attempt → still missing for implementation scope.
    expect(result!).toContain('test');
  });

  it('passes vacuously when there are no active checks (zero-check sessions unaffected)', () => {
    const state = makeState('IMPL_REVIEW', {
      implementation: IMPL_EVIDENCE,
      activeChecks: [],
      validationAttempts: [],
    });
    expect(implValidationEvidenceGate(state)).toBeNull();
  });
});
