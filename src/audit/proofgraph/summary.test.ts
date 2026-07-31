/**
 * @module audit/proofgraph/summary.test
 * @description End-to-end pure vertical: contract + validation ledger -> summary (#762).
 */
import { describe, it, expect } from 'vitest';
import { summarizeProofGraph } from './summary.js';
import { makeState } from '../../fixtures.js';
import type { SessionState } from '../../state/schema.js';

const NOW = '2026-01-01T00:00:00.000Z';
const CLAIM = '00000000-0000-4000-8000-000000000001';
const ATT = '00000000-0000-4000-8000-0000000000aa';
const IMPL_DIGEST = 'impl-current';
const SHA = 'a'.repeat(64);
const CONTENT_REF = { kind: 'content' as const, digest: 'authority' };
const IMPL = { changedFiles: ['a.ts'], domainFiles: [], digest: IMPL_DIGEST, executedAt: NOW };

function attemptResult(passed: boolean) {
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
  };
}

function claim() {
  return {
    claimId: CLAIM,
    statement: 'covered by a passing implementation test',
    signalClass: 'fact' as const,
    critical: true,
    provenance: CONTENT_REF,
    evidenceRefs: [{ kind: 'validation_attempt' as const, attemptId: ATT }],
    counterexampleRefs: [],
  };
}

function stateWith(attempts: SessionState['validationAttempts']): SessionState {
  return makeState('IMPL_VALIDATION', {
    implementation: IMPL,
    proofContract: { version: 'contract.v1', claims: [claim()] },
    validationAttempts: attempts,
  });
}

describe('summarizeProofGraph', () => {
  it('summarizes an empty ProofGraph for a session without a contract', () => {
    const summary = summarizeProofGraph(makeState('READY'), NOW);
    expect(summary.projection.claims).toEqual([]);
    expect(summary.criticalClaimCount).toBe(0);
    expect(summary.criticalUnprovenCount).toBe(0);
  });

  it('reports a critical claim as PROVEN when its bound implementation test passed', () => {
    const summary = summarizeProofGraph(
      stateWith([
        {
          attemptId: ATT,
          scope: 'implementation',
          implementationDigest: IMPL_DIGEST,
          result: attemptResult(true),
        },
      ]),
      NOW,
    );
    expect(summary.counts.PROVEN).toBe(1);
    expect(summary.criticalClaimCount).toBe(1);
    expect(summary.criticalUnprovenCount).toBe(0);
  });

  it('surfaces a critical gap as NOT_VERIFIED when the referenced attempt is missing', () => {
    const summary = summarizeProofGraph(stateWith([]), NOW);
    expect(summary.counts.NOT_VERIFIED).toBe(1);
    expect(summary.criticalUnprovenCount).toBe(1);
  });

  it('reports STALE when the passing evidence is bound to a superseded revision', () => {
    const summary = summarizeProofGraph(
      stateWith([
        {
          attemptId: ATT,
          scope: 'implementation',
          implementationDigest: 'old-digest',
          result: attemptResult(true),
        },
      ]),
      NOW,
    );
    expect(summary.counts.STALE).toBe(1);
    expect(summary.criticalUnprovenCount).toBe(1);
  });
});
