/**
 * @module audit/proofgraph/enforcement-projection.test
 * @description Tests for governance/blocking proofgraph enforcement projection.
 */

import { describe, expect, it } from 'vitest';
import { computeProofGraphEnforcement } from './enforcement-projection.js';
import type { ProofGraphSummary } from './summary.js';

function summary(claims: unknown[] = []): {
  projection: ProofGraphSummary['projection'];
} {
  return {
    projection: {
      version: 'proofgraph.v1',
      claims: claims as never,
      evaluatedAt: '2026-01-01T00:00:00.000Z',
    },
  };
}

function provenClaim(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    claimId: 'c1',
    statement: 'System satisfies constraint X',
    critical: true,
    signalClass: 'fact',
    provenance: {
      kind: 'canonical_authority',
      authorityId: 'auth-1',
      digest: 'a'.repeat(64),
      approval: {
        certificateId: '00000000-0000-4000-8000-000000000001',
        claimDeclarationsDigest: 'a'.repeat(64),
        decisionAttestationDigest: 'b'.repeat(64),
        declarationId: '00000000-0000-4000-8000-000000000002',
      },
    },
    verificationState: 'PROVEN',
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
    expect(result.claims[0]!.reasonCodes).toContain('proven');
    expect(result.claims[0]!.registryCode).toBeDefined();
  });

  it('gated when a claim is NOT_VERIFIED', () => {
    const result = computeProofGraphEnforcement({
      projection: summary([provenClaim({ claimId: 'c1', verificationState: 'NOT_VERIFIED' })])
        .projection,
      authorizedCriticalClaimIds: ['c1'],
    });

    expect(result.satisfied).toBe(false);
    expect(result.decisionKind).toBe('facts_unproven');
    expect(result.blockingClaims[0]!.reasonCode).toBe('evidence_missing');
  });

  it('gated when a claim is CONTRADICTED', () => {
    const result = computeProofGraphEnforcement({
      projection: summary([provenClaim({ verificationState: 'CONTRADICTED' })]).projection,
      authorizedCriticalClaimIds: ['c1'],
    });

    expect(result.blockingClaims[0]!.reasonCode).toBe('counterexample_observed');
  });

  it('gated when a claim is STALE', () => {
    const result = computeProofGraphEnforcement({
      projection: summary([provenClaim({ verificationState: 'STALE' })]).projection,
      authorizedCriticalClaimIds: ['c1'],
    });

    expect(result.blockingClaims[0]!.reasonCode).toBe('evidence_stale');
  });

  it('evaluation_unavailable when authorized claim missing from projection', () => {
    const result = computeProofGraphEnforcement({
      projection: summary([]).projection,
      authorizedCriticalClaimIds: ['missing-claim'],
    });

    expect(result.satisfied).toBe(false);
    expect(result.decisionKind).toBe('evaluation_unavailable');
    expect(result.blockingClaims[0]!.reasonCode).toBe('evaluation_unavailable');
  });

  it('critical_fact_required when risk triggers exist but no eligible claims', () => {
    const result = computeProofGraphEnforcement({
      projection: summary([]).projection,
      authorizedCriticalClaimIds: [],
      riskTriggersPresent: true,
    });

    expect(result.decisionKind).toBe('critical_fact_required');
    expect(result.reasonCode).toBe('critical_fact_required');
  });

  it('riskAssessmentActive causes stale decision', () => {
    const result = computeProofGraphEnforcement({
      projection: summary([provenClaim()]).projection,
      authorizedCriticalClaimIds: ['c1'],
      riskAssessmentActive: true,
    });

    expect(result.decisionKind).toBe('risk_assessment_stale');
    expect(result.reasonCode).toBe('risk_assessment_stale');
  });

  it('clear when no authorized claims and no risk triggers', () => {
    const result = computeProofGraphEnforcement({
      projection: summary([]).projection,
      authorizedCriticalClaimIds: [],
      riskTriggersPresent: false,
    });

    expect(result.satisfied).toBe(true);
  });

  it('reasonCode is proven when satisfied', () => {
    const result = computeProofGraphEnforcement({
      projection: summary([provenClaim()]).projection,
      authorizedCriticalClaimIds: ['c1'],
    });

    expect(result.reasonCode).toBe('proven');
  });
});
