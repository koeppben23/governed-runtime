/**
 * @module audit/proofgraph/gate.test
 * @description Pure ProofGraph gate decision (#762): default-off, fact-only,
 * critical, PROVEN-required.
 */
import { describe, it, expect } from 'vitest';
import { evaluateProofGraphGate } from './gate.js';
import type { ProofGraphSummary } from './summary.js';
import type { ProofClaim } from '../../state/proofgraph.js';
import type { ClaimVerificationState, SignalClass } from '../../state/proofgraph-primitives.js';

const NOW = '2026-01-01T00:00:00.000Z';

function claim(
  claimId: string,
  opts: { signalClass?: SignalClass; critical?: boolean; state?: ClaimVerificationState } = {},
): ProofClaim {
  return {
    claimId,
    statement: 'x',
    signalClass: opts.signalClass ?? 'fact',
    critical: opts.critical ?? true,
    provenance: { kind: 'content', digest: 'd' },
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
  };
}

const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('evaluateProofGraphGate', () => {
  it('does not gate when the policy is absent', () => {
    const decision = evaluateProofGraphGate(
      summary([claim(UUID(1), { state: 'UNPROVEN' })]),
      undefined,
    );
    expect(decision).toMatchObject({ enforced: false, gated: false, blockingClaimIds: [] });
  });

  it('does not gate when the policy is disabled', () => {
    const decision = evaluateProofGraphGate(summary([claim(UUID(1), { state: 'UNPROVEN' })]), {
      enabled: false,
    });
    expect(decision.enforced).toBe(false);
    expect(decision.gated).toBe(false);
  });

  it('does not gate an enabled policy when all critical fact claims are PROVEN', () => {
    const decision = evaluateProofGraphGate(summary([claim(UUID(1), { state: 'PROVEN' })]), {
      enabled: true,
    });
    expect(decision).toMatchObject({ enforced: true, gated: false, blockingClaimIds: [] });
  });

  it('gates on a critical fact claim that is not PROVEN', () => {
    const decision = evaluateProofGraphGate(summary([claim(UUID(1), { state: 'UNPROVEN' })]), {
      enabled: true,
    });
    expect(decision.gated).toBe(true);
    expect(decision.blockingClaimIds).toEqual([UUID(1)]);
  });

  it('gates on a critical fact claim that is CONTRADICTED', () => {
    const decision = evaluateProofGraphGate(summary([claim(UUID(1), { state: 'CONTRADICTED' })]), {
      enabled: true,
    });
    expect(decision.gated).toBe(true);
  });

  it('does not gate a non-critical fact claim', () => {
    const decision = evaluateProofGraphGate(
      summary([claim(UUID(1), { critical: false, state: 'UNPROVEN' })]),
      { enabled: true },
    );
    expect(decision.gated).toBe(false);
  });

  it('does not gate a critical derived_signal or hypothesis claim (fact-only)', () => {
    const claims = [
      claim(UUID(1), { signalClass: 'derived_signal', state: 'UNPROVEN' }),
      claim(UUID(2), { signalClass: 'hypothesis', state: 'CONTRADICTED' }),
    ];
    const decision = evaluateProofGraphGate(summary(claims), { enabled: true });
    expect(decision.gated).toBe(false);
    expect(decision.blockingClaimIds).toEqual([]);
  });
});
