import { describe, expect, it } from 'vitest';
import { evaluateProofGraphGate } from './gate.js';
import type { ProofClaim, ProofGraphProjection } from '../../state/proofgraph.js';
import type { AssertionBindingReasonCode } from '../../state/proofgraph.js';

const NOW = '2026-01-01T00:00:00.000Z';
const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const APPROVAL = {
  certificateId: '00000000-0000-4000-8000-0000000000ce',
  claimDeclarationsDigest: 'a'.repeat(64),
  decisionAttestationDigest: 'b'.repeat(64),
  declarationId: '00000000-0000-4000-8000-0000000000de',
} as const;

function notVerifiedClaim(claimId: string): ProofClaim {
  return {
    claimId,
    statement: 'x',
    signalClass: 'fact',
    critical: true,
    provenance: {
      kind: 'canonical_authority',
      authorityId: 'plan',
      digest: 'd',
      approval: APPROVAL,
    },
    evidenceRefs: [],
    counterexampleRefs: [],
    verificationState: 'NOT_VERIFIED',
  };
}

function projectionWithDiagnostics(claimId: string, code: string): ProofGraphProjection {
  return {
    version: 'proofgraph.v1',
    claims: [notVerifiedClaim(claimId)],
    evaluatedAt: NOW,
    // The runtime filter is exactly what these tests probe; the schema record
    // type cannot express deliberately invalid codes.
    claimDiagnostics: { [claimId]: code } as Record<string, AssertionBindingReasonCode>,
  };
}

describe('gate claimDiagnostics passthrough', () => {
  const VALID_CODES: readonly AssertionBindingReasonCode[] = [
    'check_mismatch',
    'check_only_evidence',
    'provider_mismatch',
    'assertion_mismatch',
    'aggregate_check_mismatch',
    'aggregate_candidate_mismatch',
    'aggregate_scope_unattested',
    'aggregate_extraction_missing',
    'aggregate_capability_missing',
  ];

  for (const code of VALID_CODES) {
    it(`passes the ${code} binding diagnostic through to the blocking reason`, () => {
      const decision = evaluateProofGraphGate({
        projection: projectionWithDiagnostics(UUID(1), code),
      });
      expect(decision.gated).toBe(true);
      expect(decision.blockingClaims[0]?.reasonCode).toBe(code);
    });
  }

  it('drops invalid binding codes and falls back to evidence_missing', () => {
    const decision = evaluateProofGraphGate({
      projection: projectionWithDiagnostics(UUID(1), 'garbage-code'),
    });
    expect(decision.gated).toBe(true);
    expect(decision.blockingClaims[0]?.reasonCode).toBe('evidence_missing');
  });

  it('keeps valid codes while dropping invalid entries in the same projection', () => {
    const claimId = UUID(1);
    const projection: ProofGraphProjection = {
      version: 'proofgraph.v1',
      claims: [notVerifiedClaim(claimId)],
      evaluatedAt: NOW,
      claimDiagnostics: {
        [claimId]: 'provider_mismatch',
        [UUID(9)]: 'garbage-code',
      } as Record<string, AssertionBindingReasonCode>,
    };
    const decision = evaluateProofGraphGate({ projection });
    expect(decision.blockingClaims[0]?.reasonCode).toBe('provider_mismatch');
  });
});
