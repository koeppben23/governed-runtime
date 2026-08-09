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
import type { ClaimVerificationState } from '../state/proofgraph-primitives.js';
import type { SignalClass } from '../state/evidence-signal.js';
import type { AssertionIdentity } from '../state/assertion-identity.js';

export interface AssertionIdentityProjection {
  readonly providerId: string;
  readonly localId: string;
}

export interface RequiredEvidenceProjection {
  readonly positive: readonly string[];
  readonly adversarial: readonly string[];
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

export interface ClaimProvenanceProjection {
  readonly kind: string;
  readonly authorityId?: string;
  readonly digest?: string;
}

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
  if (re.positive.length === 0 && re.adversarial.length === 0) return undefined;
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
  const base: { kind: string } = { kind: p.kind };
  if ('authorityId' in p) {
    const auth = p as { kind: string; authorityId: string; digest: string };
    return { ...base, authorityId: auth.authorityId, digest: auth.digest };
  }
  if ('ticketDigest' in p) {
    const ticket = p as { kind: string; ticketDigest: string };
    return { ...base, digest: ticket.ticketDigest };
  }
  return base;
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
