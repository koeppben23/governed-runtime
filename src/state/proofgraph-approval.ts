/**
 * @module proofgraph-approval
 * @description Flow-specific ProofGraph claim declarations and approval certificates.
 *
 * Certificates are persisted attestations only. They bind already-computed digests
 * and do not themselves approve a workflow transition.
 *
 * @version v1
 */

import { z } from 'zod';
import { canonicalJsonStringify } from '../shared/canonical-json.js';
import { hashText } from '../shared/hashing.js';
import { POLICY_DIGEST_PATTERN, POLICY_DIGEST_VERSION } from './evidence-identifiers.js';
import { ReviewDecision } from './evidence-review-report.js';
import { CounterexampleRequirement } from './proofgraph.js';
import { SpecificRiskTrigger } from './risk-trigger.js';
export {
  AggregateCounterexampleRequirement,
  AssertionCounterexampleRequirement,
  CounterexampleRequirement,
} from './proofgraph.js';
import * as crypto from 'node:crypto';

/** RFC 4122 DNS namespace, used to derive stable UUIDv5 claim identities. */
const CLAIM_NAMESPACE = Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex');

/**
 * Reserved authority-section scope for `manual` claims. It is internal to the
 * identity authority: a manual declaration has no governing authority section,
 * so callers cannot name one for it (see `ProofGraphClaimIdentityInput`).
 */
const MANUAL_CLAIM_SCOPE = 'manual-contract';

/**
 * Identity input of a ProofGraph claim.
 *
 * Only the authority domains carry an authority section. The `manual` domain
 * deliberately has none — the authority fixes the reserved manual scope
 * internally, so no caller can mint a manual claim under a foreign scope.
 */
export type ProofGraphClaimIdentityInput =
  | {
      readonly domain: 'plan' | 'architecture';
      readonly statement: string;
      readonly authoritySectionId: string;
    }
  | {
      readonly domain: 'manual';
      readonly statement: string;
    };

/**
 * Identity domain of a ProofGraph claim — derived from the identity input so
 * the domain vocabulary has exactly one structural definition.
 *
 * - `plan` / `architecture`: claims declared against an approved authority and
 *   bound by that authority's approval certificate.
 * - `manual`: evidence-bound claims declared directly at the implementation
 *   write boundary, which carry no approval certificate and remain advisory.
 *
 * The domain is PART of the claim identity: the same statement in different
 * domains is a different claim with a distinct identity. Domain scopes must
 * never be collapsed into statement equality.
 */
export type ProofGraphClaimDomain = ProofGraphClaimIdentityInput['domain'];

/**
 * Canonical statement key of a claim identity. Two statements that differ only
 * in surrounding/interior whitespace or casing are the SAME claim statement.
 */
