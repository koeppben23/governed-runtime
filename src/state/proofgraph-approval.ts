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
import { V2CounterexampleRequirement } from './proofgraph.js';
export {
  AggregateCounterexampleRequirement,
  AssertionCounterexampleRequirement,
  V2CounterexampleRequirement,
} from './proofgraph.js';
import * as crypto from 'node:crypto';

/** RFC 4122 DNS namespace, used to derive stable UUIDv5 claim identities. */
const CLAIM_NAMESPACE = Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex');

function normalizeClaimStatement(statement: string): string {
  return statement.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Derive a deterministic UUIDv5 for a claim so that identical declarations
 * in the same authority section produce the same claimId across idempotent
 * retries, while the same statement in a different authority section or flow
 * produces a distinct identity.
 */
export function mintProofGraphClaimId(input: {
  flow: 'plan' | 'architecture';
  statement: string;
  authoritySectionId: string;
}): string {
  const seed = [
    input.flow,
    input.authoritySectionId,
    normalizeClaimStatement(input.statement),
  ].join('\u001f');
  const hash = crypto.createHash('sha1').update(CLAIM_NAMESPACE).update(seed, 'utf8').digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8]! & 0x3f) | 0x80; // RFC 4122 variant
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
    counterexampleRequirement: V2CounterexampleRequirement.optional(),
    structuralSurface: z.string().min(1).optional(),
    mutationProfile: z.string().min(1).optional(),
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
export function normalizeArchitectureClaims(
  claims: readonly ArchitectureClaimDeclarationInput[] | undefined,
): ArchitectureClaimDeclaration[] | undefined {
  return claims?.map((claim) => ({
    ...claim,
    claimId: mintProofGraphClaimId({
      flow: 'architecture',
      statement: claim.statement,
      authoritySectionId: claim.authoritySectionId,
    }),
  })) as ArchitectureClaimDeclaration[];
}

/**
 * Normalize plan claim inputs to persisted declarations by minting a
 * deterministic claimId host-side.
 */
export function normalizePlanClaims(
  claims: readonly PlanClaimDeclarationInput[] | undefined,
): z.infer<typeof V2PlanClaimDeclaration>[] | undefined {
  return claims?.map((claim) => ({
    ...claim,
    claimId: mintProofGraphClaimId({
      flow: 'plan',
      statement: claim.statement,
      authoritySectionId: claim.authoritySectionId,
    }),
  }));
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
 * Provenance edge of a plan approval certificate.
 *
 * The binding kind is decided exclusively by the gate path that minted the
 * certificate — it is NEVER normalized afterwards from digest equality:
 *
 * - `current_review`: the human approval is proven to rest on independent
 *   review evidence whose obligation subjectDigest equals the certified plan
 *   digest exactly AND whose captured reviewer verdict is `accept`.
 * - `review_exhausted_override`: the review budget ended without reviewer
 *   acceptance; the human overrode it. Stricter than the architecture
 *   counterpart: the last bound evidence must have reviewed EXACTLY the
 *   approved subject (`reviewedSubjectDigest === approvedSubjectDigest`) —
 *   an unreviewed revision can never be released by an override.
 */
export const PlanReviewBinding = z.discriminatedUnion('kind', [
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
export type PlanReviewBinding = z.infer<typeof PlanReviewBinding>;

/** A common certificate constrained for plan approval persistence. */
export const PlanApprovalCertificate = z
  .object({
    flow: z.literal('plan'),
    ...approvalCertificateShape,
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
    reviewBinding: PlanReviewBinding,
  })
  .superRefine((certificate, ctx) => {
    const binding = certificate.reviewBinding;
    if (binding.kind === 'current_review') {
      if (binding.reviewedSubjectDigest !== certificate.authorityDigest) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['reviewBinding', 'reviewedSubjectDigest'],
          message:
            'A plan current_review binding must review exactly the certified plan digest (reviewedSubjectDigest === authorityDigest).',
        });
      }
      return;
    }
    if (binding.approvedSubjectDigest !== certificate.authorityDigest) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reviewBinding', 'approvedSubjectDigest'],
        message:
          'A plan review_exhausted_override binding must approve exactly the certified plan digest (approvedSubjectDigest === authorityDigest).',
      });
    }
    if (binding.reviewedSubjectDigest !== binding.approvedSubjectDigest) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reviewBinding', 'reviewedSubjectDigest'],
        message:
          'A plan review_exhausted_override binding may only release the exact subject the last review covered (reviewedSubjectDigest === approvedSubjectDigest).',
      });
    }
  })
  .readonly();
