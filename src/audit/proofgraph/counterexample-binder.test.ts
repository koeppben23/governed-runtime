/**
 * @module audit/proofgraph/counterexample-binder.test
 * @description Binding declared counterexample refs to executed outcomes (#762).
 */
import { describe, it, expect } from 'vitest';
import { bindCounterexamples } from './counterexample-binder.js';
import { makeState } from '../../fixtures.js';
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
  };
}

function stateWith(
  attempts: SessionState['validationAttempts'],
  phase: SessionState['phase'] = 'IMPL_REVIEW',
): SessionState {
  return makeState(phase, {
    implementation: IMPL,
    proofContract: { version: 'contract.v1', claims: [claim()] },
    validationAttempts: attempts,
  });
}

describe('bindCounterexamples', () => {
  it('maps a failing counterexample check to contradicted', () => {
    const state = stateWith([
      {
        attemptId: ATT,
        scope: 'implementation',
        implementationDigest: IMPL_DIGEST,
        result: validationResult(false),
      },
    ]);
    const [cx] = bindCounterexamples(state, NOW);
    expect(cx).toMatchObject({ claimId: CLAIM, outcome: 'contradicted', boundDigest: IMPL_DIGEST });
  });

  it('maps a passing counterexample check to supported', () => {
    const state = stateWith([
      {
        attemptId: ATT,
        scope: 'implementation',
        implementationDigest: IMPL_DIGEST,
        result: validationResult(true),
      },
    ]);
    expect(bindCounterexamples(state, NOW)[0]!.outcome).toBe('supported');
  });

  it('marks a missing counterexample attempt as not_verified', () => {
    const cx = bindCounterexamples(stateWith([]), NOW)[0]!;
    expect(cx.outcome).toBe('not_verified');
    expect(cx.boundDigest).toBe(IMPL_DIGEST);
  });

  it('returns nothing when there is no implementation', () => {
    const state = makeState('IMPL_REVIEW', {
      proofContract: { version: 'contract.v1', claims: [claim()] },
    });
    expect(bindCounterexamples(state, NOW)).toEqual([]);
  });

  it('ignores non-validation_attempt counterexample references', () => {
    const state = makeState('IMPL_REVIEW', {
      implementation: IMPL,
      proofContract: {
        version: 'contract.v1',
        claims: [{ ...claim(), counterexampleRefs: [{ kind: 'content', digest: 'x' }] }],
      },
    });
    expect(bindCounterexamples(state, NOW)).toEqual([]);
  });
});