export function normalizeClaimStatement(statement: string): string {
  return statement.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Derive a deterministic UUIDv5 for a claim so that identical declarations
 * in the same identity domain and authority section produce the same claimId
 * across idempotent retries, while the same statement in a different authority
 * section or domain produces a distinct identity.
 */
export function mintProofGraphClaimId(input: ProofGraphClaimIdentityInput): string {
  const authoritySectionId =
    input.domain === 'manual' ? MANUAL_CLAIM_SCOPE : input.authoritySectionId;
  const seed = [input.domain, authoritySectionId, normalizeClaimStatement(input.statement)].join(
    '\u001f',
  );
  const hash = crypto.createHash('sha1').update(CLAIM_NAMESPACE).update(seed, 'utf8').digest();
  hash.writeUInt8((hash.readUInt8(6) & 0x0f) | 0x50, 6); // version 5
  hash.writeUInt8((hash.readUInt8(8) & 0x3f) | 0x80, 8); // RFC 4122 variant
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** A claim declaration captured before implementation evidence exists. */
const preEvidenceClaimDeclaration = {
  claimId: z.string().uuid(),
  statement: z.string().min(1),
  critical: z.boolean(),
  authoritySectionId: z.string().min(1),
} as const;

const v2PlanBase = z
  .object({
    ...preEvidenceClaimDeclaration,
    claimScope: z.enum(['specific_behavior', 'suite']),
    expectedCheckId: z.string().min(1),
    counterexampleRequirement: CounterexampleRequirement.optional(),
    structuralSurface: z.string().min(1).optional(),
    mutationProfile: z.string().min(1).optional(),
    /**
     * Specific risk triggers this critical claim explicitly covers. Declared,
     * never inferred; the certificate binds the exact set.
     */
    coversRiskTriggers: z.array(SpecificRiskTrigger).optional(),
  })
  .strict();
export const V2PlanClaimDeclaration = v2PlanBase.readonly();
/** The ONLY executable plan claim declaration shape in this epoch — no legacy branch. */
export const PlanClaimDeclaration = V2PlanClaimDeclaration;
export type PlanClaimDeclaration = z.infer<typeof PlanClaimDeclaration>;

/** Public input for a plan claim — claimId is minted host-side. */
export const PlanClaimDeclarationInput = v2PlanBase.omit({ claimId: true }).strict();
export type PlanClaimDeclarationInput = z.infer<typeof PlanClaimDeclarationInput>;

/**
 * Normalize architecture claim inputs to persisted declarations by minting a
 * deterministic claimId host-side.
 */
/**
 * Project a counterexample requirement onto its declared fields. Inputs arrive
 * from the host model, so undeclared keys must not leak into persisted state;
 * the strict declaration schema downstream would refuse the whole write.
 */
function projectCounterexampleRequirement(
  requirement: CounterexampleRequirement | undefined,
): CounterexampleRequirement | undefined {
  if (requirement === undefined) return undefined;
  return requirement.kind === 'aggregate_check'
    ? {
        kind: 'aggregate_check',
        checkId: requirement.checkId,
        ...(requirement.candidateId !== undefined ? { candidateId: requirement.candidateId } : {}),
      }
    : {
        kind: 'assertion',
        checkId: requirement.checkId,
        assertion: {
          providerId: requirement.assertion.providerId,
          localId: requirement.assertion.localId,
        },
      };
}

export function normalizeArchitectureClaims(
  claims: readonly ArchitectureClaimDeclarationInput[] | undefined,
): ArchitectureClaimDeclaration[] | undefined {
  return claims?.map((claim) => ({
    statement: claim.statement,
    critical: claim.critical,
    authoritySectionId: claim.authoritySectionId,
    requiredReviewEvidence: [...claim.requiredReviewEvidence],
    ...(claim.assumptions !== undefined ? { assumptions: [...claim.assumptions] } : {}),
    claimId: mintProofGraphClaimId({
      domain: 'architecture',
      statement: claim.statement,
      authoritySectionId: claim.authoritySectionId,
    }),
  }));
}

/**
 * Normalize plan claim inputs to persisted declarations by minting a
 * deterministic claimId host-side.
 */
export function normalizePlanClaims(
  claims: readonly PlanClaimDeclarationInput[] | undefined,
): z.infer<typeof V2PlanClaimDeclaration>[] | undefined {
  return claims?.map((claim) => {
    const counterexampleRequirement = projectCounterexampleRequirement(
      claim.counterexampleRequirement,
    );
    return {
      statement: claim.statement,
      critical: claim.critical,
      authoritySectionId: claim.authoritySectionId,
      claimScope: claim.claimScope,
      expectedCheckId: claim.expectedCheckId,
      ...(counterexampleRequirement !== undefined ? { counterexampleRequirement } : {}),
      ...(claim.structuralSurface !== undefined
        ? { structuralSurface: claim.structuralSurface }
        : {}),
      ...(claim.mutationProfile !== undefined ? { mutationProfile: claim.mutationProfile } : {}),
      ...(claim.coversRiskTriggers !== undefined
        ? { coversRiskTriggers: [...claim.coversRiskTriggers] }
        : {}),
      claimId: mintProofGraphClaimId({
        domain: 'plan',
        statement: claim.statement,
        authoritySectionId: claim.authoritySectionId,
      }),
    };
  });
}

/** An ADR claim names the review evidence and assumptions for the decision. */
const archBase = z
  .object({
    ...preEvidenceClaimDeclaration,
    requiredReviewEvidence: z.array(z.string().min(1)),
    assumptions: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const ArchitectureClaimDeclaration = archBase.readonly();
export type ArchitectureClaimDeclaration = z.infer<typeof ArchitectureClaimDeclaration>;

/** Public input for an ADR claim — claimId is minted host-side. */
export const ArchitectureClaimDeclarationInput = archBase.omit({ claimId: true }).strict();
export type ArchitectureClaimDeclarationInput = z.infer<typeof ArchitectureClaimDeclarationInput>;

/** Flows that can produce a user approval certificate. */
export const ProofGraphApprovalFlow = z.enum(['plan', 'architecture']);
export type ProofGraphApprovalFlow = z.infer<typeof ProofGraphApprovalFlow>;

/**
 * A certificate binds a user approval to the governing authority, exact claim
 * declarations, and decision attestation used when the approval was recorded.
 */
const approvalCertificateShape = {
  authorityDigest: z.string().min(1),
  claimDeclarationsDigest: z.string().min(1),
  decisionAttestationDigest: z.string().min(1),
  approvedAt: z.string().datetime(),
  approvedBy: z.string().min(1),
  certificateId: z.string().uuid(),
} as const;

/**
 * Provenance edge of an approval certificate. The binding kind is decided by
 * the gate path that minted the certificate and is never normalized from
 * digest equality afterwards.
 */
export const ReviewBinding = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('current_review'),
      reviewObligationId: z.string().uuid(),
      reviewEvidenceDigest: z.string().min(1),
      reviewedSubjectDigest: z.string().min(1),
    })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.literal('review_exhausted_override'),
      lastReviewObligationId: z.string().uuid(),
      lastReviewEvidenceDigest: z.string().min(1),
      reviewedSubjectDigest: z.string().min(1),
      approvedSubjectDigest: z.string().min(1),
    })
    .strict()
    .readonly(),
]);
export type ReviewBinding = z.infer<typeof ReviewBinding>;

