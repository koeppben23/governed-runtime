/** Exact binding conditions for executed source-variant evidence. */
import { describe, expect, it } from 'vitest';
import type { FalsificationExecution, ValidationResult } from '../../state/evidence-validation.js';
import type { CounterexampleRequirement, ProofCounterexample } from '../../state/proofgraph.js';
import { counterexampleRequirementDigest } from '../../state/proofgraph.js';
import {
  falsificationProof,
  hasBoundFalsification,
  isTargetedFalsification,
  matchingFalsification,
} from './falsification-binding.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const CLAIM = '22222222-2222-4222-8222-222222222222';
const CONTROL_ID = '55555555-5555-4555-8555-555555555555';
const VARIANT_ID = '66666666-6666-4666-8666-666666666666';

const REQUIREMENT: CounterexampleRequirement = {
  kind: 'assertion',
  checkId: 'test',
  assertion: { providerId: 'junit', localId: 'example.GuardTest#missingId' },
  variant: { path: 'src/guard.ts', before: 'guard();', after: '' },
};

function extraction(attemptId: string, infrastructureError = false) {
  return {
    status: 'extracted' as const,
    attemptId,
    providerId: 'junit' as const,
    format: 'junit_xml' as const,
    bindingCapability: 'assertion' as const,
    reportDigests: [SHA_A],
    assertions: [
      {
        assertion: { providerId: 'junit' as const, localId: 'example.GuardTest#missingId' },
        providerId: 'junit' as const,
        status: 'passed' as const,
        testName: 'missingId',
      },
    ],
    summary: {
      assertionCount: 1,
      passedCount: 1,
      failedCount: 0,
      erroredCount: 0,
      skippedCount: 0,
      suiteInfrastructureError: infrastructureError,
    },
  };
}

function result(attemptId: string, passed: boolean) {
  return {
    checkId: 'test',
    passed,
    detail: '',
    executedAt: '2026-11-13T00:00:00.000Z',
    kind: 'test' as const,
    candidateId: 'candidate-1',
    command: 'node check.cjs',
    exitCode: passed ? 0 : 1,
    executionMs: 5,
    outputDigest: SHA_A,
    timedOut: false,
    outcome: passed ? ('supported' as const) : ('inconclusive' as const),
    assertionExtraction: extraction(attemptId),
  };
}

function execution(overrides: Partial<FalsificationExecution> = {}): FalsificationExecution {
  return {
    claimId: CLAIM,
    declarationDigest: counterexampleRequirementDigest(REQUIREMENT),
    controlAttemptId: CONTROL_ID,
    variantAttemptId: VARIANT_ID,
    controlSourceDigest: SHA_A,
    variantSourceDigest: SHA_B,
    control: result(CONTROL_ID, true),
    variant: result(VARIANT_ID, false),
    ...overrides,
  };
}

const classify = (value: ValidationResult) =>
  value.passed ? ('supported' as const) : ('contradicted' as const);

describe('matchingFalsification', () => {
  it('binds an exact claim/declaration/execution pair', () => {
    expect(matchingFalsification([execution()], CLAIM, REQUIREMENT)).toBeDefined();
  });

  it('requires a declared variant', () => {
    const withoutVariant = { ...REQUIREMENT };
    Reflect.deleteProperty(withoutVariant, 'variant');
    expect(matchingFalsification([execution()], CLAIM, withoutVariant)).toBeUndefined();
  });

  it.each([
    ['claim mismatch', { claimId: '33333333-3333-4333-8333-333333333333' }],
    ['declaration mismatch', { declarationDigest: SHA_A }],
    ['same execution identity', { variantAttemptId: CONTROL_ID }],
    ['same source digest', { variantSourceDigest: SHA_A }],
    ['empty variant digest', { variantSourceDigest: '' }],
    [
      'missing candidate',
      {
        control: (() => {
          const value = result(CONTROL_ID, true);
          Reflect.deleteProperty(value, 'candidateId');
          return value;
        })(),
      },
    ],
    ['candidate mismatch', { variant: { ...result(VARIANT_ID, false), candidateId: 'other' } }],
    ['control check mismatch', { control: { ...result(CONTROL_ID, true), checkId: 'build' } }],
    ['variant check mismatch', { variant: { ...result(VARIANT_ID, false), checkId: 'build' } }],
    ['control exit code', { control: { ...result(CONTROL_ID, true), exitCode: 1 } }],
    ['control timeout', { control: { ...result(CONTROL_ID, true), timedOut: true } }],
    [
      'control extraction mismatch',
      { control: { ...result(CONTROL_ID, true), assertionExtraction: extraction(VARIANT_ID) } },
    ],
    [
      'variant extraction mismatch',
      { variant: { ...result(VARIANT_ID, false), assertionExtraction: extraction(CONTROL_ID) } },
    ],
    [
      'control infrastructure error',
      {
        control: {
          ...result(CONTROL_ID, true),
          assertionExtraction: extraction(CONTROL_ID, true),
        },
      },
    ],
  ] as const)('rejects %s', (_label, overrides) => {
    expect(matchingFalsification([execution(overrides)], CLAIM, REQUIREMENT)).toBeUndefined();
  });

  it('ignores unrelated claims and returns the matching record', () => {
    const unrelated = execution({ claimId: '33333333-3333-4333-8333-333333333333' });
    expect(matchingFalsification([unrelated, execution()], CLAIM, REQUIREMENT)).toMatchObject({
      claimId: CLAIM,
    });
  });
});

