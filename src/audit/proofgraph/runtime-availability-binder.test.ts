/**
 * @module audit/proofgraph/runtime-availability-binder.test
 * @description Tests for runtime availability → ProofGraph unavailable binding.
 */

import { describe, expect, it } from 'vitest';
import { bindRuntimeUnavailableEvidence } from './runtime-availability-binder.js';
import type { SessionState } from '../../state/schema.js';

function fakeState(
  claims: Array<{
    claimId: string;
    providerId: string;
    localId: string;
    checkId?: string;
  }>,
): SessionState {
  return {
    proofContract: {
      claims: claims.map((c) => ({
        claimId: c.claimId,
        statement: 'test',
        critical: true,
        signalClass: 'fact' as const,
        provenance: null,
        evidenceRefs: [],
        counterexampleRefs: [],
        counterexampleRequirement: {
          checkId: c.checkId ?? 'test',
          assertion: { providerId: c.providerId, localId: c.localId },
        },
      })),
      version: 'proofgraph.v1',
      declaredAt: '2026-01-01T00:00:00.000Z',
      bindings: [],
      evidence: [],
    },
  } as unknown as SessionState;
}

function runtimeCandidate(
  providerId: string,
  status:
    'ready' | 'tool_missing' | 'reporter_missing' | 'runtime_missing' | 'unavailable' | 'unknown',
) {
  return {
    candidate: {
      assertionCapability: 'structured' as const,
      kind: 'test' as const,
      command: 'test',
      source: 'repo:native',
      confidence: 'high' as const,
      reason: 'test',
      assertionReport: {
        collection: 'run_specific' as const,
        transport: 'file' as const,
        format: 'vitest_json' as const,
        providerId,
        outputArgumentTemplate: '',
        resultPatternTemplate: '',
      },
    },
    runtime: { status, requirements: [] },
  };
}

describe('bindRuntimeUnavailableEvidence', () => {
  it('matching provider + tool_missing → unavailable result for claim', () => {
    const state = fakeState([
      { claimId: 'c1', providerId: 'vitest', localId: 'src/foo.test.ts::testBar' },
    ]);
    const candidates = [runtimeCandidate('vitest', 'tool_missing')];

    const results = bindRuntimeUnavailableEvidence(state, 'now', candidates);

    expect(results).toHaveLength(1);
    expect(results[0]!.claimId).toBe('c1');
    expect(results[0]!.status).toBe('unavailable');
    expect(results[0]!.detail).toContain('vitest');
    expect(results[0]!.detail).toContain('tool_missing');
  });

  it('matching provider + reporter_missing → unavailable', () => {
    const state = fakeState([
      { claimId: 'c1', providerId: 'pytest', localId: 'tests/test_x.py::testFoo' },
    ]);
    const candidates = [runtimeCandidate('pytest', 'reporter_missing')];

    const results = bindRuntimeUnavailableEvidence(state, 'now', candidates);

    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('unavailable');
    expect(results[0]!.detail).toContain('reporter_missing');
  });

  it('different provider → no result', () => {
    const state = fakeState([{ claimId: 'c1', providerId: 'vitest', localId: 'testBar' }]);
    const candidates = [runtimeCandidate('pytest', 'tool_missing')];

    const results = bindRuntimeUnavailableEvidence(state, 'now', candidates);

    expect(results).toHaveLength(0);
  });

  it('ready runtime → no result', () => {
    const state = fakeState([{ claimId: 'c1', providerId: 'vitest', localId: 'testBar' }]);
    const candidates = [runtimeCandidate('vitest', 'ready')];

    const results = bindRuntimeUnavailableEvidence(state, 'now', candidates);

    expect(results).toHaveLength(0);
  });

  it('unsupported candidate → no result', () => {
    const state = fakeState([{ claimId: 'c1', providerId: 'vitest', localId: 'testBar' }]);
    const candidates = [
      {
        candidate: {
          assertionCapability: 'unsupported' as const,
          kind: 'test' as const,
          command: 'test',
          source: 'repo:native',
          confidence: 'high' as const,
          reason: 'test',
        },
        runtime: { status: 'tool_missing' as const, requirements: [] },
      },
    ];

    const results = bindRuntimeUnavailableEvidence(state, 'now', candidates);

    expect(results).toHaveLength(0);
  });

  it('two claims, only matching provider affected', () => {
    const state = fakeState([
      { claimId: 'c1', providerId: 'vitest', localId: 'testA' },
      { claimId: 'c2', providerId: 'pytest', localId: 'testB' },
    ]);
    const candidates = [runtimeCandidate('vitest', 'tool_missing')];

    const results = bindRuntimeUnavailableEvidence(state, 'now', candidates);

    expect(results).toHaveLength(1);
    expect(results[0]!.claimId).toBe('c1');
  });

  it('claims without counterexampleRequirement are skipped', () => {
    const state = fakeState([{ claimId: 'c1', providerId: 'vitest', localId: 'testA' }]);
    // Override the claim to remove counterexampleRequirement
    (state.proofContract!.claims[0]! as Record<string, unknown>).counterexampleRequirement =
      undefined;
    const candidates = [runtimeCandidate('vitest', 'tool_missing')];

    const results = bindRuntimeUnavailableEvidence(state, 'now', candidates);

    expect(results).toHaveLength(0);
  });
});
