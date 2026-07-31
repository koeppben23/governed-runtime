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
        provenance: CONTENT_REF,
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
        provenance: CONTENT_REF,
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
        providerVersion: '1.0.0',
        boundDigest: 'CURR',
        status: 'pass' as const,
        resultDigest: SHA,
        executedAt: NOW,
        detail: 'vitest run',
      };
      expect(ProofProviderResult.parse(result)).toEqual(result);
    });

    it('ProofProviderResult parses an unavailable result without digests', () => {
      const result = {
        claimId: UUID,
        providerKind: 'executed_test' as const,
        providerVersion: '1.0.0',
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
      provenance: CONTENT_REF,
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
          providerVersion: '1',
          boundDigest: 'CURR',
          status: 'pass',
          resultDigest: 'nothex',
          executedAt: NOW,
          detail: '',
        }),
      ).toThrow();
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
        provenance: CONTENT_REF,
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
