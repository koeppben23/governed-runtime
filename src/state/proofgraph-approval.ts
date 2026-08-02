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

/** A claim declaration captured before implementation evidence exists. */
const preEvidenceClaimDeclaration = {
  claimId: z.string().uuid(),
  statement: z.string().min(1),
  critical: z.boolean(),
  authoritySectionId: z.string().min(1),
} as const;

/** A plan claim names the checks expected to cover and falsify it after implementation. */
export const PlanClaimDeclaration = z
  .object({
    ...preEvidenceClaimDeclaration,
    expectedCheckId: z.string().min(1),
    counterexampleCheckId: z.string().min(1).optional(),
    structuralSurface: z.string().min(1).optional(),
    mutationProfile: z.string().min(1).optional(),
  })
  .readonly();
export type PlanClaimDeclaration = z.infer<typeof PlanClaimDeclaration>;

/** An ADR claim names the review evidence and assumptions for the decision. */
export const ArchitectureClaimDeclaration = z
  .object({
    ...preEvidenceClaimDeclaration,
    requiredReviewEvidence: z.array(z.string().min(1)),
    assumptions: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .readonly();
export type ArchitectureClaimDeclaration = z.infer<typeof ArchitectureClaimDeclaration>;

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

/** A common certificate constrained for plan approval persistence. */
export const PlanApprovalCertificate = z
  .object({
    flow: z.literal('plan'),
    ...approvalCertificateShape,
    /** Immutable plan version this certificate was issued against. */
    planVersion: z.number().int().positive(),
    /** Record-digest of the plan this certificate binds (content + lineage). */
    planRecordDigest: z.string().min(1),
    /** The review obligation whose evidence was accepted for this approval. */
    reviewObligationId: z.string().uuid().nullable(),
    /** Digest of the review invocation evidence that satisfied the obligation. */
    reviewEvidenceDigest: z.string().min(1).nullable(),
  })
  .readonly();
export type PlanApprovalCertificate = z.infer<typeof PlanApprovalCertificate>;

/** A common certificate constrained for architecture approval persistence. */
export const ArchitectureApprovalCertificate = z
  .object({ flow: z.literal('architecture'), ...approvalCertificateShape })
  .readonly();
export type ArchitectureApprovalCertificate = z.infer<typeof ArchitectureApprovalCertificate>;

export const ProofGraphApprovalCertificate = z.discriminatedUnion('flow', [
  PlanApprovalCertificate,
  ArchitectureApprovalCertificate,
]);
export type ProofGraphApprovalCertificate = z.infer<typeof ProofGraphApprovalCertificate>;

/** Claims declared against the current plan authority. */
export const PlanClaimDeclarations = z
  .object({
    flow: z.literal('plan'),
    claims: z.array(PlanClaimDeclaration),
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
export const FlowClaimDeclarations = z.discriminatedUnion('flow', [
  PlanClaimDeclarations,
  ArchitectureClaimDeclarations,
]);
export type FlowClaimDeclarations = z.infer<typeof FlowClaimDeclarations>;

/** Minimal plan authority shape needed to verify its approval certificate. */
export interface PlanClaimAuthority {
  readonly current: {
    readonly digest: string;
    readonly planVersion?: number;
    readonly recordDigest?: string;
  };
  readonly claimDeclarations?: PlanClaimDeclarations;
  readonly approvalCertificate?: PlanApprovalCertificate;
}

/** Whether the certificate binds the plan's current declaration set exactly. */
export function hasCurrentPlanApprovalCertificate(
  plan: PlanClaimAuthority | null | undefined,
): plan is PlanClaimAuthority & { readonly approvalCertificate: PlanApprovalCertificate } {
  if (!plan?.approvalCertificate) return false;
  if (plan.approvalCertificate.authorityDigest !== plan.current.digest) return false;
  // Versionsbindung: Ein Zertifikat für v1 autorisiert nicht v2.
  // Legacy-Zertifikate ohne planVersion werden übersprungen (backward compat).
  if (
    plan.approvalCertificate.planVersion != null &&
    plan.current.planVersion != null &&
    plan.approvalCertificate.planVersion !== plan.current.planVersion
  ) {
    return false;
  }
  const declarations = plan.claimDeclarations ?? { flow: 'plan' as const, claims: [] };
  return (
    plan.approvalCertificate.claimDeclarationsDigest ===
    hashText(canonicalJsonStringify(declarations))
  );
}

/** Critical plan claims authorized by the certificate bound to the current plan. */
export function authorizedCriticalPlanClaimIds(
  plan: PlanClaimAuthority | null | undefined,
): readonly string[] {
  if (!hasCurrentPlanApprovalCertificate(plan)) return [];
  return (plan.claimDeclarations?.claims ?? [])
    .filter((claim) => claim.critical)
    .map((claim) => claim.claimId);
}
