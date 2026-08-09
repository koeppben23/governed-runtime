import { describe, it, expect } from 'vitest';
import type { ProofClaim, AssertionBindingReasonCode } from '../state/proofgraph.js';
import { projectClaimResolutionFacts } from './claim-resolution.js';
import type { ClaimResolutionFacts } from './claim-resolution.js';

function claim(overrides: Partial<ProofClaim> = {}): ProofClaim {
  return {
    claimId: '00000000-0000-0000-0000-000000000001' as any,
    statement: 'The system rejects expired tokens',
    signalClass: 'fact',
    critical: true,
    provenance: null,
    evidenceRefs: [],
    counterexampleRefs: [],
    verificationState: 'PROVEN',
    ...overrides,
  } as ProofClaim;
}

describe('projectClaimResolutionFacts', () => {
  it('projects PROVEN claim with all canonical fields', () => {
    const c: ProofClaim = {
      claimId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      statement: 'The system rejects expired tokens',
      signalClass: 'fact',
      critical: true,
      claimScope: 'specific_behavior',
      provenance: {
        kind: 'canonical_authority',
        authorityId: 'plan',
        digest: 'abc123',
      },
      evidenceRefs: [],
      counterexampleRefs: [],
      requiredEvidence: { positive: ['executed_test'], adversarial: ['counterexample'] },
      counterexampleRequirement: {
        kind: 'assertion',
        checkId: 'test',
        assertion: { providerId: 'vitest', localId: 'test#expiredToken' },
      },
      verificationState: 'PROVEN',
      freshness: { boundDigest: 'aaabbb', evaluatedAt: '2025-01-01T00:00:00Z', stale: false },
    } as any;

    const facts = projectClaimResolutionFacts(c, 'evidence_missing');
    expect(facts.claimId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(facts.statement).toBe('The system rejects expired tokens');
    expect(facts.critical).toBe(true);
    expect(facts.signalClass).toBe('fact');
    expect(facts.claimScope).toBe('specific_behavior');
    expect(facts.verificationState).toBe('PROVEN');
    expect(facts.freshness).toEqual({
      boundDigest: 'aaabbb',
      evaluatedAt: '2025-01-01T00:00:00Z',
      stale: false,
    });
    expect(facts.requiredEvidence).toEqual({
      positive: ['executed_test'],
      adversarial: ['counterexample'],
    });
    expect(facts.counterexampleRequirement).toEqual({
      kind: 'assertion',
      checkId: 'test',
      assertion: { providerId: 'vitest', localId: 'test#expiredToken' },
    });
    expect(facts.bindingDiagnostic).toBe('evidence_missing');
    expect(facts.provenance).toEqual({
      kind: 'canonical_authority',
      authorityId: 'plan',
      digest: 'abc123',
    });
  });

  it('handles aggregate_check counterexample with candidateId', () => {
    const c = claim({
      claimScope: 'suite',
      counterexampleRequirement: {
        kind: 'aggregate_check',
        checkId: 'ci',
        candidateId: 'cand-1',
      },
    } as any);

    const facts = projectClaimResolutionFacts(c);
    expect(facts.counterexampleRequirement).toEqual({
      kind: 'aggregate_check',
      checkId: 'ci',
      candidateId: 'cand-1',
    });
  });

  it('handles aggregate_check without candidateId', () => {
    const c = claim({
      counterexampleRequirement: {
        kind: 'aggregate_check',
        checkId: 'ci',
      },
    } as any);

    const facts = projectClaimResolutionFacts(c);
    expect(facts.counterexampleRequirement).toEqual({
      kind: 'aggregate_check',
      checkId: 'ci',
    });
    expect((facts.counterexampleRequirement as any).candidateId).toBeUndefined();
  });

  it('normalizes legacy v1 counterexample requirement as legacy_assertion', () => {
    const c = claim({
      counterexampleRequirement: {
        checkId: 'old-test',
        assertion: { providerId: 'junit', localId: 'test#thing' },
      },
    } as any);

    const facts = projectClaimResolutionFacts(c);
    expect(facts.counterexampleRequirement).toEqual({
      kind: 'legacy_assertion',
      checkId: 'old-test',
      assertion: { providerId: 'junit', localId: 'test#thing' },
    });
  });

  it('handles absent claimScope', () => {
    const facts = projectClaimResolutionFacts(claim({ claimScope: undefined }));
    expect(facts.claimScope).toBeUndefined();
  });

  it('handles absent requiredEvidence', () => {
    const facts = projectClaimResolutionFacts(claim({ requiredEvidence: undefined }));
    expect(facts.requiredEvidence).toBeUndefined();
  });

  it('handles absent counterexampleRequirement', () => {
    const facts = projectClaimResolutionFacts(claim({ counterexampleRequirement: undefined }));
    expect(facts.counterexampleRequirement).toBeUndefined();
  });

  it('handles absent freshness', () => {
    const facts = projectClaimResolutionFacts(claim({ freshness: undefined }));
    expect(facts.freshness).toBeUndefined();
  });

  it('handles null provenance (unsourced claim)', () => {
    const facts = projectClaimResolutionFacts(claim({ provenance: null }));
    expect(facts.provenance).toBeUndefined();
  });

  it('handles absent binding diagnostic', () => {
    const facts = projectClaimResolutionFacts(claim(), undefined);
    expect(facts.bindingDiagnostic).toBeUndefined();
  });

  it('preserves statement verbatim', () => {
    const c = claim({ statement: 'EXACT claim with weird chars: !@#$%' });
    const facts = projectClaimResolutionFacts(c);
    expect(facts.statement).toBe('EXACT claim with weird chars: !@#$%');
  });

  it('preserves signalClass', () => {
    const facts = projectClaimResolutionFacts(claim({ signalClass: 'hypothesis' }));
    expect(facts.signalClass).toBe('hypothesis');
  });

  it('handles empty requiredEvidence arrays', () => {
    const c = claim({ requiredEvidence: { positive: [], adversarial: [] } });
    const facts = projectClaimResolutionFacts(c);
    expect(facts.requiredEvidence).toBeUndefined();
  });

  it('projects approved_ticket provenance', () => {
    const c = claim({
      provenance: { kind: 'approved_ticket', ticketDigest: 'feedbeef' },
    } as any);
    const facts = projectClaimResolutionFacts(c);
    expect(facts.provenance).toEqual({ kind: 'approved_ticket', digest: 'feedbeef' });
  });
});