export type PlanApprovalCertificate = z.infer<typeof PlanApprovalCertificate>;

/**
 * Provenance edge of an architecture approval certificate.
 *
 * The binding kind is decided exclusively by the gate path that minted the
 * certificate — it is NEVER normalized afterwards from digest equality:
 *
 * - `current_review`: the human approval is proven to rest on independent
 *   review evidence whose obligation subjectDigest equals the certified ADR
 *   digest exactly (reviewer_accepted path).
 * - `review_exhausted_override`: the review budget ended without reviewer
 *   acceptance; the human overrode it. The certificate records which subject
 *   the last real bound evidence actually reviewed (`reviewedSubjectDigest`)
 *   separately from the approved subject (`approvedSubjectDigest`) so the
 *   difference stays explicit, machine-readable provenance. A reviewed digest
 *   equal to the approved digest is still an override — it was not accepted.
 */
export const ArchitectureReviewBinding = z.discriminatedUnion('kind', [
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
export type ArchitectureReviewBinding = z.infer<typeof ArchitectureReviewBinding>;

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
    reviewBinding: ArchitectureReviewBinding,
  })
  .superRefine((certificate, ctx) => {
    if (certificate.reviewBinding.kind === 'current_review') {
      if (certificate.reviewBinding.reviewedSubjectDigest !== certificate.authorityDigest) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['reviewBinding', 'reviewedSubjectDigest'],
          message:
            'A current_review binding must review exactly the certified ADR digest (reviewedSubjectDigest === authorityDigest).',
        });
      }
      return;
    }
    if (certificate.reviewBinding.approvedSubjectDigest !== certificate.authorityDigest) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reviewBinding', 'approvedSubjectDigest'],
        message:
          'A review_exhausted_override binding must approve exactly the certified ADR digest (approvedSubjectDigest === authorityDigest).',
      });
    }
  })
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

/** Whether the certificate binds the plan's current declaration set exactly. */
export function hasCurrentPlanApprovalCertificate(
  plan: PlanClaimAuthority | null | undefined,
): plan is PlanClaimAuthority & { readonly approvalCertificate: PlanApprovalCertificate } {
  if (!plan?.approvalCertificate) return false;
  if (plan.approvalCertificate.authorityDigest !== plan.current.digest) return false;
  // Versionsbindung: Ein Zertifikat für v1 autorisiert nicht v2.
  if (plan.approvalCertificate.planVersion !== plan.current.planVersion) return false;
  // Record-Digest-Bindung: Gleicher Plantext + gleiche Version, aber anderer
  // recordDigest (z.B. andere Lineage-Metadaten) invalidiert das Zertifikat.
  if (plan.approvalCertificate.planRecordDigest !== plan.current.recordDigest) return false;
  // CE5: The review-evidence binding is part of the certificate's authority.
  // Legacy certificates without a binding (or whose binding no longer matches
  // the current subject) never authorize critical claims — fail closed.
  const binding = plan.approvalCertificate.reviewBinding;
  if (!binding) return false;
  if (binding.kind === 'current_review') {
    if (binding.reviewedSubjectDigest !== plan.current.digest) return false;
  } else if (
    binding.approvedSubjectDigest !== plan.current.digest ||
    binding.reviewedSubjectDigest !== binding.approvedSubjectDigest
  ) {
    return false;
  }
  const declarations = plan.claimDeclarations ?? emptyClaimDeclarations('plan');
  return (
    plan.approvalCertificate.claimDeclarationsDigest ===
    hashText(canonicalJsonStringify(declarations))
  );
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

/** Critical plan claims authorized by the certificate bound to the current plan. */
export type AuthorizedCriticalPlanClaimIds =
  | { readonly kind: 'authorized'; readonly claimIds: readonly string[] }
  | { readonly kind: 'certificate_missing' }
  | { readonly kind: 'certificate_invalid' };

export function authorizedCriticalPlanClaimIds(
  plan: PlanClaimAuthority | null | undefined,
): AuthorizedCriticalPlanClaimIds {
  if (!plan?.approvalCertificate) {
    const hasCriticalDeclarations = (plan?.claimDeclarations?.claims ?? []).some(
      (claim) => claim.critical,
    );
    return hasCriticalDeclarations
      ? { kind: 'certificate_missing' }
      : { kind: 'authorized', claimIds: [] };
  }
  if (!hasCurrentPlanApprovalCertificate(plan)) return { kind: 'certificate_invalid' };
  return {
    kind: 'authorized',
    claimIds: (plan.claimDeclarations?.claims ?? [])
      .filter((claim) => claim.critical)
      .map((claim) => claim.claimId),
  };
}
