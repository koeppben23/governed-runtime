import { describe, it, expect } from 'vitest';
import type { ClaimResolutionFacts } from './claim-resolution.js';
import { projectClaimHumanProjection, projectHumanProofSummary } from './claim-human-projection.js';

function facts(overrides: Partial<ClaimResolutionFacts> = {}): ClaimResolutionFacts {
  return {
    claimId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    statement: 'The system rejects expired tokens',
    critical: true,
    signalClass: 'fact',
    claimScope: 'specific_behavior',
    verificationState: 'PROVEN',
    ...overrides,
  };
}

describe('projectClaimHumanProjection', () => {
  it('PROVEN claim produces verified status', () => {
    const p = projectClaimHumanProjection(facts({ verificationState: 'PROVEN' }));
    expect(p.status).toBe('verified');
    expect(p.statusLabel).toBe('Verified');
    expect(p.explanation).toContain('sufficient');
  });

  it('UNPROVEN claim produces not_verified with explanation', () => {
    const p = projectClaimHumanProjection(facts({ verificationState: 'UNPROVEN' }));
    expect(p.status).toBe('not_verified');
    expect(p.statusLabel).toBe('Not verified');
    expect(p.explanation).toContain('does not establish');
  });

  it('NOT_VERIFIED claim produces not_verified status', () => {
    const p = projectClaimHumanProjection(facts({ verificationState: 'NOT_VERIFIED' }));
    expect(p.status).toBe('not_verified');
    expect(p.statusLabel).toBe('Not verified');
  });

  it('CONTRADICTED claim produces failed status', () => {
    const p = projectClaimHumanProjection(facts({ verificationState: 'CONTRADICTED' }));
    expect(p.status).toBe('failed');
    expect(p.statusLabel).toBe('Failed');
    expect(p.explanation).toContain('contradicts');
  });

  it('STALE claim produces needs_recheck status', () => {
    const p = projectClaimHumanProjection(facts({ verificationState: 'STALE' }));
    expect(p.status).toBe('needs_recheck');
    expect(p.statusLabel).toBe('Needs re-check');
  });

  it('BLOCKED claim produces blocked status', () => {
    const p = projectClaimHumanProjection(facts({ verificationState: 'BLOCKED' }));
    expect(p.status).toBe('blocked');
    expect(p.statusLabel).toBe('Blocked');
  });

  it('binding diagnostic overrides the default explanation', () => {
    const p = projectClaimHumanProjection(
      facts({ verificationState: 'NOT_VERIFIED', bindingDiagnostic: 'evidence_missing' }),
    );
    expect(p.explanation).toContain('Compatible assertion evidence');
    expect(p.explanation).not.toContain('Required evidence or provenance');
    expect(p.diagnostic.bindingReason).toBe('evidence_missing');
  });

  it('binding diagnostic for provider_mismatch produces correct explanation', () => {
    const p = projectClaimHumanProjection(
      facts({ verificationState: 'NOT_VERIFIED', bindingDiagnostic: 'provider_mismatch' }),
    );
    expect(p.explanation).toContain('different provider');
  });

  it('binding diagnostic for aggregate_scope_unattested', () => {
    const p = projectClaimHumanProjection(
      facts({
        verificationState: 'NOT_VERIFIED',
        claimScope: 'suite',
        bindingDiagnostic: 'aggregate_scope_unattested',
      }),
    );
    expect(p.explanation).toContain('complete-check evidence');
  });

  it('counterexample requirement renders human label', () => {
    const p = projectClaimHumanProjection(
      facts({
        verificationState: 'NOT_VERIFIED',
        counterexampleRequirement: {
          kind: 'assertion',
          checkId: 'test',
          assertion: { providerId: 'vitest', localId: 'test#token' },
        },
      }),
    );
    expect(p.counterexampleRequirementLabel).toContain('Assertion-level check');
    expect(p.counterexampleRequirementLabel).toContain('`test`');
  });

  it('aggregate counterexample renders complete-check label', () => {
    const p = projectClaimHumanProjection(
      facts({
        verificationState: 'NOT_VERIFIED',
        claimScope: 'suite',
        counterexampleRequirement: {
          kind: 'aggregate_check',
          checkId: 'ci',
        },
      }),
    );
    expect(p.counterexampleRequirementLabel).toContain('Complete-check coverage');
  });

  it('required evidence renders provider kind labels', () => {
    const p = projectClaimHumanProjection(
      facts({
        verificationState: 'PROVEN',
        requiredEvidence: {
          positive: ['executed_test', 'fault_injection'],
          adversarial: ['counterexample'],
        },
      }),
    );
    expect(p.requiredEvidenceLabel).toContain('Test evidence');
    expect(p.requiredEvidenceLabel).toContain('Mutation verification evidence');
  });

  it('absent requiredEvidence omits label', () => {
    const p = projectClaimHumanProjection(facts({ requiredEvidence: undefined }));
    expect(p.requiredEvidenceLabel).toBeUndefined();
  });

  it('absent counterexampleRequirement omits label', () => {
    const p = projectClaimHumanProjection(facts({ counterexampleRequirement: undefined }));
    expect(p.counterexampleRequirementLabel).toBeUndefined();
  });

  it('diagnostic preserves canonical state', () => {
    const p = projectClaimHumanProjection(
      facts({ verificationState: 'NOT_VERIFIED', claimScope: 'specific_behavior' }),
    );
    expect(p.diagnostic.canonicalState).toBe('NOT_VERIFIED');
    expect(p.diagnostic.claimScope).toBe('specific_behavior');
  });

  it('diagnostic exposes bindingReason when present', () => {
    const p = projectClaimHumanProjection(
      facts({ verificationState: 'NOT_VERIFIED', bindingDiagnostic: 'check_mismatch' }),
    );
    expect(p.diagnostic.bindingReason).toBe('check_mismatch');
  });

  it('diagnostic omits bindingReason when absent', () => {
    const p = projectClaimHumanProjection(facts({ verificationState: 'PROVEN' }));
    expect(p.diagnostic.bindingReason).toBeUndefined();
  });

  it('diagnostic exposes freshness when present', () => {
    const p = projectClaimHumanProjection(
      facts({
        verificationState: 'PROVEN',
        freshness: { boundDigest: 'abc123', evaluatedAt: '2025-01-01T00:00:00Z', stale: false },
      }),
    );
    expect(p.diagnostic.freshness).toEqual({
      boundDigest: 'abc123',
      evaluatedAt: '2025-01-01T00:00:00Z',
      stale: false,
    });
  });

  it('diagnostic exposes candidateId from aggregate_check requirement', () => {
    const p = projectClaimHumanProjection(
      facts({
        verificationState: 'NOT_VERIFIED',
        counterexampleRequirement: {
          kind: 'aggregate_check',
          checkId: 'ci',
          candidateId: 'cand-7',
        },
      }),
    );
    expect(p.diagnostic.counterexampleRequirement?.kind).toBe('aggregate_check');
    expect(
      p.diagnostic.counterexampleRequirement?.kind === 'aggregate_check'
        ? p.diagnostic.counterexampleRequirement.candidateId
        : undefined,
    ).toBe('cand-7');
  });

  it('diagnostic preserves the full counterexampleRequirement contract', () => {
    const p = projectClaimHumanProjection(
      facts({
        verificationState: 'NOT_VERIFIED',
        counterexampleRequirement: {
          kind: 'assertion',
          checkId: 'test',
          assertion: { providerId: 'v', localId: 't' },
        },
      }),
    );
    expect(p.diagnostic.counterexampleRequirement).toEqual({
      kind: 'assertion',
      checkId: 'test',
      assertion: { providerId: 'v', localId: 't' },
    });
  });

  it('diagnostic omits counterexampleRequirement when absent', () => {
    const p = projectClaimHumanProjection(
      facts({ verificationState: 'PROVEN', counterexampleRequirement: undefined }),
    );
    expect(p.diagnostic.counterexampleRequirement).toBeUndefined();
  });

  it('diagnostic preserves legacy_assertion kind', () => {
    const p = projectClaimHumanProjection(
      facts({
        verificationState: 'NOT_VERIFIED',
        counterexampleRequirement: {
          kind: 'legacy_assertion',
          checkId: 'old-test',
          assertion: { providerId: 'junit', localId: 'test#thing' },
        },
      }),
    );
    expect(p.diagnostic.counterexampleRequirement?.kind).toBe('legacy_assertion');
  });

  it('preserves statement verbatim in human projection', () => {
    const p = projectClaimHumanProjection(facts({ statement: 'Duarte is HIM' }));
    expect(p.statement).toBe('Duarte is HIM');
  });

  it('critical flag propagates', () => {
    const p = projectClaimHumanProjection(facts({ critical: false }));
    expect(p.critical).toBe(false);
  });

  it('non-critical claim still counts in totals', () => {
    const total = projectHumanProofSummary([
      facts({ critical: false, verificationState: 'PROVEN' }),
      facts({ critical: true, verificationState: 'PROVEN' }),
    ]);
    expect(total.criticalTotal).toBe(1);
    expect(total.criticalVerified).toBe(1);
    expect(total.total).toBe(2);
  });
});