describe('isTargetedFalsification', () => {
  it('requires a passing control and a detected variant', () => {
    expect(isTargetedFalsification(execution(), classify)).toBe(true);
  });

  it('is false without a record', () => {
    expect(isTargetedFalsification(undefined, classify)).toBe(false);
  });

  it.each([
    ['control failed', { control: { ...result(CONTROL_ID, true), passed: false } }],
    [
      'control not supported',
      { control: { ...result(CONTROL_ID, true), outcome: 'inconclusive' as const } },
    ],
    ['variant passed', { variant: result(VARIANT_ID, true) }],
    ['variant zero exit', { variant: { ...result(VARIANT_ID, false), exitCode: 0 } }],
    ['variant timeout', { variant: { ...result(VARIANT_ID, false), timedOut: true } }],
    [
      'variant not inconclusive',
      { variant: { ...result(VARIANT_ID, false), outcome: 'blocked' as const } },
    ],
  ] as const)('rejects %s', (_label, overrides) => {
    expect(isTargetedFalsification(execution(overrides), classify)).toBe(false);
  });
});

function counterexample(overrides: Partial<ProofCounterexample> = {}): ProofCounterexample {
  return {
    claimId: CLAIM,
    attemptId: VARIANT_ID,
    checkId: 'test',
    scenario: 'isolated source variant',
    outcome: 'supported',
    boundDigest: 'implementation',
    executedAt: '2026-11-13T00:00:00.000Z',
    falsification: {
      declarationDigest: counterexampleRequirementDigest(REQUIREMENT),
      controlAttemptId: CONTROL_ID,
      variantAttemptId: VARIANT_ID,
      controlSourceDigest: SHA_A,
      variantSourceDigest: SHA_B,
    },
    ...overrides,
  };
}

describe('hasBoundFalsification', () => {
  it('accepts the exact declaration and distinct execution pair', () => {
    expect(hasBoundFalsification(counterexample(), REQUIREMENT)).toBe(true);
  });

  it('rejects a requirement without a variant or a counterexample without a binding', () => {
    const withoutVariant = { ...REQUIREMENT };
    Reflect.deleteProperty(withoutVariant, 'variant');
    expect(hasBoundFalsification(counterexample(), withoutVariant)).toBe(false);
    const withoutBinding = counterexample();
    Reflect.deleteProperty(withoutBinding, 'falsification');
    expect(hasBoundFalsification(withoutBinding, REQUIREMENT)).toBe(false);
  });

  it('rejects a changed declaration or a reused execution/source identity', () => {
    const binding = counterexample().falsification!;
    expect(
      hasBoundFalsification(
        counterexample({ falsification: { ...binding, declarationDigest: SHA_A } }),
        REQUIREMENT,
      ),
    ).toBe(false);
    expect(
      hasBoundFalsification(
        counterexample({ falsification: { ...binding, variantAttemptId: CONTROL_ID } }),
        REQUIREMENT,
      ),
    ).toBe(false);
    expect(
      hasBoundFalsification(
        counterexample({ falsification: { ...binding, variantSourceDigest: SHA_A } }),
        REQUIREMENT,
      ),
    ).toBe(false);
  });
});

describe('falsificationProof', () => {
  it('copies exactly the immutable binding fields', () => {
    expect(falsificationProof(execution())).toEqual({
      falsification: {
        declarationDigest: counterexampleRequirementDigest(REQUIREMENT),
        controlAttemptId: CONTROL_ID,
        variantAttemptId: VARIANT_ID,
        controlSourceDigest: SHA_A,
        variantSourceDigest: SHA_B,
      },
    });
    expect(falsificationProof(undefined)).toEqual({});
  });
});
