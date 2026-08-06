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
import { CounterexampleRequirement } from './proofgraph.js';
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

/** Structured counterexample requirement for assertion-mode claims. */
export const AssertionCounterexampleRequirement = z
  .object({
    mode: z.literal('assertion'),
    checkId: z.string().min(1),
    assertionId: z.string().min(1),
  })
  .readonly();
export type AssertionCounterexampleRequirement = z.infer<typeof AssertionCounterexampleRequirement>;

/** A plan claim names the checks expected to cover and falsify it after implementation. */
const planBase = z
  .object({
    ...preEvidenceClaimDeclaration,
    expectedCheckId: z.string().min(1),
    counterexampleRequirement: AssertionCounterexampleRequirement.optional(),
    structuralSurface: z.string().min(1).optional(),
    mutationProfile: z.string().min(1).optional(),
  })
  .strict();

/** Writable plan claim declaration (assertion-mode only). */
export const WritablePlanClaimDeclaration = planBase.readonly();
export type WritablePlanClaimDeclaration = z.infer<typeof WritablePlanClaimDeclaration>;

export const PlanClaimDeclaration = z
  .object({
    claimId: z.string().uuid(),
    statement: z.string().min(1),
    critical: z.boolean(),
    authoritySectionId: z.string().min(1),
    expectedCheckId: z.string().min(1),
    counterexampleRequirement: CounterexampleRequirement.optional(),
    structuralSurface: z.string().min(1).optional(),
    mutationProfile: z.string().min(1).optional(),
  })
  .strict()
  .readonly();
export type PlanClaimDeclaration = z.infer<typeof PlanClaimDeclaration>;

/** Public input for a plan claim — claimId is minted host-side, assertion-mode only. */
export const PlanClaimDeclarationInput = planBase.omit({ claimId: true }).strict();
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
): WritablePlanClaimDeclaration[] | undefined {
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
    readonly planVersion: number;
    readonly recordDigest: string;
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
  if (plan.approvalCertificate.planVersion !== plan.current.planVersion) return false;
  // Record-Digest-Bindung: Gleicher Plantext + gleiche Version, aber anderer
  // recordDigest (z.B. andere Lineage-Metadaten) invalidiert das Zertifikat.
  if (plan.approvalCertificate.planRecordDigest !== plan.current.recordDigest) return false;
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