function refineReviewBinding(
  certificate: { readonly authorityDigest: string; readonly reviewBinding: ReviewBinding },
  ctx: z.RefinementCtx,
  flow: 'plan' | 'architecture',
): void {
  const binding = certificate.reviewBinding;
  if (binding.kind === 'current_review') {
    if (binding.reviewedSubjectDigest !== certificate.authorityDigest) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reviewBinding', 'reviewedSubjectDigest'],
        message:
          flow === 'plan'
            ? 'A plan current_review binding must review exactly the certified plan digest (reviewedSubjectDigest === authorityDigest).'
            : 'A current_review binding must review exactly the certified ADR digest (reviewedSubjectDigest === authorityDigest).',
      });
    }
    return;
  }
  if (binding.approvedSubjectDigest !== certificate.authorityDigest) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['reviewBinding', 'approvedSubjectDigest'],
      message:
        flow === 'plan'
          ? 'A plan review_exhausted_override binding must approve exactly the certified plan digest (approvedSubjectDigest === authorityDigest).'
          : 'A review_exhausted_override binding must approve exactly the certified ADR digest (approvedSubjectDigest === authorityDigest).',
    });
  }
  if (binding.reviewedSubjectDigest !== binding.approvedSubjectDigest) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['reviewBinding', 'reviewedSubjectDigest'],
      message:
        flow === 'plan'
          ? 'A plan review_exhausted_override binding may only release the exact subject the last review covered (reviewedSubjectDigest === approvedSubjectDigest).'
          : 'A review_exhausted_override binding may only release the exact subject the last review covered (reviewedSubjectDigest === approvedSubjectDigest).',
    });
  }
}

/**
 * How a plan approval was produced. `explicit_decision` carries the real
 * recorded decision (the frozen policy still classifies the actor). `policy_auto`
 * is runtime-owned and deliberately carries NO identity: the session/policy
 * binding is its provenance, never a fabricated person. The kinds are never
 * reinterpreted into each other, and only an accepted review is certified
 * automatically — an exhausted override stays an explicit decision.
 */
export const PlanApprovalAttestation = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('explicit_decision'),
      decision: ReviewDecision,
      flowguardSessionId: z.string().uuid(),
      bindingDigest: z.string().regex(/^[a-f0-9]{64}$/),
      policyHash: z.string().regex(POLICY_DIGEST_PATTERN),
      policyHashVersion: z.literal(POLICY_DIGEST_VERSION),
    })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.literal('policy_auto'),
      decidedAt: z.string().datetime(),
      flowguardSessionId: z.string().uuid(),
      bindingDigest: z.string().regex(/^[a-f0-9]{64}$/),
      policyHash: z.string().regex(POLICY_DIGEST_PATTERN),
      policyHashVersion: z.literal(POLICY_DIGEST_VERSION),
    })
    .strict()
    .readonly(),
]);
export type PlanApprovalAttestation = z.infer<typeof PlanApprovalAttestation>;

