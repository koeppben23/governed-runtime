/**
 * @module audit/proofgraph/derive.test
 * @description Contract -> evaluator bridge over SessionState (#762).
 */
import { describe, it, expect } from 'vitest';
import { deriveProofGraph } from './derive.js';
import { makeState } from '../../fixtures.js';

const NOW = '2026-01-01T00:00:00.000Z';
const UUID = '00000000-0000-4000-8000-000000000001';
const AUTHORITY_REF = {
  kind: 'canonical_authority' as const,
  authorityId: 'ticket',
  digest: 'authority',
};
const IMPL_DIGEST = 'impl-current';
const IMPL = { changedFiles: ['a.ts'], domainFiles: [], digest: IMPL_DIGEST, executedAt: NOW };
const SHA = 'a'.repeat(64);

function claim() {
  return {
    claimId: UUID,
    statement: 'x',
    signalClass: 'fact' as const,
    critical: true,
    provenance: AUTHORITY_REF,
    evidenceRefs: [],
    counterexampleRefs: [],
  };
}

function stateWithContract() {
  return makeState('IMPLEMENTATION', {
    implementation: IMPL,
    proofContract: { version: 'contract.v1' as const, claims: [claim()] },
  });
}

function passResult(boundDigest: string) {
  return {
    claimId: UUID,
    providerKind: 'executed_test' as const,
    providerId: 'executed-test',
    providerVersion: '1.0.0',
    input: { command: 'npm test' },
    source: { location: 'test', stableId: '00000000-0000-4000-8000-0000000000aa' },
    binding: { kind: 'implementation' as const, digest: boundDigest },
    status: 'pass' as const,
    resultDigest: SHA,
    executedAt: NOW,
    detail: 'npm test',
    attestation: 'flowguard_executed' as const,
  };
}

describe('deriveProofGraph', () => {
  it('returns an empty projection when there is no contract', () => {
    const out = deriveProofGraph(makeState('READY'), [], [], NOW);
    expect(out.claims).toEqual([]);
    expect(out.version).toBe('proofgraph.v1');
    expect(out.evaluatedAt).toBe(NOW);
  });

  it('evaluates a declared claim as UNPROVEN with no evidence', () => {
    const out = deriveProofGraph(stateWithContract(), [], [], NOW);
    expect(out.claims[0]!.verificationState).toBe('UNPROVEN');
  });

  it('evaluates PROVEN for fresh passing evidence bound to the current impl digest', () => {
    const out = deriveProofGraph(stateWithContract(), [passResult(IMPL_DIGEST)], [], NOW);
    expect(out.claims[0]!.verificationState).toBe('PROVEN');
    expect(out.claims[0]!.freshness?.stale).toBe(false);
  });

  it('marks passing evidence bound to a superseded revision as STALE', () => {
    const out = deriveProofGraph(stateWithContract(), [passResult('old-digest')], [], NOW);
    expect(out.claims[0]!.verificationState).toBe('STALE');
  });
});
