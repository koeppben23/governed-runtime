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
const IMPL = {
  implementationId: '00000000-0000-4000-8000-0000000000aa',
  changedFiles: ['a.ts'],
  domainFiles: [],
  digest: IMPL_DIGEST,
  executedAt: NOW,
};
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
    proofContract: { version: 'contract.v2' as const, claims: [claim()] },
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
  it('fails closed for the incident: two passing runners cannot turn the same oracle into adversarial proof', () => {
    const assertion = {
      providerId: 'junit',
      localId:
        'com.example.taskmanager.controller.TaskControllerTest#update_taskNotFound_returns404',
    };
    const c = {
      ...claim(),
      claimScope: 'specific_behavior' as const,
      certifiedPlan: {
        authoritySectionId: 'implementation-step-2',
        expectedCheckId: 'test',
        expectedAssertion: assertion,
        digest: SHA,
      },
      counterexampleRequirement: { kind: 'assertion' as const, checkId: 'build', assertion },
      requiredEvidence: {
        positive: ['executed_test' as const],
        adversarial: ['counterexample' as const],
      },
    };
    const state = makeState('IMPLEMENTATION', {
      implementation: IMPL,
      proofContract: { version: 'contract.v2', claims: [c] },
    });
    const result = {
      ...passResult(IMPL_DIGEST),
      executionRecordId: '00000000-0000-4000-8000-0000000000ab',
      source: { location: 'validation-check:test', stableId: 'test' },
    };
    const cx = {
      claimId: UUID,
      attemptId: '00000000-0000-4000-8000-0000000000ac',
      checkId: 'build',
      scenario: 'second passing run',
      outcome: 'supported' as const,
      boundDigest: IMPL_DIGEST,
      executedAt: NOW,
    };
    const out = deriveProofGraph(state, [result], [cx], NOW);
    expect(out.claims[0]?.verificationState).toBe('NOT_VERIFIED');
    expect(out.claimDiagnostics?.[UUID]).toBe('evidence_role_collision');
  });
  it('returns an empty projection when there is no contract', () => {
    const out = deriveProofGraph(makeState('READY'), [], [], NOW);
    expect(out.claims).toEqual([]);
    expect(out.version).toBe('proofgraph.v2');
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
