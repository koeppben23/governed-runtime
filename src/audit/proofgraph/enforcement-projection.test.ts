/**
 * @module audit/proofgraph/enforcement-projection.test
 * @description Tests for centralized ProofGraph enforcement projection.
 */

import { describe, expect, it } from 'vitest';
import { computeProofGraphEnforcement } from './enforcement-projection.js';
import type { ProofGraphSummary } from './summary.js';

function summary(claims: Partial<ProofGraphSummary['projection']>['claims'] = []): {
  projection: ProofGraphSummary['projection'];
} {
  return {
    projection: {
      version: 'proofgraph.v1',
      claims: (claims ?? []) as never,
      evaluatedAt: '2026-01-01T00:00:00.000Z',
    },
  };
}

function provenClaim(overrides: Record<string, unknown> = {}): any {
  return {
    claimId: 'c1',
    statement: 'System satisfies constraint X',
    critical: true,
    signalClass: 'fact' as const,
    provenance: {
      kind: 'canonical_authority' as const,
      authorityId: 'auth-1',
      digest: 'a'.repeat(64),
      approval: {
        certificateId: '00000000-0000-4000-8000-000000000001',
        claimDeclarationsDigest: 'a'.repeat(64),
        decisionAttestationDigest: 'b'.repeat(64),
        declarationId: '00000000-0000-4000-8000-000000000002',
      },
    },
    verificationState: 'PROVEN' as const,
    freshness: 'fresh',
    evidenceRefs: [],
    counterexampleRefs: [],
    ...overrides,
  };
}

describe('computeProofGraphEnforcement', () => {
  it('satisfied when all eligible claims are PROVEN', () => {
    const result = computeProofGraphEnforcement({
      projection: summary([provenClaim()]).projection,
      authorizedCriticalClaimIds: ['c1'],
    });

    expect(result.satisfied).toBe(true);
    expect(result.decisionKind).toBe('clear');
    expect(result.blockingClaims).toHaveLength(0);
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]!.verificationState).toBe('PROVEN');
  });

  it('gated when a claim is NOT_VERIFIED', () => {
    const result = computeProofGraphEnforcement({
      projection: summary([
        provenClaim({ claimId: 'c1', verificationState: 'NOT_VERIFIED', freshness: undefined }),
      ]).projection,
      authorizedCriticalClaimIds: ['c1'],
    });

    expect(result.satisfied).toBe(false);
    expect(result.decisionKind).toBe('facts_unproven');
    expect(result.blockingClaims).toHaveLength(1);
    expect(result.blockingClaims[0]!.state).toBe('NOT_VERIFIED');
  });

  it('gated when a claim is CONTRADICTED', () => {
    const result = computeProofGraphEnforcement({
      projection: summary([provenClaim({ verificationState: 'CONTRADICTED' })]).projection,
      authorizedCriticalClaimIds: ['c1'],
    });

    expect(result.satisfied).toBe(false);
    expect(result.decisionKind).toBe('facts_unproven');
    expect(result.blockingClaims[0]!.state).toBe('CONTRADICTED');
  });

  it('gated when a claim is STALE', () => {
    const result = computeProofGraphEnforcement({
      projection: summary([provenClaim({ verificationState: 'STALE' })]).projection,
      authorizedCriticalClaimIds: ['c1'],
    });

    expect(result.satisfied).toBe(false);
    expect(result.blockingClaims[0]!.state).toBe('STALE');
  });

  it('evaluation_unavailable when authorized claim missing from projection', () => {
    const result = computeProofGraphEnforcement({
      projection: summary([]).projection,
      authorizedCriticalClaimIds: ['missing-claim'],
    });

    expect(result.satisfied).toBe(false);
    expect(result.decisionKind).toBe('evaluation_unavailable');
    expect(result.blockingClaims).toHaveLength(1);
  });

  it('critical_fact_required when risk triggers exist but no eligible claims', () => {
    const result = computeProofGraphEnforcement({
      projection: summary([]).projection,
      authorizedCriticalClaimIds: [],
      riskTriggersPresent: true,
    });

    expect(result.satisfied).toBe(false);
    expect(result.decisionKind).toBe('critical_fact_required');
  });

  it('riskAssessmentActive causes stale decision', () => {
    const result = computeProofGraphEnforcement({
      projection: summary([provenClaim()]).projection,
      authorizedCriticalClaimIds: ['c1'],
      riskAssessmentActive: true,
    });

    expect(result.satisfied).toBe(false);
    expect(result.decisionKind).toBe('risk_assessment_stale');
  });

  it('clear when no authorized claims and no risk triggers', () => {
    const result = computeProofGraphEnforcement({
      projection: summary([]).projection,
      authorizedCriticalClaimIds: [],
      riskTriggersPresent: false,
    });

    expect(result.satisfied).toBe(true);
    expect(result.decisionKind).toBe('clear');
  });

  it('ignores derived_signal claims for gate', () => {
    const result = computeProofGraphEnforcement({
      projection: summary([provenClaim({ signalClass: 'derived_signal' })]).projection,
      authorizedCriticalClaimIds: [],
    });

    expect(result.claims).toHaveLength(0);
    expect(result.satisfied).toBe(true);
  });

  it('includes claim reasons in enforcement state', () => {
    const result = computeProofGraphEnforcement({
      projection: summary([provenClaim({ claimId: 'c1', verificationState: 'CONTRADICTED' })])
        .projection,
      authorizedCriticalClaimIds: ['c1'],
    });

    expect(result.claims[0]!.reasons).toContain('counterexample_observed');
  });
});
