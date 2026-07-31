/**
 * @module audit/proofgraph/evaluate.test
 * @description Deterministic evaluator tests: all six verification states,
 * precedence ordering, freshness/staleness, missing-vs-failed provider
 * distinction, and determinism.
 */
import { describe, it, expect } from 'vitest';
import { evaluateProofGraph } from './evaluate.js';
import type { ProofGraphEvaluationInput } from './evaluate.js';
import { DeclaredClaim, ProofProviderResult, ProofCounterexample } from '../../state/proofgraph.js';
import type {
  DeclaredClaim as DeclaredClaimType,
  ProofProviderResult as ProofProviderResultType,
  ProofCounterexample as ProofCounterexampleType,
  RequiredEvidence,
} from '../../state/proofgraph.js';

const AUTHORITY_REF = {
  kind: 'canonical_authority' as const,
  authorityId: 'ticket',
  digest: 'authority-digest',
};
const SHA = 'a'.repeat(64);
const NOW = '2026-01-01T00:00:00.000Z';
const CURR = 'impl-digest-current';
const OLD = 'impl-digest-old';

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function claim(id: string, overrides: Partial<DeclaredClaimType> = {}): DeclaredClaimType {
  return DeclaredClaim.parse({
    claimId: id,
    statement: 'claim',
    signalClass: 'fact',
    critical: true,
    provenance: AUTHORITY_REF,
    evidenceRefs: [],
    counterexampleRefs: [],
    ...overrides,
  });
}

function result(
  claimId: string,
  status: ProofProviderResultType['status'],
  boundDigest: string = CURR,
): ProofProviderResultType {
  if (status === 'unavailable') {
    return ProofProviderResult.parse({
      claimId,
      providerKind: 'executed_test',
      providerId: 'executed-test',
      providerVersion: '1.0.0',
      input: {},
      status: 'unavailable',
      executedAt: NOW,
    });
  }
  return ProofProviderResult.parse({
    claimId,
    providerKind: 'executed_test',
    providerId: 'executed-test',
    providerVersion: '1.0.0',
    input: { command: 'npm test' },
    source: { location: 'test', stableId: claimId },
    binding: { kind: 'implementation', digest: boundDigest },
    status,
    resultDigest: SHA,
    executedAt: NOW,
  });
}

function counterexample(
  claimId: string,
  outcome: ProofCounterexampleType['outcome'],
  boundDigest: string = CURR,
): ProofCounterexampleType {
  return ProofCounterexample.parse({
    claimId,
    scenario: 'falsify',
    outcome,
    boundDigest,
    executedAt: NOW,
  });
}

function evaluate(
  overrides: Partial<ProofGraphEvaluationInput>,
): ReturnType<typeof evaluateProofGraph> {
  const input: ProofGraphEvaluationInput = {
    claims: [],
    providerResults: [],
    counterexamples: [],
    currentImplementationDigest: CURR,
    ...overrides,
  };
  return evaluateProofGraph(input, NOW);
}