/**
 * A plan approval certificate, versioned and attestation-discriminated.
 * `decisionAttestationDigest` is recomputed at parse time, so a relabeled kind
 * or swapped decision is rejected, not silently reinterpreted. `approvedBy`
 * deliberately does not exist for plan certificates — an automatic approval
 * has no person to name, and an explicit decision carries its identity inside
 * the attestation.
 */
export const PlanApprovalCertificate = z
  .object({
    schemaVersion: z.literal('plan-approval-certificate.v1'),
    flow: z.literal('plan'),
    authorityDigest: z.string().min(1),
    claimDeclarationsDigest: z.string().min(1),
    decisionAttestationDigest: z.string().min(1),
    approvedAt: z.string().datetime(),
    certificateId: z.string().uuid(),
    /** Immutable plan version this certificate was issued against. */
    planVersion: z.number().int().positive(),
    /** Record-digest of the plan this certificate binds (content + lineage). */
    planRecordDigest: z.string().min(1),
    /**
     * Canonical review-evidence provenance edge. REQUIRED in the Hard
     * Assurance Epoch: every certificate is minted with its binding, and a
     * certificate without one is not a current-epoch artifact — it fails
     * parsing instead of degrading to a readable-but-unauthoritative shape.
     */
    reviewBinding: ReviewBinding,
    approvalAttestation: PlanApprovalAttestation,
  })
  .strict()
  .superRefine((certificate, ctx) => {
    refineReviewBinding(certificate, ctx, 'plan');
    const attestation = certificate.approvalAttestation;
    if (certificate.decisionAttestationDigest !== hashText(canonicalJsonStringify(attestation))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['decisionAttestationDigest'],
        message: 'decisionAttestationDigest must equal the canonical approval attestation digest.',
      });
    }
    if (attestation.kind === 'explicit_decision') {
      if (certificate.approvedAt !== attestation.decision.decidedAt) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['approvedAt'],
          message: 'approvedAt must equal the explicit decision time.',
        });
      }
      if (
        attestation.decision.verdict !== 'approve' &&
        attestation.decision.verdict !== 'approve_with_governance_override'
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['approvalAttestation', 'decision', 'verdict'],
          message: 'A plan approval certificate requires an approving verdict.',
        });
      }
      return;
    }
    if (certificate.approvedAt !== attestation.decidedAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['approvedAt'],
        message: 'approvedAt must equal the automatic decision time.',
      });
    }
    if (certificate.reviewBinding.kind !== 'current_review') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reviewBinding', 'kind'],
        message:
          'A policy_auto certificate can only certify an accepted current review; an exhausted override must be an explicit decision.',
      });
    }
  })
  .readonly();
export type PlanApprovalCertificate = z.infer<typeof PlanApprovalCertificate>;

/**
 * A common certificate constrained for architecture approval persistence.
 *
 * `reviewBinding` is REQUIRED: a certificate without a resolvable review
 * evidence edge cannot be minted (see /review-decision rail), and a persisted
 * certificate without it fails schema parsing — there is deliberately no
 * defaulting path for authority-bearing fields.
 */
export const ArchitectureApprovalCertificate = z
  .object({
    flow: z.literal('architecture'),
    ...approvalCertificateShape,
    reviewBinding: ReviewBinding,
  })
  .superRefine((certificate, ctx) => refineReviewBinding(certificate, ctx, 'architecture'))
  .readonly();
export type ArchitectureApprovalCertificate = z.infer<typeof ArchitectureApprovalCertificate>;

export const ProofGraphApprovalCertificate = z.discriminatedUnion('flow', [
  PlanApprovalCertificate,
  ArchitectureApprovalCertificate,
]);
export type ProofGraphApprovalCertificate = z.infer<typeof ProofGraphApprovalCertificate>;

/** Claims declared against the current plan authority — v2 only in this epoch. */
export const PlanClaimDeclarations = z
  .object({
    flow: z.literal('plan'),
    version: z.literal('v2'),
    claims: z.array(V2PlanClaimDeclaration),
  })
  .readonly();
