/**
 * @module audit/proofgraph/executed-test-binder.test
 * @description Binding of implementation validation attempts to provider results (#762).
 */
import { describe, it, expect } from 'vitest';
import {
  bindExecutedTestEvidence,
  EXECUTED_TEST_PROVIDER_ID,
  EXECUTED_TEST_PROVIDER_VERSION,
} from './executed-test-binder.js';
import { makeState, IMPL_EVIDENCE } from '../../fixtures.js';
import { ProofProviderResult } from '../../state/proofgraph.js';
import type { SessionState } from '../../state/schema.js';

const NOW = '2026-01-01T00:00:00.000Z';
const CLAIM = '00000000-0000-4000-8000-000000000001';
const ATT = '00000000-0000-4000-8000-0000000000aa';
const IMPL_DIGEST = IMPL_EVIDENCE.candidate.candidateDigest;
const SHA = 'a'.repeat(64);
const AUTHORITY_REF = {
  kind: 'canonical_authority' as const,
  authorityId: 'ticket',
  digest: 'authority',
};

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
    outcome: (passed ? 'supported' : 'inconclusive') as 'supported' | 'inconclusive',
    ...over,
  };
}

function claimRefingAttempt(attemptId = ATT, claimScope?: 'specific_behavior' | 'suite') {
  return {
    claimId: CLAIM,
    statement: 'the change is covered by a passing test',
    signalClass: 'fact' as const,
    critical: true,
    provenance: AUTHORITY_REF,
    evidenceRefs: [{ kind: 'validation_attempt' as const, attemptId }],
    counterexampleRefs: [],
    ...(claimScope ? { claimScope } : {}),
  };
}

function stateWith(attempts: SessionState['validationAttempts']): SessionState {
  return makeState('IMPL_VALIDATION', {
    implementation: IMPL_EVIDENCE,
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
      binding: { kind: 'implementation', digest: IMPL_DIGEST },
      resultDigest: SHA,
      providerId: EXECUTED_TEST_PROVIDER_ID,
      providerVersion: EXECUTED_TEST_PROVIDER_VERSION,
      input: { command: 'npm test' },
      // Honest logical ledger location; stableId is the check identity, and the
      // single execution record is referenced separately.
      source: { location: 'validation-check:test', stableId: 'test' },
      executionRecordId: ATT,
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
    const rec = r as Record<string, unknown>;
    expect(rec.binding).toBeUndefined();
    expect(rec.source).toBeUndefined();
    expect(rec.resultDigest).toBeUndefined();
  });

  it('emits unavailable when the attempt is baseline-scoped, not implementation', () => {
    const state = stateWith([
      { attemptId: ATT, scope: 'baseline', planDigest: 'plan', result: validationResult(true) },
    ]);
    expect(bindExecutedTestEvidence(state, NOW)[0]!.status).toBe('unavailable');
  });

  it('requires attempt-bound full-check attestation for suite positive evidence', () => {
    const state = makeState('IMPL_VALIDATION', {
      implementation: IMPL_EVIDENCE,
      proofContract: {
        version: 'contract.v1',
        claims: [claimRefingAttempt(ATT, 'suite')],
      },
      validationAttempts: [
        {
          attemptId: ATT,
          scope: 'implementation',
          implementationDigest: IMPL_DIGEST,
          result: validationResult(true),
        },
      ],
    });
    expect(bindExecutedTestEvidence(state, NOW)[0]!.status).toBe('unavailable');
  });

  it('binds suite positive evidence only when its executed attempt is full-check attested', () => {
    const state = makeState('IMPL_VALIDATION', {
      implementation: IMPL_EVIDENCE,
      proofContract: {
        version: 'contract.v1',
        claims: [claimRefingAttempt(ATT, 'suite')],
      },
      validationAttempts: [
        {
          attemptId: ATT,
          scope: 'implementation',
          implementationDigest: IMPL_DIGEST,
          result: validationResult(true, { fullCheckScopeAttestation: 'full_check' }),
        },
      ],
    });
    expect(bindExecutedTestEvidence(state, NOW)[0]!.status).toBe('pass');
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

  it('emits results that satisfy the strict provider schema (executed and unavailable)', () => {
    const executed = stateWith([
      {
        attemptId: ATT,
        scope: 'implementation',
        implementationDigest: IMPL_DIGEST,
        result: validationResult(true),
      },
    ]);
    for (const r of bindExecutedTestEvidence(executed, NOW)) {
      expect(() => ProofProviderResult.parse(r)).not.toThrow();
    }
    for (const r of bindExecutedTestEvidence(stateWith([]), NOW)) {
      expect(() => ProofProviderResult.parse(r)).not.toThrow();
    }
  });
});
