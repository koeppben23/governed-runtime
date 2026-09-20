/**
 * @module evidence-review-attestation
 * @description Review actor identity, strict independent-review attestation,
 *              structured findings objects, and their canonical digests.
 *
 * @version v1
 */

import { z } from 'zod';
import { canonicalJsonStringify } from '../shared/canonical-json.js';
import { hashText } from '../shared/hashing.js';
import { REVIEWER_SUBAGENT_TYPE } from '../shared/flowguard-identifiers.js';
import { ActorAssuranceSchema } from '../shared/actor-assurance.js';
import { LoopVerdict } from './evidence-primitives.js';
import { Finding } from './evidence-findings.js';
import { ReviewChallenge, ChallengeResolutionVerdict } from './evidence-review-challenge.js';

/**
 * Identity information for the review actor (subagent or self).
 * Provides provenance for independent review attribution.
 */
export const ReviewActorInfo = z
  .object({
    sessionId: z.string(),
    actorId: z.string().optional(),
    actorSource: z.enum(['env', 'git', 'claim', 'unknown']).optional(),
    actorAssurance: ActorAssuranceSchema.optional(),
  })
  .strict()
  .readonly();
export type ReviewActorInfo = z.infer<typeof ReviewActorInfo>;

/**
 * P35 strict independent-review attestation.
 * Binds findings to one obligation + mandate version/digest.
 *
 * `toolObligationId` identifies the ReviewObligation this attestation is
 * bound to. All reviewable flows (/plan, /architecture, /implement,
 * /review) create a ReviewObligation before subagent invocation, so the
 * UUID is always available.
 * validateStrictAttestation (review-assurance.ts) and plugin-orchestrator.ts
 * compare this field against the expected obligationId.
 */
export const ReviewAttestation = z
  .object({
    mandateDigest: z.string().min(1),
    criteriaVersion: z.string().min(1),
    toolObligationId: z.string().uuid(),
    iteration: z.number().int().nonnegative(),
    planVersion: z.number().int().positive(),
    reviewedBy: z.literal(REVIEWER_SUBAGENT_TYPE),
  })
  .strict()
  .readonly();
export type ReviewAttestation = z.infer<typeof ReviewAttestation>;

/**
 * Structured findings from an independent review.
 * Enables read-only subagent review without direct state/file writes.
 *
 * Provenance authority contract (F8):
 * `reviewedAt` and `reviewedBy` are host-authoritative fields. In host-task
 * capture mode the host overwrites them at binding time with the real
 * invocation timestamp and resolved child-session identity (see
 * normalizeHostTaskFindings in evidence-binding.ts). A model MUST NOT be
 * treated as an authority for the review execution time or reviewer identity.
 * The reviewer's own (untrusted) claims are preserved separately in
 * `reviewerClaimedAt` / `reviewerClaimedBy` for diagnostics only; they never
 * override the host-stamped canonical values.
 */
export const ReviewFindingsObject = z
  .object({
    iteration: z.number().int().nonnegative(),
    planVersion: z.number().int().positive(),
    reviewMode: z.enum(['subagent', 'self']),
    overallVerdict: LoopVerdict,
    blockingIssues: z.array(Finding),
    majorRisks: z.array(Finding),
    missingVerification: z.array(z.string()),
    scopeCreep: z.array(z.string()),
    unknowns: z.array(z.string()),
    reviewedBy: ReviewActorInfo,
    reviewedAt: z.string().datetime(),
    /**
     * Untrusted reviewer-claimed execution time, retained for diagnostics only.
     * Populated by the host from the model's original `reviewedAt` when that
     * value is overwritten with the host-authoritative timestamp. Never audit
     * authority. (F8)
     */
    reviewerClaimedAt: z.string().optional(),
    /**
     * Untrusted reviewer-claimed identity, retained for diagnostics only.
     * Populated by the host from the model's original `reviewedBy` when that
     * value is overwritten with the resolved child-session identity. Never
     * audit authority. (F8)
     */
    reviewerClaimedBy: ReviewActorInfo.optional(),
    attestation: ReviewAttestation.optional(),
    /** Review challenges. REQUIRED: `[]` is the canonical "no challenges" form. */
    challenges: z.array(ReviewChallenge),
    /** Reviewer-only verdicts for prior implementation challenge resolutions. */
    challengeResolutionVerdicts: z.array(ChallengeResolutionVerdict).optional(),
  })
  .strict();
export const ReviewFindings = ReviewFindingsObject.readonly();
export type ReviewFindings = z.infer<typeof ReviewFindings>;

export function reviewFindingsDigests(findings: ReviewFindings | undefined): {
  findingsDigest: string | null;
  attestationDigest: string | null;
} {
  if (!findings) return { findingsDigest: null, attestationDigest: null };
  return {
    findingsDigest: hashText(canonicalJsonStringify(findings)),
    attestationDigest: findings.attestation
      ? hashText(canonicalJsonStringify(findings.attestation))
      : null,
  };
}