export type PlanClaimDeclarations = z.infer<typeof PlanClaimDeclarations>;

/** Claims declared against the current architecture decision authority. */
export const ArchitectureClaimDeclarations = z
  .object({
    flow: z.literal('architecture'),
    claims: z.array(ArchitectureClaimDeclaration),
  })
  .readonly();
export type ArchitectureClaimDeclarations = z.infer<typeof ArchitectureClaimDeclarations>;

/** The flow-specific declaration shapes accepted by approval persistence. */
export const FlowClaimDeclarations = z.union([
  PlanClaimDeclarations,
  ArchitectureClaimDeclarations,
]);
export type FlowClaimDeclarations = z.infer<typeof FlowClaimDeclarations>;

/**
 * Session- and policy-context binding of a plan approval: valid only in the
 * exact session binding and frozen policy it was minted in, verified against
 * the owning session state and never reconstructed from the certificate.
 */
export interface PlanApprovalContext {
  readonly flowguardSessionId: string;
  readonly bindingDigest: string;
  readonly policyHash: string;
  readonly policyHashVersion: typeof POLICY_DIGEST_VERSION;
  readonly requireHumanGates: boolean;
}

/** Minimal plan authority shape needed to verify its approval certificate. */
export interface PlanClaimAuthority {
  readonly current: {
    readonly digest: string;
    readonly planVersion: number;
    readonly recordDigest: string;
  };
  readonly claimDeclarations?: PlanClaimDeclarations;
  readonly approvalCertificate?: PlanApprovalCertificate;
}

/** Canonical empty declaration set per flow — the fallback when no claims were declared. */
export function emptyClaimDeclarations(flow: 'plan'): PlanClaimDeclarations;
export function emptyClaimDeclarations(flow: 'architecture'): ArchitectureClaimDeclarations;
export function emptyClaimDeclarations(
  flow: 'plan' | 'architecture',
): PlanClaimDeclarations | ArchitectureClaimDeclarations {
  return flow === 'plan'
    ? { flow: 'plan', version: 'v2', claims: [] }
    : { flow: 'architecture', claims: [] };
}

/**
 * Whether the certificate binds the plan's current declaration set exactly AND
 * belongs to this session's binding and frozen policy. `context` is mandatory —
 * no plan-only validation path silently omits the binding — and a
 * `policy_auto` certificate is only valid where the frozen policy permits
 * automatic gates.
 */
function approvalAttestationMatchesContext(
  attestation: PlanApprovalAttestation,
  context: PlanApprovalContext,
): boolean {
  if (attestation.flowguardSessionId !== context.flowguardSessionId) return false;
  if (attestation.bindingDigest !== context.bindingDigest) return false;
  if (attestation.policyHash !== context.policyHash) return false;
  if (attestation.policyHashVersion !== context.policyHashVersion) return false;
  return !(attestation.kind === 'policy_auto' && context.requireHumanGates);
}

/** The review-evidence binding must match the current subject exactly. */
function reviewBindingMatchesPlan(binding: ReviewBinding, plan: PlanClaimAuthority): boolean {
  if (binding.kind === 'current_review') {
    return binding.reviewedSubjectDigest === plan.current.digest;
  }
  return (
    binding.approvedSubjectDigest === plan.current.digest &&
    binding.reviewedSubjectDigest === binding.approvedSubjectDigest
  );
}

export function hasCurrentPlanApprovalCertificate(
  plan: PlanClaimAuthority | null | undefined,
  context: PlanApprovalContext,
): plan is PlanClaimAuthority & { readonly approvalCertificate: PlanApprovalCertificate } {
  if (!plan?.approvalCertificate) return false;
  const certificate = plan.approvalCertificate;
  if (certificate.authorityDigest !== plan.current.digest) return false;
  // Versionsbindung: Ein Zertifikat für v1 autorisiert nicht v2.
  if (certificate.planVersion !== plan.current.planVersion) return false;
  // Record-Digest-Bindung: Gleicher Plantext + gleiche Version, aber anderer
  // recordDigest (z.B. andere Lineage-Metadaten) invalidiert das Zertifikat.
  if (certificate.planRecordDigest !== plan.current.recordDigest) return false;
  // Runtime guard for malformed in-memory projections: a missing attestation is
  // never a current certificate.
  if (!certificate.approvalAttestation) return false;
  if (!approvalAttestationMatchesContext(certificate.approvalAttestation, context)) return false;
  if (!reviewBindingMatchesPlan(certificate.reviewBinding, plan)) return false;
  const declarations = plan.claimDeclarations ?? emptyClaimDeclarations('plan');
  return certificate.claimDeclarationsDigest === hashText(canonicalJsonStringify(declarations));
}

