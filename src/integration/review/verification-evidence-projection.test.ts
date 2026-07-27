import { describe, expect, it } from 'vitest';

import { IMPL_EVIDENCE, VALIDATION_PASSED, makeState } from '../../fixtures.js';
import { stateVerificationEvidence } from './shared-helpers.js';

// Slice 1 fail-closed digest binding: only implementation-scope validation
// attempts bound to the CURRENT implementation digest may be projected into the
// reviewer prompt. Stale, baseline, or foreign-digest attempts must be excluded
// so the reviewer never verifies claims against outdated ground truth.

const CURRENT_DIGEST = IMPL_EVIDENCE.digest;

function implAttempt(overrides: Record<string, unknown> = {}) {
  return {
    attemptId: '22222222-2222-4222-8222-222222222222',
    scope: 'implementation' as const,
    implementationDigest: CURRENT_DIGEST,
    result: VALIDATION_PASSED[0]!,
    ...overrides,
  };
}

describe('stateVerificationEvidence', () => {
  it('projects an implementation-scope attempt bound to the current digest', () => {
    const state = makeState('IMPL_REVIEW', {
      implementation: IMPL_EVIDENCE,
      validationAttempts: [implAttempt()] as never,
    });
    const result = stateVerificationEvidence(state);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      attemptId: '22222222-2222-4222-8222-222222222222',
      kind: VALIDATION_PASSED[0]!.kind,
      command: VALIDATION_PASSED[0]!.command,
      passed: true,
      outputDigest: VALIDATION_PASSED[0]!.outputDigest,
    });
  });

  it('returns nothing when there is no current implementation digest (fail-closed)', () => {
    const state = makeState('IMPL_REVIEW', {
      validationAttempts: [implAttempt()] as never,
    });
    expect(stateVerificationEvidence(state)).toEqual([]);
  });

  it('excludes an attempt whose digest does not match the current implementation', () => {
    const state = makeState('IMPL_REVIEW', {
      implementation: IMPL_EVIDENCE,
      validationAttempts: [implAttempt({ implementationDigest: 'stale-digest' })] as never,
    });
    expect(stateVerificationEvidence(state)).toEqual([]);
  });

  it('excludes stale attempts after the implementation digest changes', () => {
    const state = makeState('IMPL_REVIEW', {
      implementation: { ...IMPL_EVIDENCE, digest: 'replacement-digest' },
      validationAttempts: [implAttempt()] as never,
    });
    expect(stateVerificationEvidence(state)).toEqual([]);
  });

  it('excludes baseline-scope attempts', () => {
    const state = makeState('IMPL_REVIEW', {
      implementation: IMPL_EVIDENCE,
      validationAttempts: [
        {
          attemptId: '33333333-3333-4333-8333-333333333333',
          scope: 'baseline' as const,
          planDigest: 'plan-digest',
          result: VALIDATION_PASSED[0]!,
        },
      ] as never,
    });
    expect(stateVerificationEvidence(state)).toEqual([]);
  });

  it('projects a failed implementation attempt (failures must be visible, not hidden)', () => {
    const state = makeState('IMPL_REVIEW', {
      implementation: IMPL_EVIDENCE,
      validationAttempts: [
        implAttempt({ result: { ...VALIDATION_PASSED[0]!, passed: false, exitCode: 1 } }),
      ] as never,
    });
    const result = stateVerificationEvidence(state);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ passed: false, exitCode: 1 });
  });
});
