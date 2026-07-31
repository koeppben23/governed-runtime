/**
 * @module proofgraph-session.test
 * @description SessionState persistence of the optional ProofGraph projection (#762).
 * Proves the field is additive/backward-compatible and fail-closed on malformed input.
 */
import { describe, it, expect } from 'vitest';
import { SessionState } from './schema.js';
import { makeState } from '../fixtures.js';

const NOW = '2026-01-01T00:00:00.000Z';
const PROJECTION = { version: 'proofgraph.v1' as const, claims: [], evaluatedAt: NOW };

describe('SessionState.proofGraph (#762)', () => {
  it('accepts a valid ProofGraph projection', () => {
    const parsed = SessionState.parse(makeState('IMPLEMENTATION', { proofGraph: PROJECTION }));
    expect(parsed.proofGraph).toEqual(PROJECTION);
  });

  it('is optional — absent for sessions created before ProofGraph', () => {
    const parsed = SessionState.parse(makeState('READY'));
    expect(parsed.proofGraph).toBeUndefined();
  });

  it('round-trips a populated projection through JSON', () => {
    const state = makeState('IMPLEMENTATION', {
      proofGraph: {
        version: 'proofgraph.v1',
        claims: [
          {
            claimId: '00000000-0000-4000-8000-000000000001',
            statement: 'x',
            signalClass: 'fact',
            critical: true,
            provenance: { kind: 'content', digest: 'd' },
            evidenceRefs: [],
            counterexampleRefs: [],
            verificationState: 'PROVEN',
            freshness: { boundDigest: 'CURR', evaluatedAt: NOW, stale: false },
          },
        ],
        evaluatedAt: NOW,
      },
    });
    const reparsed = SessionState.parse(JSON.parse(JSON.stringify(state)));
    expect(reparsed.proofGraph?.claims[0]?.verificationState).toBe('PROVEN');
  });

  it('fails closed on a wrong projection version literal', () => {
    const input = {
      ...makeState('READY'),
      proofGraph: { version: 'proofgraph.v2', claims: [], evaluatedAt: NOW },
    } as unknown;
    expect(() => SessionState.parse(input)).toThrow();
  });

  it('fails closed on an invalid claim inside the projection', () => {
    const input = {
      ...makeState('READY'),
      proofGraph: {
        version: 'proofgraph.v1',
        claims: [{ claimId: 'not-a-uuid' }],
        evaluatedAt: NOW,
      },
    } as unknown;
    expect(() => SessionState.parse(input)).toThrow();
  });
});
