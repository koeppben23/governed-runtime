/**
 * @module audit/proofgraph/executed-test-binder.test
 * @description Binding of implementation validation attempts to provider results (#762).
 */
import { describe, it, expect } from 'vitest';
import {
  bindExecutedTestEvidence,
  EXECUTED_TEST_PROVIDER_VERSION,
} from './executed-test-binder.js';
import { makeState } from '../../fixtures.js';
import type { SessionState } from '../../state/schema.js';

const NOW = '2026-01-01T00:00:00.000Z';
const CLAIM = '00000000-0000-4000-8000-000000000001';
const ATT = '00000000-0000-4000-8000-0000000000aa';
const IMPL_DIGEST = 'impl-current';
const SHA = 'a'.repeat(64);
const CONTENT_REF = { kind: 'content' as const, digest: 'authority' };
const IMPL = { changedFiles: ['a.ts'], domainFiles: [], digest: IMPL_DIGEST, executedAt: NOW };

function validationResult(passed: boolean, over: Record<string, unknown> = {}) {
  return {
    checkId: 'test',
    passed,
    detail: '',
    executedAt: NOW,
    kind: 'test' as const,
    command: 'npm test',
    exitCode: passed ? 0 : 1,
    executionMs: 5,
    outputDigest: SHA,
    timedOut: false,
    ...over,
  };
}

function claimRefingAttempt(attemptId = ATT) {
  return {
    claimId: CLAIM,
    statement: 'the change is covered by a passing test',
    signalClass: 'fact' as const,
    critical: true,
    provenance: CONTENT_REF,
    evidenceRefs: [{ kind: 'validation_attempt' as const, attemptId }],
    counterexampleRefs: [],
  };
}

function stateWith(attempts: SessionState['validationAttempts']): SessionState {
  return makeState('IMPL_VALIDATION', {
    implementation: IMPL,
    proofContract: { version: 'contract.v1', claims: [claimRefingAttempt()] },
    validationAttempts: attempts,
  });
}

describe('bindExecutedTestEvidence', () => {
  it('binds a passing implementation attempt as a pass result', () => {
    const state = stateWith([
      {
        attemptId: ATT,
        scope: 'implementation',
        implementationDigest: IMPL_DIGEST,
        result: validationResult(true),
      },
    ]);
    const [r] = bindExecutedTestEvidence(state, NOW);
    expect(r).toMatchObject({
      claimId: CLAIM,
      status: 'pass',
      boundDigest: IMPL_DIGEST,
      resultDigest: SHA,
      providerVersion: EXECUTED_TEST_PROVIDER_VERSION,
    });
  });

  it('maps a failing verdict to fail', () => {
    const state = stateWith([
      {
        attemptId: ATT,
        scope: 'implementation',
        implementationDigest: IMPL_DIGEST,
        result: validationResult(false),
      },
    ]);
    expect(bindExecutedTestEvidence(state, NOW)[0]!.status).toBe('fail');
  });

  it('maps an execution error (exit 127) to error', () => {
    const state = stateWith([
      {
        attemptId: ATT,
        scope: 'implementation',
        implementationDigest: IMPL_DIGEST,
        result: validationResult(false, { exitCode: 127 }),
      },
    ]);
    expect(bindExecutedTestEvidence(state, NOW)[0]!.status).toBe('error');
  });

  it('emits unavailable (no digests) when the referenced attempt is missing', () => {
    const [r] = bindExecutedTestEvidence(stateWith([]), NOW);
    expect(r!.status).toBe('unavailable');
    expect(r!.boundDigest).toBeUndefined();
    expect(r!.resultDigest).toBeUndefined();
  });

  it('emits unavailable when the attempt is baseline-scoped, not implementation', () => {
    const state = stateWith([
      { attemptId: ATT, scope: 'baseline', planDigest: 'plan', result: validationResult(true) },
    ]);
    expect(bindExecutedTestEvidence(state, NOW)[0]!.status).toBe('unavailable');
  });

  it('ignores non-validation_attempt evidence references', () => {
    const state = makeState('IMPLEMENTATION', {
      proofContract: {
        version: 'contract.v1',
        claims: [{ ...claimRefingAttempt(), evidenceRefs: [{ kind: 'content', digest: 'x' }] }],
      },
    });
    expect(bindExecutedTestEvidence(state, NOW)).toEqual([]);
  });
});