/** Minimal architecture authority shape needed to verify its approval certificate. */
export interface ArchitectureClaimAuthority {
  readonly digest: string;
  readonly claimDeclarations?: ArchitectureClaimDeclarations;
  readonly approvalCertificate?: ArchitectureApprovalCertificate;
}

/** Whether the certificate binds the current ADR and exact declaration set. */
export function hasCurrentArchitectureApprovalCertificate(
  architecture: ArchitectureClaimAuthority | null | undefined,
): architecture is ArchitectureClaimAuthority & {
  readonly approvalCertificate: ArchitectureApprovalCertificate;
} {
  if (!architecture?.approvalCertificate) return false;
  if (architecture.approvalCertificate.authorityDigest !== architecture.digest) return false;
  const declarations = architecture.claimDeclarations ?? emptyClaimDeclarations('architecture');
  return (
    architecture.approvalCertificate.claimDeclarationsDigest ===
    hashText(canonicalJsonStringify(declarations))
  );
}

/**
 * Exact approval binding a materialized claim must carry to be evaluated under
 * the current plan certificate.
 */
export interface AuthorizedClaimBinding {
  readonly authorityId: string;
  readonly authorityDigest: string;
  readonly certificateId: string;
  readonly claimDeclarationsDigest: string;
  readonly decisionAttestationDigest: string;
  readonly declarationId: string;
}

/**
 * Certificate-authorized critical plan claims, their exact coverage relation,
 * and the approval binding each evaluated claim must carry.
 *
 * `coverage` maps every authorized critical claim id to the triggers its
 * approved declaration declares. The enforcement projector must use THIS
 * relation — never the persisted projection's `coversRiskTriggers` — so a
 * tampered or stale projection cannot widen the approved contract. `bindings`
 * is the expected certificate identity per claim: a projection claim whose
 * provenance binds a different certificate is not an evaluation of the
 * authorized claim.
 */
export type AuthorizedCriticalPlanClaimIds =
  | {
      readonly kind: 'authorized';
      readonly claimIds: readonly string[];
      readonly coverage: ReadonlyMap<string, readonly SpecificRiskTrigger[]>;
      readonly bindings: ReadonlyMap<string, AuthorizedClaimBinding>;
    }
  | { readonly kind: 'certificate_missing' }
  | { readonly kind: 'certificate_invalid' };

export function authorizedCriticalPlanClaimIds(
  plan: PlanClaimAuthority | null | undefined,
  context: PlanApprovalContext,
): AuthorizedCriticalPlanClaimIds {
  if (!plan?.approvalCertificate) {
    const hasCriticalDeclarations = (plan?.claimDeclarations?.claims ?? []).some(
      (claim) => claim.critical,
    );
    return hasCriticalDeclarations
      ? { kind: 'certificate_missing' }
      : { kind: 'authorized', claimIds: [], coverage: new Map(), bindings: new Map() };
  }
  if (!hasCurrentPlanApprovalCertificate(plan, context)) return { kind: 'certificate_invalid' };
  const certificate = plan.approvalCertificate;
  const criticalClaims = (plan.claimDeclarations?.claims ?? []).filter((claim) => claim.critical);
  const coverage = new Map<string, readonly SpecificRiskTrigger[]>();
  const bindings = new Map<string, AuthorizedClaimBinding>();
  for (const claim of criticalClaims) {
    coverage.set(claim.claimId, claim.coversRiskTriggers ?? []);
    bindings.set(claim.claimId, {
      authorityId: 'plan',
      authorityDigest: certificate.authorityDigest,
      certificateId: certificate.certificateId,
      claimDeclarationsDigest: certificate.claimDeclarationsDigest,
      decisionAttestationDigest: certificate.decisionAttestationDigest,
      declarationId: claim.claimId,
    });
  }
  return {
    kind: 'authorized',
    claimIds: criticalClaims.map((claim) => claim.claimId),
    coverage,
    bindings,
  };
}
