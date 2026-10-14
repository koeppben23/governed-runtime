/** Canonical certified claim semantics, shared by materialization and approval. */
import { canonicalJsonStringify } from '../shared/canonical-json.js';
import { hashText } from '../shared/hashing.js';
import type { DeclaredClaim, RequiredEvidence } from './proofgraph.js';

/** Structural input port: no dependency back on the certificate authority. */
type ClaimCertificationInput = Pick<
  DeclaredClaim,
  'claimId' | 'statement' | 'critical' | 'counterexampleRequirement' | 'coversRiskTriggers'
> & {
  readonly claimScope: NonNullable<DeclaredClaim['claimScope']>;
  readonly authoritySectionId: string;
  readonly expectedCheckId: string;
  readonly structuralSurface?: string | undefined;
  readonly mutationProfile?: string | undefined;
};

export function requiredEvidenceForDeclaration(
  declaration: Pick<
    ClaimCertificationInput,
    'critical' | 'counterexampleRequirement' | 'structuralSurface' | 'mutationProfile'
  >,
): RequiredEvidence {
  const positive: RequiredEvidence['positive'][number][] = ['executed_test'];
  if (declaration.structuralSurface) {
    positive.push(
      declaration.structuralSurface === 'config-defaults'
        ? 'schema_compare'
        : 'structural_assertion',
    );
  }
  if (declaration.mutationProfile) positive.push('fault_injection');
  return {
    positive,
    adversarial:
      declaration.critical || declaration.counterexampleRequirement !== undefined
        ? ['counterexample']
        : [],
  };
}

function semanticDigest(claim: {
  readonly claimId: string;
  readonly statement: string;
  readonly critical: boolean;
  readonly claimScope?: string | undefined;
  readonly authoritySectionId: string;
  readonly expectedCheckId: string;
  readonly structuralSurface?: string | undefined;
  readonly mutationProfile?: string | undefined;
  readonly counterexampleRequirement?: DeclaredClaim['counterexampleRequirement'];
  readonly coversRiskTriggers?: DeclaredClaim['coversRiskTriggers'];
  readonly requiredEvidence?: RequiredEvidence | undefined;
}): string {
  return hashText(
    canonicalJsonStringify({
      ...claim,
      statement: claim.statement.trim().replace(/\s+/g, ' ').toLowerCase(),
      counterexampleRequirement: claim.counterexampleRequirement ?? null,
      structuralSurface: claim.structuralSurface ?? null,
      mutationProfile: claim.mutationProfile ?? null,
      coversRiskTriggers: [...(claim.coversRiskTriggers ?? [])].sort(),
      requiredEvidence:
        claim.requiredEvidence === undefined
          ? null
          : {
              positive: [...claim.requiredEvidence.positive].sort(),
              adversarial: [...claim.requiredEvidence.adversarial].sort(),
            },
    }),
  );
}

export function certifiedClaimDigest(declaration: ClaimCertificationInput): string {
  return semanticDigest({
    ...declaration,
    requiredEvidence: requiredEvidenceForDeclaration(declaration),
  });
}

/** Recompute from actual contract semantics; a copied digest alone is never authority. */
export function materializedClaimDigest(claim: DeclaredClaim): string | null {
  const origin = claim.certifiedPlan;
  if (origin === undefined || claim.signalClass !== 'fact') return null;
  return semanticDigest({
    claimId: claim.claimId,
    statement: claim.statement,
    critical: claim.critical,
    claimScope: claim.claimScope,
    authoritySectionId: origin.authoritySectionId,
    expectedCheckId: origin.expectedCheckId,
    structuralSurface: origin.structuralSurface,
    mutationProfile: origin.mutationProfile,
    counterexampleRequirement: claim.counterexampleRequirement,
    coversRiskTriggers: claim.coversRiskTriggers,
    requiredEvidence: claim.requiredEvidence,
  });
}
