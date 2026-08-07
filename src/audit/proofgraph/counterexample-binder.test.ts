/**
 * @module audit/proofgraph/counterexample-binder.test
 * @description Binding declared counterexample refs to executed outcomes (#762).
 *
 * After legacy eradication: a counterexample without a counterexampleRequirement
 * always returns not_verified (defensive corruption handling). All positive
 * outcomes require assertion-level binding via a structured counterexampleRequirement.
 */
import { describe, it, expect } from 'vitest';
import { bindCounterexamples } from './counterexample-binder.js';
import { makeState } from '../../fixtures.js';
import { ProofCounterexample } from '../../state/proofgraph.js';
import type { SessionState } from '../../state/schema.js';

const NOW = '2026-01-01T00:00:00.000Z';
const CLAIM = '00000000-0000-4000-8000-000000000001';
const ATT = '00000000-0000-4000-8000-0000000000cc';
const IMPL_DIGEST = 'impl-current';
const SHA = 'a'.repeat(64);
const AUTHORITY_REF = {
  kind: 'canonical_authority' as const,
  authorityId: 'ticket',
  digest: 'authority',
};
const IMPL = { changedFiles: ['a.ts'], domainFiles: [], digest: IMPL_DIGEST, executedAt: NOW };

const COUNTEREXAMPLE_REQ = {
  checkId: 'security',
  assertion: { providerId: 'junit', localId: 'com.example.Test#method' },
};

function validationResult(passed: boolean) {
  return {
    checkId: 'security',
    passed,
    detail: '',
    executedAt: NOW,
    kind: 'security' as const,
    command: 'npm run security',
    exitCode: passed ? 0 : 1,
    executionMs: 5,
    outputDigest: SHA,
    timedOut: false,
    outcome: (passed ? 'supported' : 'inconclusive') as 'supported' | 'inconclusive',
  };
}

function claim(attemptId = ATT) {
  return {
    claimId: CLAIM,
    statement: 'the change is safe',
    signalClass: 'fact' as const,
    critical: true,
    provenance: AUTHORITY_REF,
    evidenceRefs: [],
    counterexampleRefs: [{ kind: 'validation_attempt' as const, attemptId }],
    counterexampleRequirement: COUNTEREXAMPLE_REQ,
  };
}

function stateWith(
  attempts: SessionState['validationAttempts'],
  phase: SessionState['phase'] = 'IMPL_REVIEW',
  overrides: Partial<ReturnType<typeof claim>> = {},
): SessionState {
  return makeState(phase, {
    implementation: IMPL,
    proofContract: {
      version: 'contract.v1',
      claims: [{ ...claim(), ...overrides }],
    },
    validationAttempts: attempts,
  });
}

describe('bindCounterexamples', () => {
  it('maps a failing counterexample check to not_verified (inconclusive)', () => {
    const state = stateWith([
      {
        attemptId: ATT,
        scope: 'implementation',
        implementationDigest: IMPL_DIGEST,
        result: validationResult(false),
      },
    ]);
    const [cx] = bindCounterexamples(state, NOW).counterexamples;
    expect(cx).toMatchObject({ claimId: CLAIM, outcome: 'not_verified', boundDigest: IMPL_DIGEST });
  });

  it('maps an inconclusive result to not_verified', () => {
    const state = stateWith([
      {
        attemptId: ATT,
        scope: 'implementation',
        implementationDigest: IMPL_DIGEST,
        result: { ...validationResult(false), outcome: 'inconclusive' as const },
      },
    ]);
    const [cx] = bindCounterexamples(state, NOW).counterexamples;
    expect(cx).toMatchObject({ claimId: CLAIM, outcome: 'not_verified', boundDigest: IMPL_DIGEST });
  });

  it('returns not_verified for outcome=blocked (defensive fallback when no assertion extraction)', () => {
    const state = stateWith([
      {
        attemptId: ATT,
        scope: 'implementation',
        implementationDigest: IMPL_DIGEST,
        result: { ...validationResult(false), outcome: 'blocked' as const, timedOut: true },
      },
    ]);
    const [cx] = bindCounterexamples(state, NOW).counterexamples;
    expect(cx!.outcome).toBe('not_verified');
  });

  it('returns not_verified for a passing counterexample without assertion extraction', () => {
    const state = stateWith([
      {
        attemptId: ATT,
        scope: 'implementation',
        implementationDigest: IMPL_DIGEST,
        result: validationResult(true),
      },
    ]);
    expect(bindCounterexamples(state, NOW).counterexamples[0]!.outcome).toBe('not_verified');
  });

  it('returns not_verified when counterexampleRequirement is absent (defensive corruption handling)', () => {
    const state = stateWith(
      [
        {
          attemptId: ATT,
          scope: 'implementation',
          implementationDigest: IMPL_DIGEST,
          result: { ...validationResult(true), outcome: 'supported' as const },
        },
      ],
      'IMPL_REVIEW',
      { counterexampleRequirement: undefined },
    );
    expect(bindCounterexamples(state, NOW).counterexamples[0]!.outcome).toBe('not_verified');
  });

  it('marks a missing counterexample attempt as not_verified', () => {
    const cx = bindCounterexamples(stateWith([]), NOW).counterexamples[0]!;
    expect(cx.outcome).toBe('not_verified');
    expect(cx.boundDigest).toBe(IMPL_DIGEST);
  });

  it('returns nothing when there is no implementation', () => {
    const state = makeState('IMPL_REVIEW', {
      proofContract: { version: 'contract.v1', claims: [claim()] },
    });
    expect(bindCounterexamples(state, NOW).counterexamples).toEqual([]);
  });

  it('ignores non-validation_attempt counterexample references', () => {
    const state = makeState('IMPL_REVIEW', {
      implementation: IMPL,
      proofContract: {
        version: 'contract.v1',
        claims: [{ ...claim(), counterexampleRefs: [{ kind: 'content', digest: 'x' }] }],
      },
    });
    expect(bindCounterexamples(state, NOW).counterexamples).toEqual([]);
  });

  it('every produced ProofCounterexample passes schema validation', () => {
    const state = stateWith([
      {
        attemptId: ATT,
        scope: 'implementation',
        implementationDigest: IMPL_DIGEST,
        result: validationResult(true),
      },
    ]);
    const counterexamples = bindCounterexamples(state, NOW).counterexamples;
    expect(counterexamples.length).toBeGreaterThan(0);
    for (const counterexample of counterexamples) {
      expect(() => ProofCounterexample.parse(counterexample)).not.toThrow();
    }
  });

  it('unresolved attempt has non-empty checkId', () => {
    const state = stateWith([]);
    const [cx] = bindCounterexamples(state, NOW).counterexamples;
    expect(cx!.checkId).toBeTruthy();
    expect(cx!.attemptId).toBeTruthy();
  });
});