describe('evaluateProofGraph', () => {
  describe('the six verification states', () => {
    it('NOT_VERIFIED when provenance is missing (mandatory provenance)', () => {
      const c = claim(uuid(1), { provenance: null });
      const out = evaluate({ claims: [c], providerResults: [result(uuid(1), 'pass')] });
      expect(out.claims[0]!.verificationState).toBe('NOT_VERIFIED');
    });

    it('CONTRADICTED when a counterexample falsified the claim', () => {
      const out = evaluate({
        claims: [claim(uuid(1))],
        providerResults: [result(uuid(1), 'pass')],
        counterexamples: [counterexample(uuid(1), 'contradicted')],
      });
      expect(out.claims[0]!.verificationState).toBe('CONTRADICTED');
    });

    it('BLOCKED when a provider errored (execution problem)', () => {
      const out = evaluate({
        claims: [claim(uuid(1))],
        providerResults: [result(uuid(1), 'error')],
      });
      expect(out.claims[0]!.verificationState).toBe('BLOCKED');
    });

    it('NOT_VERIFIED when a required provider was unavailable', () => {
      const out = evaluate({
        claims: [claim(uuid(1))],
        providerResults: [result(uuid(1), 'unavailable')],
      });
      expect(out.claims[0]!.verificationState).toBe('NOT_VERIFIED');
    });

    it('UNPROVEN when a provider reported a failing verdict', () => {
      const out = evaluate({
        claims: [claim(uuid(1))],
        providerResults: [result(uuid(1), 'fail')],
      });
      expect(out.claims[0]!.verificationState).toBe('UNPROVEN');
    });

    it('PROVEN when fresh passing evidence exists', () => {
      const out = evaluate({
        claims: [claim(uuid(1))],
        providerResults: [result(uuid(1), 'pass', CURR)],
      });
      expect(out.claims[0]!.verificationState).toBe('PROVEN');
      expect(out.claims[0]!.freshness).toEqual({
        boundDigest: CURR,
        evaluatedAt: NOW,
        stale: false,
      });
    });

    it('STALE when the only passing evidence is bound to an old revision', () => {
      const out = evaluate({
        claims: [claim(uuid(1))],
        providerResults: [result(uuid(1), 'pass', OLD)],
      });
      expect(out.claims[0]!.verificationState).toBe('STALE');
      expect(out.claims[0]!.freshness).toEqual({ boundDigest: OLD, evaluatedAt: NOW, stale: true });
    });

    it('UNPROVEN when declared with provenance but no evidence', () => {
      const out = evaluate({ claims: [claim(uuid(1))] });
      expect(out.claims[0]!.verificationState).toBe('UNPROVEN');
      expect(out.claims[0]!.freshness).toBeUndefined();
    });
  });

  describe('precedence (first match wins)', () => {
    it('CONTRADICTED wins over a fresh passing result', () => {
      const out = evaluate({
        claims: [claim(uuid(1))],
        providerResults: [result(uuid(1), 'pass', CURR)],
        counterexamples: [counterexample(uuid(1), 'contradicted')],
      });
      expect(out.claims[0]!.verificationState).toBe('CONTRADICTED');
    });

    it('BLOCKED (error) wins over a failing verdict', () => {
      const out = evaluate({
        claims: [claim(uuid(1))],
        providerResults: [result(uuid(1), 'fail'), result(uuid(1), 'error')],
      });
      expect(out.claims[0]!.verificationState).toBe('BLOCKED');
    });

    it('a fresh fail keeps the claim UNPROVEN despite stale passing evidence', () => {
      const out = evaluate({
        claims: [claim(uuid(1))],
        providerResults: [result(uuid(1), 'pass', OLD), result(uuid(1), 'fail', CURR)],
      });
      expect(out.claims[0]!.verificationState).toBe('UNPROVEN');
    });

    it('a supported (non-contradicting) counterexample does not block PROVEN', () => {
      const out = evaluate({
        claims: [claim(uuid(1))],
        providerResults: [result(uuid(1), 'pass', CURR)],
        counterexamples: [counterexample(uuid(1), 'supported')],
      });
      expect(out.claims[0]!.verificationState).toBe('PROVEN');
    });
  });

  describe('freshness edge cases', () => {
    it('treats passing evidence as STALE when there is no current implementation digest', () => {
      const out = evaluate({
        claims: [claim(uuid(1))],
        providerResults: [result(uuid(1), 'pass', OLD)],
        currentImplementationDigest: null,
      });
      expect(out.claims[0]!.verificationState).toBe('STALE');
    });

    it('prefers a fresh passing result over a co-existing stale one', () => {
      const out = evaluate({
        claims: [claim(uuid(1))],
        providerResults: [result(uuid(1), 'pass', OLD), result(uuid(1), 'pass', CURR)],
      });
      expect(out.claims[0]!.verificationState).toBe('PROVEN');
      expect(out.claims[0]!.freshness?.stale).toBe(false);
    });
  });

  describe('non-fact signals still receive a state (blocking is a policy concern)', () => {
    it('a hypothesis with fresh passing evidence is PROVEN as a state', () => {
      const out = evaluate({
        claims: [claim(uuid(1), { signalClass: 'hypothesis', critical: false })],
        providerResults: [result(uuid(1), 'pass', CURR)],
      });
      expect(out.claims[0]!.verificationState).toBe('PROVEN');
    });
  });

  describe('surface-bound structural / schema evidence', () => {
    const SURFACE_ID = 'command-registration';
    const SURFACE_DIGEST = 'surface-current';
    const surfaces = { [SURFACE_ID]: SURFACE_DIGEST };

    function structuralResult(
      claimId: string,
      status: ProofProviderResultType['status'],
      surfaceDigest: string = SURFACE_DIGEST,
    ): ProofProviderResultType {
      return ProofProviderResult.parse({
        claimId,
        providerKind: 'structural_assertion',
        providerId: 'registration-consistency',
        providerVersion: '1.0.0',
        input: { assertion: 'registries agree' },
        source: { location: 'src/integration/installed-commands.ts', stableId: 'registration' },
        binding: {
          kind: 'surface_set',
          surfaceId: SURFACE_ID,
          digest: surfaceDigest,
          locations: ['src/integration/installed-commands.ts'],
        },
        status,
        resultDigest: SHA,
        executedAt: NOW,
      });
    }

    it('PROVEN for a passing structural assertion whose surface digest is current', () => {
      const out = evaluate({
        claims: [claim(uuid(1))],
        providerResults: [structuralResult(uuid(1), 'pass')],
        // Structural evidence does not depend on the implementation digest...
        currentImplementationDigest: null,
        currentSurfaceDigests: surfaces,
      });
      expect(out.claims[0]!.verificationState).toBe('PROVEN');
      expect(out.claims[0]!.freshness).toEqual({
        boundDigest: SURFACE_DIGEST,
        evaluatedAt: NOW,
        stale: false,
      });
    });

    it('STALE when the structural surface digest no longer matches (surface changed)', () => {
      const out = evaluate({
        claims: [claim(uuid(1))],
        providerResults: [structuralResult(uuid(1), 'pass', 'surface-old')],
        currentSurfaceDigests: surfaces,
      });
      expect(out.claims[0]!.verificationState).toBe('STALE');
      expect(out.claims[0]!.freshness).toEqual({
        boundDigest: 'surface-old',
        evaluatedAt: NOW,
        stale: true,
      });
    });

    it('STALE when no current digest is known for the structural surface', () => {
      const out = evaluate({
        claims: [claim(uuid(1))],
        providerResults: [structuralResult(uuid(1), 'pass')],
        currentSurfaceDigests: {},
      });
      expect(out.claims[0]!.verificationState).toBe('STALE');
    });

    it('a failing structural assertion is UNPROVEN', () => {
      const out = evaluate({
        claims: [claim(uuid(1))],
        providerResults: [structuralResult(uuid(1), 'fail')],
        currentSurfaceDigests: surfaces,
      });
      expect(out.claims[0]!.verificationState).toBe('UNPROVEN');
    });

    it('still marks a stale executed-test result as STALE (revision-bound unchanged)', () => {
      const out = evaluate({
        claims: [claim(uuid(1))],
        providerResults: [result(uuid(1), 'pass', OLD)],
      });
      expect(out.claims[0]!.verificationState).toBe('STALE');
    });
  });

  describe('policy-required evidence (adversarial + positive)', () => {
    const req: RequiredEvidence = { positive: ['executed_test'], adversarial: ['counterexample'] };

    it('NOT_VERIFIED: a critical claim requiring a counterexample has none', () => {
      const out = evaluate({
        claims: [claim(uuid(1), { requiredEvidence: req })],
        providerResults: [result(uuid(1), 'pass', CURR)],
      });
      expect(out.claims[0]!.verificationState).toBe('NOT_VERIFIED');
    });

    it('NOT_VERIFIED: a required counterexample that could not be verified does not pass', () => {
      const out = evaluate({
        claims: [claim(uuid(1), { requiredEvidence: req })],
        providerResults: [result(uuid(1), 'pass', CURR)],
        counterexamples: [counterexample(uuid(1), 'not_verified')],
      });
      expect(out.claims[0]!.verificationState).toBe('NOT_VERIFIED');
    });

    it('PROVEN: a fresh positive pass plus a supported counterexample', () => {
      const out = evaluate({
        claims: [claim(uuid(1), { requiredEvidence: req })],
        providerResults: [result(uuid(1), 'pass', CURR)],
        counterexamples: [counterexample(uuid(1), 'supported')],
      });
      expect(out.claims[0]!.verificationState).toBe('PROVEN');
    });

    it('NOT_VERIFIED: adversarial-required takes precedence even when positive is stale', () => {
      const out = evaluate({
        claims: [claim(uuid(1), { requiredEvidence: req })],
        providerResults: [result(uuid(1), 'pass', OLD)],
      });
      expect(out.claims[0]!.verificationState).toBe('NOT_VERIFIED');
    });

    it('STALE: adversarial satisfied but the required positive pass is stale', () => {
      const out = evaluate({
        claims: [claim(uuid(1), { requiredEvidence: req })],
        providerResults: [result(uuid(1), 'pass', OLD)],
        counterexamples: [counterexample(uuid(1), 'supported')],
      });
      expect(out.claims[0]!.verificationState).toBe('STALE');
    });

    it('UNPROVEN: a fresh pass of the wrong kind does not satisfy an executed_test requirement', () => {
      const structural = ProofProviderResult.parse({
        claimId: uuid(1),
        providerKind: 'structural_assertion',
        providerId: 'x',
        providerVersion: '1',
        input: { assertion: 'a' },
        source: { location: 'l', stableId: 's' },
        binding: { kind: 'surface_set', surfaceId: 'sfc', digest: 'd', locations: ['l'] },
        status: 'pass',
        resultDigest: SHA,
        executedAt: NOW,
      });
      const out = evaluate({
        claims: [
          claim(uuid(1), { requiredEvidence: { positive: ['executed_test'], adversarial: [] } }),
        ],
        providerResults: [structural],
        currentSurfaceDigests: { sfc: 'd' },
      });
      expect(out.claims[0]!.verificationState).toBe('UNPROVEN');
    });
  });

  describe('counterexample freshness (revision-bound)', () => {
    const req: RequiredEvidence = { positive: ['executed_test'], adversarial: ['counterexample'] };

    it('a stale contradicted counterexample does not contradict the current revision', () => {
      const out = evaluate({
        claims: [claim(uuid(1))],
        providerResults: [result(uuid(1), 'pass', CURR)],
        counterexamples: [counterexample(uuid(1), 'contradicted', OLD)],
      });
      expect(out.claims[0]!.verificationState).not.toBe('CONTRADICTED');
      expect(out.claims[0]!.verificationState).toBe('STALE');
    });

    it('a stale supported counterexample does not satisfy an adversarial requirement', () => {
      const out = evaluate({
        claims: [claim(uuid(1), { requiredEvidence: req })],
        providerResults: [result(uuid(1), 'pass', CURR)],
        counterexamples: [counterexample(uuid(1), 'supported', OLD)],
      });
      expect(out.claims[0]!.verificationState).toBe('NOT_VERIFIED');
    });

    it('a fresh contradicted counterexample wins over fresh positive evidence', () => {
      const out = evaluate({
        claims: [claim(uuid(1))],
        providerResults: [result(uuid(1), 'pass', CURR)],
        counterexamples: [counterexample(uuid(1), 'contradicted', CURR)],
      });
      expect(out.claims[0]!.verificationState).toBe('CONTRADICTED');
    });

    it('a fresh supported counterexample satisfies the adversarial requirement (PROVEN)', () => {
      const out = evaluate({
        claims: [claim(uuid(1), { requiredEvidence: req })],
        providerResults: [result(uuid(1), 'pass', CURR)],
        counterexamples: [counterexample(uuid(1), 'supported', CURR)],
      });
      expect(out.claims[0]!.verificationState).toBe('PROVEN');
    });
  });

  describe('determinism', () => {
    it('sorts claims by claimId regardless of input order', () => {
      const out = evaluate({ claims: [claim(uuid(3)), claim(uuid(1)), claim(uuid(2))] });
      expect(out.claims.map((c) => c.claimId)).toEqual([uuid(1), uuid(2), uuid(3)]);
    });

    it('produces byte-identical projections for identical inputs', () => {
      const input: Partial<ProofGraphEvaluationInput> = {
        claims: [claim(uuid(2)), claim(uuid(1))],
        providerResults: [result(uuid(1), 'pass', CURR), result(uuid(2), 'fail')],
        counterexamples: [counterexample(uuid(2), 'contradicted')],
      };
      expect(JSON.stringify(evaluate(input))).toBe(JSON.stringify(evaluate(input)));
    });

    it('stamps the caller-supplied evaluatedAt', () => {
      const out = evaluate({ claims: [claim(uuid(1))] });
      expect(out.evaluatedAt).toBe(NOW);
      expect(out.version).toBe('proofgraph.v1');
    });
  });
});
