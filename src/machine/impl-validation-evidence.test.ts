/**
 * @module machine/impl-validation-evidence.test
 * @description Negative-path contract for the shared post-implementation
 * validation evidence authority.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { ValidationAttempt } from '../state/evidence-validation.js';
import type { ValidationResult } from '../state/evidence.js';
import { IMPL_EVIDENCE, makeState, VALIDATION_FAILED, VALIDATION_PASSED } from '../fixtures.js';
import { TEST_EXECUTION_OBSERVATION } from '../state/evidence-test-constants.js';
import { evaluateImplValidationEvidence } from './impl-validation-evidence.js';

const OTHER_IMPLEMENTATION_ID = '00000000-0000-4000-8000-0000000000cc';

function result(checkId: string, passed: boolean, executedAt: string): ValidationResult {
  const base = passed ? VALIDATION_PASSED[0]! : VALIDATION_FAILED[0]!;
  return { ...base, checkId, passed, executedAt };
}

function attempt(
  checkId: string,
  passed: boolean,
  executedAt: string,
  implementationId = IMPL_EVIDENCE.implementationId,
): ValidationAttempt {
  return {
    attemptId: randomUUID(),
    scope: 'implementation',
    implementationId,
    implementationDigest: IMPL_EVIDENCE.digest,
    executionObservation: TEST_EXECUTION_OBSERVATION,
    result: result(checkId, passed, executedAt),
  };
}

describe('evaluateImplValidationEvidence', () => {
  it('HAPPY: passes when every check has a latest passing result and bound attempt', () => {
    const state = makeState('IMPL_VALIDATION', {
      implementation: IMPL_EVIDENCE,
      activeChecks: ['test', 'lint'],
      implValidation: [
        result('test', true, '2026-01-01T00:00:01.000Z'),
        result('lint', true, '2026-01-01T00:00:02.000Z'),
      ],
      validationAttempts: [
        attempt('test', true, '2026-01-01T00:00:01.000Z'),
        attempt('lint', true, '2026-01-01T00:00:02.000Z'),
      ],
    });

    const decision = evaluateImplValidationEvidence(state);
    expect(decision.satisfied).toBe(true);
    expect(decision.missing).toEqual([]);
    expect(decision.basis.map((entry) => entry.checkId)).toEqual(['test', 'lint']);
    for (const entry of decision.basis) expect(entry.attemptId).toBeTruthy();
  });

  it('BAD: no active checks is not satisfied (no vacuous reduced approval)', () => {
    const state = makeState('IMPL_VALIDATION', {
      implementation: IMPL_EVIDENCE,
      activeChecks: [],
      implValidation: [],
      validationAttempts: [],
    });

    expect(evaluateImplValidationEvidence(state).satisfied).toBe(false);
  });

  it('BAD: a missing bound attempt cannot qualify even with a passing result', () => {
    const state = makeState('IMPL_VALIDATION', {
      implementation: IMPL_EVIDENCE,
      activeChecks: ['test'],
      implValidation: [result('test', true, '2026-01-01T00:00:01.000Z')],
      validationAttempts: [],
    });

    const decision = evaluateImplValidationEvidence(state);
    expect(decision.satisfied).toBe(false);
    expect(decision.missing).toEqual(['test']);
  });

  it('BAD: a later FAIL cannot be masked by an earlier PASS', () => {
    const state = makeState('IMPL_VALIDATION', {
      implementation: IMPL_EVIDENCE,
      activeChecks: ['test'],
      implValidation: [result('test', false, '2026-01-01T00:00:02.000Z')],
      validationAttempts: [attempt('test', true, '2026-01-01T00:00:01.000Z')],
    });

    expect(evaluateImplValidationEvidence(state).satisfied).toBe(false);
  });

  it('BAD: a later FAILING attempt cannot be masked by an earlier passing attempt', () => {
    const state = makeState('IMPL_VALIDATION', {
      implementation: IMPL_EVIDENCE,
      activeChecks: ['test'],
      implValidation: [result('test', true, '2026-01-01T00:00:01.000Z')],
      validationAttempts: [
        attempt('test', true, '2026-01-01T00:00:01.000Z'),
        {
          ...attempt('test', false, '2026-01-01T00:00:03.000Z'),
          result: result('test', false, '2026-01-01T00:00:03.000Z'),
        },
      ],
    });

    expect(evaluateImplValidationEvidence(state).satisfied).toBe(false);
  });

  it('BAD: attempts bound to another implementation generation do not count', () => {
    const state = makeState('IMPL_VALIDATION', {
      implementation: IMPL_EVIDENCE,
      activeChecks: ['test'],
      implValidation: [result('test', true, '2026-01-01T00:00:01.000Z')],
      validationAttempts: [
        attempt('test', true, '2026-01-01T00:00:01.000Z', OTHER_IMPLEMENTATION_ID),
      ],
    });

    expect(evaluateImplValidationEvidence(state).satisfied).toBe(false);
  });

  it('BAD: an attempt bound to the right generation but the wrong digest never counts', () => {
    const badDigestAttempt = {
      ...attempt('test', true, '2026-01-01T00:00:01.000Z'),
      implementationDigest: 'different-digest',
    };
    const state = makeState('IMPL_VALIDATION', {
      implementation: IMPL_EVIDENCE,
      activeChecks: ['test'],
      implValidation: [result('test', true, '2026-01-01T00:00:01.000Z')],
      validationAttempts: [badDigestAttempt],
    });

    expect(evaluateImplValidationEvidence(state).satisfied).toBe(false);
  });

  it('BAD: a passing attempt that did not produce the latest result never counts', () => {
    const base = attempt('test', true, '2026-01-01T00:00:01.000Z');
    const unrelatedAttempt = {
      ...base,
      result: { ...base.result, outputDigest: 'f'.repeat(64) },
    };
    const state = makeState('IMPL_VALIDATION', {
      implementation: IMPL_EVIDENCE,
      activeChecks: ['test'],
      implValidation: [result('test', true, '2026-01-01T00:00:01.000Z')],
      validationAttempts: [unrelatedAttempt],
    });

    expect(evaluateImplValidationEvidence(state).satisfied).toBe(false);
  });

  it('BAD: missing implementation evidence marks all checks missing', () => {
    const state = makeState('IMPL_VALIDATION', {
      implementation: null,
      activeChecks: ['test', 'lint'],
      implValidation: VALIDATION_PASSED,
      validationAttempts: [
        attempt('test', true, '2026-01-01T00:00:01.000Z'),
        attempt('lint', true, '2026-01-01T00:00:02.000Z'),
      ],
    });

    const decision = evaluateImplValidationEvidence(state);
    expect(decision.satisfied).toBe(false);
    expect(decision.missing).toEqual(['test', 'lint']);
  });

  it('EDGE: basis references the latest attempt per check', () => {
    const first = attempt('test', true, '2026-01-01T00:00:01.000Z');
    const second = attempt('test', true, '2026-01-01T00:00:05.000Z');
    const state = makeState('IMPL_VALIDATION', {
      implementation: IMPL_EVIDENCE,
      activeChecks: ['test'],
      implValidation: [result('test', true, '2026-01-01T00:00:05.000Z')],
      validationAttempts: [first, second],
    });

    const decision = evaluateImplValidationEvidence(state);
    expect(decision.satisfied).toBe(true);
    expect(decision.basis).toEqual([
      { checkId: 'test', attemptId: second.attemptId, executedAt: '2026-01-01T00:00:05.000Z' },
    ]);
  });
});
