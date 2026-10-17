import { describe, expect, it } from 'vitest';
import {
  certifiedClaimDigest,
  materializedClaimDigest,
  requiredEvidenceForDeclaration,
} from './proofgraph-claim-certification.js';
import type { PlanClaimDeclaration } from './proofgraph-approval.js';
import type { DeclaredClaim } from './proofgraph.js';

const declaration: PlanClaimDeclaration = {
  claimId: '00000000-0000-4000-8000-000000000001',
  statement: 'reject invalid state',
  critical: true,
  authoritySectionId: 'state',
  claimScope: 'specific_behavior',
  expectedCheckId: 'test',
  expectedAssertion: { providerId: 'junit', localId: 'fixture.Store#rejectsInvalidState' },
  structuralSurface: 'config-defaults',
  mutationProfile: 'proofgraph-gate',
  counterexampleRequirement: {
    kind: 'assertion',
    checkId: 'security',
    assertion: { providerId: 'junit', localId: 'rejects' },
  },
  coversRiskTriggers: ['state_integrity'],
};
function materialized(): DeclaredClaim {
  return {
    claimId: declaration.claimId,
    statement: declaration.statement,
    critical: true,
    signalClass: 'fact',
    claimScope: declaration.claimScope,
    provenance: null,
    evidenceRefs: [],
    counterexampleRefs: [],
    counterexampleRequirement: declaration.counterexampleRequirement,
    coversRiskTriggers: declaration.coversRiskTriggers,
    requiredEvidence: requiredEvidenceForDeclaration(declaration),
    certifiedPlan: {
      authoritySectionId: declaration.authoritySectionId,
      expectedCheckId: declaration.expectedCheckId,
      expectedAssertion: declaration.expectedAssertion,
      structuralSurface: declaration.structuralSurface,
      mutationProfile: declaration.mutationProfile,
      digest: certifiedClaimDigest(declaration),
    },
  };
}
describe('certified claim semantics', () => {
  it('binds the declaration and actual materialized evidence requirements to the same authority', () => {
    expect(materializedClaimDigest(materialized())).toBe(certifiedClaimDigest(declaration));
  });
  it.each([
    'authoritySectionId',
    'expectedCheckId',
    'structuralSurface',
    'mutationProfile',
  ] as const)('detects %s drift even with a copied digest', (field) => {
    const claim = materialized();
    expect(
      materializedClaimDigest({
        ...claim,
        certifiedPlan: { ...claim.certifiedPlan!, [field]: 'changed' },
      }),
    ).not.toBe(certifiedClaimDigest(declaration));
  });
  it('detects the declared positive assertion drift even with a copied digest', () => {
    const claim = materialized();
    expect(
      materializedClaimDigest({
        ...claim,
        certifiedPlan: {
          ...claim.certifiedPlan!,
          expectedAssertion: { providerId: 'junit', localId: 'other#test' },
        },
      }),
    ).not.toBe(certifiedClaimDigest(declaration));
  });

  it('detects removed adversarial requirements despite an unchanged certified digest', () => {
    const claim = materialized();
    expect(
      materializedClaimDigest({
        ...claim,
        requiredEvidence: { ...claim.requiredEvidence!, adversarial: [] },
      }),
    ).not.toBe(certifiedClaimDigest(declaration));
  });
});
