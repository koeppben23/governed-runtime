/**
 * @module presentation/claim-resolution
 * @description Canonical, read-only Claim Resolution Facts projection.
 *
 * Derives ClaimResolutionFacts exclusively from persisted ProofGraph state
 * (ProofClaim + claimDiagnostics). It never inspects evidence objects,
 * recomputes binding satisfaction, or materialises per-reference status.
 *
 * The two canonical requirement contracts are projected separately:
 *
 *   `requiredEvidence`        → RequiredEvidenceProjection
 *   `counterexampleRequirement` → CounterexampleRequirementProjection
 *
 * They are distinct domain authorities; Presentation must not collapse one
 * into the other.
 *
 * @version v1
 */

import type { ProofClaim } from '../state/proofgraph.js';
import type { AssertionBindingReasonCode } from '../state/proofgraph.js';
import type {
  ClaimVerificationState,
  ProofProviderKind,
  AdversarialEvidenceKind,
} from '../state/proofgraph-primitives.js';
import type { SignalClass } from '../state/evidence-signal.js';
import type { AssertionIdentity } from '../state/assertion-identity.js';

export interface AssertionIdentityProjection {
  readonly providerId: string;
  readonly localId: string;
}

export interface RequiredEvidenceProjection {
  readonly positive: readonly ProofProviderKind[];
  readonly adversarial: readonly AdversarialEvidenceKind[];
}

export type CounterexampleRequirementProjection =
  | {
      readonly kind: 'assertion';
      readonly checkId: string;
      readonly assertion: AssertionIdentityProjection;
    }
  | {
      readonly kind: 'aggregate_check';
      readonly checkId: string;
      readonly candidateId?: string;
    }
  | {
      readonly kind: 'legacy_assertion';
      readonly checkId: string;
      readonly assertion: AssertionIdentityProjection;
    };

export interface FreshnessProjection {
  readonly boundDigest: string;
  readonly evaluatedAt: string;
  readonly stale: boolean;
}

export interface ApprovedTicketProjection {
  readonly kind: 'approved_ticket';
  readonly ticketDigest: string;
}

export interface PlanAdrSectionProjection {
  readonly kind: 'plan_adr_section';
  readonly artifactKind: 'plan' | 'adr';
  readonly artifactDigest: string;
  readonly sectionPath: readonly {
    readonly headingDepth: number;
    readonly siblingIndex: number;
    readonly headingText: string;
  }[];
  readonly excerptDigest: string;
}

export interface CanonicalAuthorityProjection {
  readonly kind: 'canonical_authority';
  readonly authorityId: string;
  readonly digest: string;
  readonly approval?: {
    readonly certificateId: string;
    readonly claimDeclarationsDigest: string;
    readonly decisionAttestationDigest: string;
    readonly declarationId: string;
  };
}

export type ClaimProvenanceProjection =
  ApprovedTicketProjection | PlanAdrSectionProjection | CanonicalAuthorityProjection;

export interface ClaimResolutionFacts {
  readonly claimId: string;
  readonly statement: string;
  readonly critical: boolean;
  readonly signalClass: SignalClass;
  readonly claimScope?: 'specific_behavior' | 'suite';
  readonly verificationState: ClaimVerificationState;
  readonly freshness?: FreshnessProjection;
  readonly requiredEvidence?: RequiredEvidenceProjection;
  readonly counterexampleRequirement?: CounterexampleRequirementProjection;
  readonly bindingDiagnostic?: AssertionBindingReasonCode;
  readonly provenance?: ClaimProvenanceProjection;
}

function projectAssertionIdentity(identity: AssertionIdentity): AssertionIdentityProjection {
  return { providerId: identity.providerId, localId: identity.localId };
}

function projectRequiredEvidence(claim: ProofClaim): RequiredEvidenceProjection | undefined {
  const re = claim.requiredEvidence;
  if (!re) return undefined;
  return { positive: re.positive, adversarial: re.adversarial };
}

function projectCounterexampleRequirement(
  claim: ProofClaim,
): CounterexampleRequirementProjection | undefined {
  const cr = claim.counterexampleRequirement;
  if (!cr) return undefined;

  if ('kind' in cr && cr.kind === 'aggregate_check') {
    return {
      kind: 'aggregate_check',
      checkId: cr.checkId,
      ...(cr.candidateId ? { candidateId: cr.candidateId } : {}),
    };
  }

  if ('assertion' in cr && cr.assertion) {
    const kind: 'assertion' | 'legacy_assertion' =
      'kind' in cr && cr.kind === 'assertion' ? 'assertion' : 'legacy_assertion';
    return {
      kind,
      checkId: cr.checkId,
      assertion: projectAssertionIdentity(cr.assertion),
    };
  }

  return undefined;
}

function projectFreshness(claim: ProofClaim): FreshnessProjection | undefined {
  const f = claim.freshness;
  if (!f) return undefined;
  return { boundDigest: f.boundDigest, evaluatedAt: f.evaluatedAt, stale: f.stale };
}

function projectProvenance(claim: ProofClaim): ClaimProvenanceProjection | undefined {
  const p = claim.provenance;
  if (!p) return undefined;

  switch (p.kind) {
    case 'approved_ticket': {
      const ticket = p as { kind: 'approved_ticket'; ticketDigest: string };
      return { kind: 'approved_ticket', ticketDigest: ticket.ticketDigest };
    }
    case 'plan_adr_section': {
      const section = p as {
        kind: 'plan_adr_section';
        artifactKind: 'plan' | 'adr';
        artifactDigest: string;
        sectionPath: readonly {
          headingDepth: number;
          siblingIndex: number;
          headingText: string;
        }[];
        excerptDigest: string;
      };
      return {
        kind: 'plan_adr_section',
        artifactKind: section.artifactKind,
        artifactDigest: section.artifactDigest,
        sectionPath: section.sectionPath,
        excerptDigest: section.excerptDigest,
      };
    }
    case 'canonical_authority': {
      const auth = p as {
        kind: 'canonical_authority';
        authorityId: string;
        digest: string;
        approval?: {
          certificateId: string;
          claimDeclarationsDigest: string;
          decisionAttestationDigest: string;
          declarationId: string;
        };
      };
      return {
        kind: 'canonical_authority',
        authorityId: auth.authorityId,
        digest: auth.digest,
        ...(auth.approval ? { approval: auth.approval } : {}),
      };
    }
    default:
      return undefined;
  }
}

export function projectClaimResolutionFacts(
  claim: ProofClaim,
  bindingDiagnostic?: AssertionBindingReasonCode,
): ClaimResolutionFacts {
  return {
    claimId: claim.claimId,
    statement: claim.statement,
    critical: claim.critical,
    signalClass: claim.signalClass,
    ...(claim.claimScope !== undefined ? { claimScope: claim.claimScope } : {}),
    verificationState: claim.verificationState,
    ...(claim.freshness !== undefined ? { freshness: projectFreshness(claim) } : {}),
    ...(claim.requiredEvidence !== undefined
      ? { requiredEvidence: projectRequiredEvidence(claim) }
      : {}),
    ...(claim.counterexampleRequirement !== undefined
      ? { counterexampleRequirement: projectCounterexampleRequirement(claim) }
      : {}),
    ...(bindingDiagnostic !== undefined ? { bindingDiagnostic } : {}),
    ...(claim.provenance !== null ? { provenance: projectProvenance(claim) } : {}),
  };
}
