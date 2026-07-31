/**
 * @module proofgraph-contract.test
 * @description ProofContract (contract.v1) schema and SessionState persistence (#762).
 */
import { describe, it, expect } from 'vitest';
import { ProofContract, PROOFGRAPH_CONTRACT_VERSION } from './proofgraph-contract.js';
import { SessionState } from './schema.js';
import { makeState } from '../fixtures.js';

const UUID = '00000000-0000-4000-8000-000000000001';
const AUTHORITY_REF = {
  kind: 'canonical_authority' as const,
  authorityId: 'ticket',
  digest: 'authority',
};

function declaredClaim() {
  return {
    claimId: UUID,
    statement: 'the schema default matches the runtime default',
    signalClass: 'fact' as const,
    critical: true,
    provenance: AUTHORITY_REF,
    evidenceRefs: [],
    counterexampleRefs: [],
  };
}

describe('ProofContract (contract.v1) — #762', () => {
  it('parses a valid contract', () => {
    const contract = { version: PROOFGRAPH_CONTRACT_VERSION, claims: [declaredClaim()] };
    expect(ProofContract.parse(contract)).toEqual(contract);
  });

  it('accepts an empty claim set', () => {
    expect(ProofContract.parse({ version: 'contract.v1', claims: [] }).claims).toEqual([]);
  });

  it('rejects a wrong version literal', () => {
    expect(() => ProofContract.parse({ version: 'contract.v2', claims: [] })).toThrow();
  });

  it('rejects a claim with an invalid provenance reference', () => {
    const bad = {
      version: 'contract.v1',
      claims: [{ ...declaredClaim(), provenance: { kind: 'bogus' } }],
    };
    expect(() => ProofContract.parse(bad)).toThrow();
  });

  describe('SessionState.proofContract persistence', () => {
    it('accepts a contract on state and is optional/backward-compatible', () => {
      const withContract = SessionState.parse(
        makeState('IMPLEMENTATION', {
          proofContract: { version: 'contract.v1', claims: [declaredClaim()] },
        }),
      );
      expect(withContract.proofContract?.claims).toHaveLength(1);
      expect(SessionState.parse(makeState('READY')).proofContract).toBeUndefined();
    });

    it('fails closed on a malformed contract', () => {
      const input = {
        ...makeState('READY'),
        proofContract: { version: 'contract.v1', claims: [{ claimId: 'not-a-uuid' }] },
      } as unknown;
      expect(() => SessionState.parse(input)).toThrow();
    });
  });
});
