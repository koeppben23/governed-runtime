/**
 * @module audit/proofgraph/gate.test
 * @description Pure ProofGraph gate decision (#762): unconditional, fact-only,
 * critical, PROVEN-required.
 *
 * Enforcement is no longer policy-switchable. What bounds the blast radius is
 * the eligibility rule itself, so these tests pin exactly which claims can and
 * cannot block.
 */
import { describe, it, expect } from 'vitest';
import { evaluateProofGraphGate } from './gate.js';
import type { ProofGraphSummary } from './summary.js';
import type { ProofClaim } from '../../state/proofgraph.js';
import type { ClaimVerificationState, SignalClass } from '../../state/proofgraph-primitives.js';

const NOW = '2026-01-01T00:00:00.000Z';

const APPROVAL = {
  certificateId: '00000000-0000-4000-8000-0000000000ce',
  claimDeclarationsDigest: 'a'.repeat(64),
  decisionAttestationDigest: 'b'.repeat(64),
  declarationId: '00000000-0000-4000-8000-0000000000de',
} as const;

function claim(
  claimId: string,
  opts: {
    signalClass?: SignalClass;
    critical?: boolean;
    state?: ClaimVerificationState;
    /** Omit to model a self-declared claim that never passed a human approval. */
    certified?: boolean;
  } = {},
): ProofClaim {
  return {
    claimId,
    statement: 'x',
    signalClass: opts.signalClass ?? 'fact',
    critical: opts.critical ?? true,
    provenance: {
      kind: 'canonical_authority',
      authorityId: 'plan',
      digest: 'd',
      ...(opts.certified === false ? {} : { approval: APPROVAL }),
    },
    evidenceRefs: [],
    counterexampleRefs: [],
    verificationState: opts.state ?? 'PROVEN',
  };
}

function summary(claims: ProofClaim[]): ProofGraphSummary {
  return {
    projection: { version: 'proofgraph.v1', claims, evaluatedAt: NOW },
    counts: { PROVEN: 0, UNPROVEN: 0, CONTRADICTED: 0, STALE: 0, BLOCKED: 0, NOT_VERIFIED: 0 },
    criticalClaimCount: 0,
    criticalUnprovenCount: 0,
    counterexamples: [],
    mutation: [],
    unresolvedAssumptions: [],
  };
}

const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('evaluateProofGraphGate', () => {
  it('does not gate a session without any claims', () => {
    const decision = evaluateProofGraphGate(summary([]));
    expect(decision).toMatchObject({ enforced: true, gated: false, blockingClaimIds: [] });
  });

  it('blocks when a certificate-authorized critical claim is absent from the projection', () => {
    const decision = evaluateProofGraphGate({
      authorizedCriticalClaimIds: [UUID(1)],
    });
    expect(decision).toMatchObject({
      gated: true,
      kind: 'evaluation_unavailable',
      blockingClaimIds: [UUID(1)],
    });
  });

  it('reports enforcement as unconditional', () => {
    // Compatibility constant: consumers of flowguard_status still read this field.
    expect(evaluateProofGraphGate(summary([])).enforced).toBe(true);
  });

  it('does not gate when all critical fact claims are PROVEN', () => {
    const decision = evaluateProofGraphGate(summary([claim(UUID(1), { state: 'PROVEN' })]));
    expect(decision).toMatchObject({ enforced: true, gated: false, blockingClaimIds: [] });
    // The reason a reviewer reads must match the verdict, not merely exist.
    expect(decision.reason).toBe('All critical fact claims are PROVEN.');
  });

  it('gates on a critical fact claim that is not PROVEN', () => {
    const decision = evaluateProofGraphGate(summary([claim(UUID(1), { state: 'UNPROVEN' })]));
    expect(decision.gated).toBe(true);
    expect(decision.blockingClaimIds).toEqual([UUID(1)]);
    expect(decision.reason).toBe('1 critical fact claim(s) are not PROVEN.');
  });

  it('counts every blocking claim in the reason', () => {
    const decision = evaluateProofGraphGate(
      summary([
        claim(UUID(1), { state: 'UNPROVEN' }),
        claim(UUID(2), { state: 'STALE' }),
        claim(UUID(3), { state: 'PROVEN' }),
      ]),
    );
    expect(decision.blockingClaimIds).toEqual([UUID(1), UUID(2)]);
    expect(decision.reason).toBe('2 critical fact claim(s) are not PROVEN.');
  });

  it('gates on a critical fact claim that is CONTRADICTED', () => {
    const decision = evaluateProofGraphGate(summary([claim(UUID(1), { state: 'CONTRADICTED' })]));
    expect(decision.gated).toBe(true);
  });

  it('does not gate a non-critical fact claim', () => {
    const decision = evaluateProofGraphGate(
      summary([claim(UUID(1), { critical: false, state: 'UNPROVEN' })]),
    );
    expect(decision.gated).toBe(false);
  });

  it('does not gate a critical fact claim that carries no approval certificate', () => {
    // Self-declared after implementation: no human ever approved this obligation,
    // so it must stay advisory rather than block the approver.
    const decision = evaluateProofGraphGate(
      summary([claim(UUID(1), { state: 'UNPROVEN', certified: false })]),
    );
    expect(decision.gated).toBe(false);
    expect(decision.blockingClaimIds).toEqual([]);
  });

  it('does not gate a critical derived_signal or hypothesis claim (fact-only)', () => {
    const claims = [
      claim(UUID(1), { signalClass: 'derived_signal', state: 'UNPROVEN' }),
      claim(UUID(2), { signalClass: 'hypothesis', state: 'CONTRADICTED' }),
    ];
    const decision = evaluateProofGraphGate(summary(claims));
    expect(decision.gated).toBe(false);
    expect(decision.blockingClaimIds).toEqual([]);
  });

  it('requires a certified critical fact for a specific risk trigger', () => {
    const decision = evaluateProofGraphGate({
      ...summary([]),
      implementationDigest: 'implementation-digest',
      riskAssessment: {
        implementationDigest: 'implementation-digest',
        riskTriggers: ['state_integrity'],
      },
    });
    expect(decision).toMatchObject({
      gated: true,
      kind: 'critical_fact_required',
      relevantTriggers: ['state_integrity'],
    });
  });

  it('does not impose a critical fact requirement for ceremony_only', () => {
    const decision = evaluateProofGraphGate({
      ...summary([]),
      implementationDigest: 'implementation-digest',
      riskAssessment: {
        implementationDigest: 'implementation-digest',
        riskTriggers: ['ceremony_only'],
      },
    });
    expect(decision).toMatchObject({ gated: false, kind: 'clear', relevantTriggers: [] });
  });

  it('blocks a legacy assessment that has no trigger taxonomy', () => {
    const decision = evaluateProofGraphGate({
      ...summary([]),
      implementationDigest: 'implementation-digest',
      riskAssessment: { implementationDigest: 'implementation-digest' },
    });
    expect(decision).toMatchObject({ gated: true, kind: 'risk_assessment_stale' });
  });
});
