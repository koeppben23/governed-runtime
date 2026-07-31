/**
 * @module integration/proofgraph/structural-provider.test
 * @description Structural/schema surfaces as revision-bound ProofGraph evidence (#762).
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateStructuralSurfaces,
  bindStructuralEvidence,
  surfaceDigestMap,
  SURFACE_COMMAND_REGISTRATION,
  SURFACE_CONFIG_DEFAULTS,
  STRUCTURAL_PROVIDER_VERSION,
} from './structural-provider.js';
import { computeSurfaceDigest } from './surface-digest.js';
import { makeState } from '../../fixtures.js';
import { ProofProviderResult } from '../../state/proofgraph.js';
import type { SessionState } from '../../state/schema.js';

const NOW = '2026-01-01T00:00:00.000Z';
const CLAIM = '00000000-0000-4000-8000-000000000001';
const AUTHORITY_REF = {
  kind: 'canonical_authority' as const,
  authorityId: 'ticket',
  digest: 'authority',
};

function stateWithSurface(surfaceId: string): SessionState {
  return makeState('IMPL_VALIDATION', {
    proofContract: {
      version: 'contract.v1',
      claims: [
        {
          claimId: CLAIM,
          statement: 'the command surface is internally consistent',
          signalClass: 'fact' as const,
          critical: true,
          provenance: AUTHORITY_REF,
          evidenceRefs: [{ kind: 'structural_surface' as const, surfaceId }],
          counterexampleRefs: [],
        },
      ],
    },
  });
}

describe('computeSurfaceDigest', () => {
  it('is deterministic for identical data', () => {
    expect(computeSurfaceDigest({ a: 1, b: [2, 3] })).toBe(
      computeSurfaceDigest({ a: 1, b: [2, 3] }),
    );
  });

  it('is key-order independent (canonical)', () => {
    expect(computeSurfaceDigest({ a: 1, b: 2 })).toBe(computeSurfaceDigest({ b: 2, a: 1 }));
  });

  it('changes when the covered surface data changes', () => {
    expect(computeSurfaceDigest({ a: 1 })).not.toBe(computeSurfaceDigest({ a: 2 }));
  });

  it('produces a 64-hex sha256 digest', () => {
    expect(computeSurfaceDigest({ a: 1 })).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('evaluateStructuralSurfaces', () => {
  it('evaluates both known surfaces with stable ids', () => {
    const ids = evaluateStructuralSurfaces().map((e) => e.surfaceId);
    expect(ids).toEqual([SURFACE_COMMAND_REGISTRATION, SURFACE_CONFIG_DEFAULTS]);
  });

  it('reports the live registries as consistent (guards real drift)', () => {
    for (const e of evaluateStructuralSurfaces()) {
      expect(e.ok, `${e.surfaceId}: ${e.detail}`).toBe(true);
    }
  });

  it('uses the provider kind matching the surface (structural vs schema)', () => {
    const [registration, config] = evaluateStructuralSurfaces();
    expect(registration!.providerKind).toBe('structural_assertion');
    expect(config!.providerKind).toBe('schema_compare');
  });

  it('is deterministic across evaluations', () => {
    expect(surfaceDigestMap(evaluateStructuralSurfaces())).toEqual(
      surfaceDigestMap(evaluateStructuralSurfaces()),
    );
  });
});

describe('bindStructuralEvidence', () => {
  it('binds a referencing claim to surface_set evidence with the current digest', () => {
    const surfaces = evaluateStructuralSurfaces();
    const [r] = bindStructuralEvidence(
      stateWithSurface(SURFACE_COMMAND_REGISTRATION),
      surfaces,
      NOW,
    );
    expect(r).toMatchObject({
      claimId: CLAIM,
      providerKind: 'structural_assertion',
      providerVersion: STRUCTURAL_PROVIDER_VERSION,
      status: 'pass',
      binding: { kind: 'surface_set', surfaceId: SURFACE_COMMAND_REGISTRATION },
    });
    expect(r!.status).not.toBe('unavailable');
    const rec = r as Record<string, unknown>;
    expect((rec.binding as Record<string, unknown>).digest).toBe(
      surfaceDigestMap(surfaces)[SURFACE_COMMAND_REGISTRATION],
    );
  });

  it('emits explicit unavailable evidence for an unknown surface', () => {
    const [r] = bindStructuralEvidence(
      stateWithSurface('does-not-exist'),
      evaluateStructuralSurfaces(),
      NOW,
    );
    expect(r!.status).toBe('unavailable');
    expect(r!.detail).toContain('does-not-exist');
  });

  it('emits nothing for claims that do not reference a surface', () => {
    const state = makeState('IMPL_VALIDATION', {
      proofContract: {
        version: 'contract.v1',
        claims: [
          {
            claimId: CLAIM,
            statement: 'x',
            signalClass: 'fact' as const,
            critical: true,
            provenance: AUTHORITY_REF,
            evidenceRefs: [{ kind: 'content' as const, digest: 'd' }],
            counterexampleRefs: [],
          },
        ],
      },
    });
    expect(bindStructuralEvidence(state, evaluateStructuralSurfaces(), NOW)).toEqual([]);
  });

  it('emits results that satisfy the strict provider schema', () => {
    const surfaces = evaluateStructuralSurfaces();
    for (const surfaceId of [SURFACE_COMMAND_REGISTRATION, SURFACE_CONFIG_DEFAULTS, 'unknown']) {
      for (const r of bindStructuralEvidence(stateWithSurface(surfaceId), surfaces, NOW)) {
        expect(() => ProofProviderResult.parse(r)).not.toThrow();
      }
    }
  });
});