describe('projectHumanProofSummary', () => {
  it('counts verified from PROVEN only', () => {
    const total = projectHumanProofSummary([
      facts({ claimId: '11111111-1111-1111-1111-111111111111', verificationState: 'PROVEN' }),
      facts({ claimId: '22222222-2222-2222-2222-222222222222', verificationState: 'UNPROVEN' }),
      facts({ claimId: '33333333-3333-3333-3333-333333333333', verificationState: 'CONTRADICTED' }),
      facts({ claimId: '44444444-4444-4444-4444-444444444444', verificationState: 'STALE' }),
      facts({ claimId: '55555555-5555-5555-5555-555555555555', verificationState: 'BLOCKED' }),
    ]);
    expect(total.verified).toBe(1);
    expect(total.notVerified).toBe(1);
    expect(total.failed).toBe(1);
    expect(total.needsRecheck).toBe(1);
    expect(total.blocked).toBe(1);
    expect(total.total).toBe(5);
  });

  it('aggregates UNPROVEN and NOT_VERIFIED into notVerified', () => {
    const total = projectHumanProofSummary([
      facts({ claimId: '11111111-1111-1111-1111-111111111111', verificationState: 'UNPROVEN' }),
      facts({ claimId: '22222222-2222-2222-2222-222222222222', verificationState: 'NOT_VERIFIED' }),
    ]);
    expect(total.notVerified).toBe(2);
    expect(total.verified).toBe(0);
  });

  it('empty facts produces zero counts', () => {
    const total = projectHumanProofSummary([]);
    expect(total.total).toBe(0);
    expect(total.claims).toEqual([]);
  });

  it('criticalVerified equals count of PROVEN critical claims', () => {
    const total = projectHumanProofSummary([
      facts({ claimId: 'a', verificationState: 'PROVEN', critical: true }),
      facts({ claimId: 'b', verificationState: 'PROVEN', critical: false }),
      facts({ claimId: 'c', verificationState: 'UNPROVEN', critical: true }),
    ]);
    expect(total.criticalTotal).toBe(2);
    expect(total.criticalVerified).toBe(1);
  });
});
