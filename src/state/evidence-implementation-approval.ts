/**
 * @module evidence-implementation-approval
 * @description ImplementationApprovalCertificate — candidate-bound final approval authority.
 *
 * The certificate binds a human approval decision to the exact ImplementationCandidate
 * whose content was validated and whose lifecycle identity was independently reviewed.
 * It is a downstream Authority, not a property of recorded implementation evidence.
 *
 * @version v1
 */

import { z } from 'zod';

/**
 * Immutable certificate that proves a human decision approved a specific
 * implementation candidate after the governed evidence chain was satisfied.
 *
 * The `candidateDigest` is the lifecycle identity; `contentDigest` is the
 * file-content identity for cross-referencing validation evidence.
 *
 * None of these digests are user-supplied. The rail constructs the
 * certificate from host-authoritative state and observation.
 */
export const ImplementationApprovalCertificate = z
  .object({
    flow: z.literal('implementation'),

    /** Lifecycle identity of the approved candidate (candidateDigest). */
    candidateDigest: z.string().min(1),
    /** Content identity of the approved candidate (contentDigest). */
    contentDigest: z.string().min(1),

    /**
     * Digest of the ReviewDecision attestation this certificate was issued
     * against (canonical JSON of {verdict, rationale, decidedAt, decidedBy}).
     */
    decisionAttestationDigest: z.string().min(1),

    /** The review obligation whose evidence was accepted for this approval. */
    reviewObligationId: z.string().uuid(),
    /** The review attempt that satisfied the obligation for this candidate. */
    reviewAttemptId: z.string().uuid(),
    /** Digest of the review invocation evidence bound to the accepted obligation+attempt. */
    reviewEvidenceDigest: z.string().min(1),

    /** Immutable validation-attempt IDs whose passing result supported this candidate. */
    validationAttemptIds: z.array(z.string().uuid()).min(1),

    /** ISO-8601 timestamp when the human decision was recorded. */
    approvedAt: z.string().datetime(),
    /** Actor identity of the human who approved. */
    approvedBy: z.string().min(1),

    /** Deterministic certificate identity (digest of canonical certificate fields). */
    certificateId: z.string().min(1),
  })
  .strict()
  .readonly();

export type ImplementationApprovalCertificate = z.infer<typeof ImplementationApprovalCertificate>;
