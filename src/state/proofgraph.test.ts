/**
 * @module proofgraph.test
 * @description Schema round-trip and negative-path tests for ProofGraph v1.
 */
import { describe, it, expect } from 'vitest';
import {
  DeclaredClaim,
  ProofClaim,
  ProofGraphProjection,
  ProofProviderResult,
  ProofCounterexample,
  PROOFGRAPH_SCHEMA_VERSION,
} from './proofgraph.js';

const UUID = '00000000-0000-4000-8000-000000000001';
const CONTENT_REF = { kind: 'content' as const, digest: 'deadbeef' };
const AUTHORITY_REF = {
  kind: 'canonical_authority' as const,
  authorityId: 'ticket',
  digest: 'deadbeef',
};
const SHA = 'a'.repeat(64);
const NOW = '2026-01-01T00:00:00.000Z';

describe('proofgraph schemas', () => {
  describe('HAPPY', () => {
    it('DeclaredClaim parses a minimal valid declaration', () => {
      const claim = {
        claimId: UUID,
        statement: 'The alias resolves to its canonical command',
        signalClass: 'fact' as const,
        critical: true,
        provenance: AUTHORITY_REF,
        evidenceRefs: [],
        counterexampleRefs: [],
      };
      expect(DeclaredClaim.parse(claim)).toEqual(claim);
    });

    it('DeclaredClaim accepts null provenance (unsourced assumption)', () => {
      const claim = {
        claimId: UUID,
        statement: 'x',
        signalClass: 'hypothesis' as const,
        critical: false,
        provenance: null,
        evidenceRefs: [],
        counterexampleRefs: [],
        confidence: 0.4,
      };
      expect(DeclaredClaim.parse(claim)).toEqual(claim);
    });

    it('ProofClaim parses declaration plus verification state and freshness', () => {
      const claim = {
        claimId: UUID,
        statement: 'x',
        signalClass: 'fact' as const,
        critical: true,
        provenance: AUTHORITY_REF,
        evidenceRefs: [CONTENT_REF],
        counterexampleRefs: [],
        verificationState: 'PROVEN' as const,
        freshness: { boundDigest: 'CURR', evaluatedAt: NOW, stale: false },
      };
      expect(ProofClaim.parse(claim)).toEqual(claim);
    });

    it('ProofGraphProjection parses with the correct version literal', () => {
      const projection = {
        version: PROOFGRAPH_SCHEMA_VERSION,
        claims: [],
        evaluatedAt: NOW,
      };
      expect(ProofGraphProjection.parse(projection)).toEqual(projection);
    });

    it('ProofProviderResult parses with a 64-hex result digest', () => {
      const result = {
        claimId: UUID,
        providerKind: 'executed_test' as const,
        providerId: 'executed-test',
        providerVersion: '1.0.0',
        input: { command: 'vitest run' },
        source: { location: 'src/foo.test.ts', stableId: 'test' },
        binding: { kind: 'implementation' as const, digest: 'CURR' },
        status: 'pass' as const,
        resultDigest: SHA,
        executedAt: NOW,
        detail: 'vitest run',
      };
      expect(ProofProviderResult.parse(result)).toEqual(result);
    });

    it('ProofProviderResult parses a structural surface_set binding', () => {
      const result = {
        claimId: UUID,
        providerKind: 'structural_assertion' as const,
        providerId: 'registration-consistency',
        providerVersion: '1.0.0',
        input: { assertion: 'registries agree' },
        source: { location: 'src/integration/installed-commands.ts', stableId: 'registration' },
        binding: {
          kind: 'surface_set' as const,
          surfaceId: 'command-registration',
          digest: 'surface-digest',
          locations: ['src/integration/installed-commands.ts'],
        },
        status: 'pass' as const,
        resultDigest: SHA,
        executedAt: NOW,
      };
      expect(ProofProviderResult.parse(result)).toEqual(result);
    });

    it('ProofProviderResult parses an unavailable result without digests', () => {
      const result = {
        claimId: UUID,
        providerKind: 'executed_test' as const,
        providerId: 'executed-test',
        providerVersion: '1.0.0',
        input: {},
        status: 'unavailable' as const,
        executedAt: NOW,
        detail: 'no implementation validation attempt',
      };
      expect(ProofProviderResult.parse(result)).toEqual(result);
    });

    it('ProofCounterexample parses with an outcome', () => {
      const cx = {
        claimId: UUID,
        scenario: 'mutate the alias target and re-run',
        outcome: 'contradicted' as const,
        boundDigest: 'CURR',
        executedAt: NOW,
      };
      expect(ProofCounterexample.parse(cx)).toEqual(cx);
    });
  });

  describe('BAD', () => {
    const base = {
      claimId: UUID,
      statement: 'x',
      signalClass: 'fact' as const,
      critical: true,
      provenance: AUTHORITY_REF,
      evidenceRefs: [],
      counterexampleRefs: [],
    };

    it('rejects an unknown signalClass', () => {
      expect(() => DeclaredClaim.parse({ ...base, signalClass: 'guess' })).toThrow();
    });

    it('rejects an unknown verificationState', () => {
      expect(() => ProofClaim.parse({ ...base, verificationState: 'MAYBE' })).toThrow();
    });

    it('rejects a wrong projection version literal', () => {
      expect(() =>
        ProofGraphProjection.parse({ version: 'proofgraph.v2', claims: [], evaluatedAt: NOW }),
      ).toThrow();
    });

    it('rejects a non-64-hex result digest', () => {
      expect(() =>
        ProofProviderResult.parse({
          claimId: UUID,
          providerKind: 'executed_test',
          providerId: 'executed-test',
          providerVersion: '1',
          input: { command: 'npm test' },
          source: { location: 'test', stableId: 'test' },
          binding: { kind: 'implementation', digest: 'CURR' },
          status: 'pass',
          resultDigest: 'nothex',
          executedAt: NOW,
        }),
      ).toThrow();
    });

    const validExecuted = {
      claimId: UUID,
      providerKind: 'executed_test' as const,
      providerId: 'executed-test',
      providerVersion: '1',
      input: { command: 'npm test' },
      source: { location: 'test', stableId: 'test' },
      binding: { kind: 'implementation' as const, digest: 'CURR' },
      status: 'pass' as const,
      resultDigest: SHA,
      executedAt: NOW,
    };
    const without = (key: string): Record<string, unknown> => {
      const clone: Record<string, unknown> = { ...validExecuted };
      delete clone[key];
      return clone;
    };

    it('rejects an executed result without a binding', () => {
      expect(() => ProofProviderResult.parse(without('binding'))).toThrow();
    });

    it('rejects an executed result without a source', () => {
      expect(() => ProofProviderResult.parse(without('source'))).toThrow();
    });

    it('rejects an executed result without a result digest', () => {
      expect(() => ProofProviderResult.parse(without('resultDigest'))).toThrow();
    });

    it('rejects an executed result whose input has neither command nor assertion', () => {
      expect(() => ProofProviderResult.parse({ ...validExecuted, input: {} })).toThrow();
    });

    it('rejects an executed result whose input has BOTH command and assertion', () => {
      expect(() =>
        ProofProviderResult.parse({
          ...validExecuted,
          input: { command: 'npm test', assertion: 'x' },
        }),
      ).toThrow();
    });

    const unavailableResult = {
      claimId: UUID,
      providerKind: 'executed_test' as const,
      providerId: 'executed-test',
      providerVersion: '1.0.0',
      input: {},
      status: 'unavailable' as const,
      executedAt: NOW,
    };

    it('rejects unavailable results carrying executed-only fields', () => {
      expect(() =>
        ProofProviderResult.parse({
          ...unavailableResult,
          source: { location: 'x', stableId: 'y' },
          binding: { kind: 'implementation', digest: 'CURR' },
          resultDigest: SHA,
        }),
      ).toThrow();
    });

    it('rejects an unavailable result carrying only a binding', () => {
      expect(() =>
        ProofProviderResult.parse({
          ...unavailableResult,
          binding: { kind: 'implementation', digest: 'CURR' },
        }),
      ).toThrow();
    });

    it('rejects an executed result carrying an unknown field', () => {
      expect(() => ProofProviderResult.parse({ ...validExecuted, bogusField: 'sneaky' })).toThrow();
    });

    it('rejects confidence outside [0, 1]', () => {
      expect(() => DeclaredClaim.parse({ ...base, confidence: 1.5 })).toThrow();
    });

    it('rejects a non-uuid claimId', () => {
      expect(() => DeclaredClaim.parse({ ...base, claimId: 'not-a-uuid' })).toThrow();
    });
  });

  describe('CORNER', () => {
    it('allows empty evidence and counterexample reference arrays', () => {
      const claim = {
        claimId: UUID,
        statement: 'x',
        signalClass: 'derived_signal' as const,
        critical: false,
        provenance: AUTHORITY_REF,
        evidenceRefs: [],
        counterexampleRefs: [],
      };
      expect(DeclaredClaim.parse(claim).evidenceRefs).toEqual([]);
    });

    it('exposes the version literal as a stable constant', () => {
      expect(PROOFGRAPH_SCHEMA_VERSION).toBe('proofgraph.v1');
    });
  });
});
