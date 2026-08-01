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

/** An ADR claim names the checks expected to cover and falsify it after implementation. */
export const ArchitectureClaimDeclaration = z
  .object({
    ...preEvidenceClaimDeclaration,
    expectedCheckId: z.string().min(1),
    counterexampleCheckId: z.string().min(1).optional(),
    structuralSurface: z.string().min(1).optional(),
    mutationProfile: z.string().min(1).optional(),
  })
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

export const ProofGraphApprovalCertificate = z
  .object({ flow: ProofGraphApprovalFlow, ...approvalCertificateShape })
  .readonly();
export type ProofGraphApprovalCertificate = z.infer<typeof ProofGraphApprovalCertificate>;

/** A common certificate constrained for plan approval persistence. */
export const PlanApprovalCertificate = z
  .object({ flow: z.literal('plan'), ...approvalCertificateShape })
  .readonly();
export type PlanApprovalCertificate = z.infer<typeof PlanApprovalCertificate>;

/** A common certificate constrained for architecture approval persistence. */
export const ArchitectureApprovalCertificate = z
  .object({ flow: z.literal('architecture'), ...approvalCertificateShape })
  .readonly();
export type ArchitectureApprovalCertificate = z.infer<typeof ArchitectureApprovalCertificate>;

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
