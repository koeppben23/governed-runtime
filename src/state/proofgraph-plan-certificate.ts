/**
 * @module proofgraph-plan-certificate
 * @description Versioned plan approval certificate: review-evidence binding,
 * explicit/policy-auto approval attestation, and the canonical certificate
 * identity. Extracted from `proofgraph-approval.ts` along the certificate
 * boundary to keep both modules within the file-size budget.
 *
 * @version v1
 */

import { z } from 'zod';
import { canonicalJsonStringify } from '../shared/canonical-json.js';
import { digestToId, hashText } from '../shared/hashing.js';
import { POLICY_DIGEST_PATTERN, POLICY_DIGEST_VERSION } from './evidence-identifiers.js';
import { ReviewDecision } from './evidence-review-report.js';

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

export function refineReviewBinding(
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
const PlanApprovalAttestationSchema = z.discriminatedUnion('kind', [
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
export type PlanApprovalAttestation = z.infer<typeof PlanApprovalAttestationSchema>;

/**
 * Canonical certificate identity over the full certified content. The SAME
 * authority is used at mint time and when a parsed or in-memory certificate is
 * validated, so a relabeled or tampered `certificateId` fails closed instead
 * of surviving as an unbound identifier.
 */
export function planApprovalCertificateIdentity(input: {
  readonly authorityDigest: string;
  readonly claimDeclarationsDigest: string;
  readonly decisionAttestationDigest: string;
  readonly planVersion: number;
  readonly planRecordDigest: string;
  readonly reviewBinding: ReviewBinding;
  readonly approvedAt: string;
}): string {
  return digestToId(
    hashText(
      canonicalJsonStringify({
        schemaVersion: 'plan-approval-certificate.v1',
        authorityDigest: input.authorityDigest,
        claimDeclarationsDigest: input.claimDeclarationsDigest,
        decisionAttestationDigest: input.decisionAttestationDigest,
        planVersion: input.planVersion,
        planRecordDigest: input.planRecordDigest,
        reviewBinding: input.reviewBinding,
        approvedAt: input.approvedAt,
      }),
    ),
    4,
  );
}

/**
 * A plan approval certificate, versioned and attestation-discriminated.
 * `decisionAttestationDigest` is recomputed at parse time, so a relabeled kind
 * or swapped decision is rejected, not silently reinterpreted. `approvedBy`
 * deliberately does not exist for plan certificates — an automatic approval
 * has no person to name, and an explicit decision carries its identity inside
 * the attestation.
 */
/**
 * Whether the certificate id equals the canonical identity over its certified
 * content. Shared by the parse-time schema and the authorization-time
 * validator so a tampered id fails closed on every boundary.
 */
export function isCanonicalPlanCertificateIdentity(certificate: {
  readonly authorityDigest: string;
  readonly claimDeclarationsDigest: string;
  readonly decisionAttestationDigest: string;
  readonly planVersion: number;
  readonly planRecordDigest: string;
  readonly reviewBinding: ReviewBinding;
  readonly approvedAt: string;
  readonly certificateId: string;
}): boolean {
  return (
    certificate.certificateId ===
    planApprovalCertificateIdentity({
      authorityDigest: certificate.authorityDigest,
      claimDeclarationsDigest: certificate.claimDeclarationsDigest,
      decisionAttestationDigest: certificate.decisionAttestationDigest,
      planVersion: certificate.planVersion,
      planRecordDigest: certificate.planRecordDigest,
      reviewBinding: certificate.reviewBinding,
      approvedAt: certificate.approvedAt,
    })
  );
}

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
    approvalAttestation: PlanApprovalAttestationSchema,
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
    if (!isCanonicalPlanCertificateIdentity(certificate)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['certificateId'],
        message:
          'certificateId must equal the canonical certificate identity over its certified content.',
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
