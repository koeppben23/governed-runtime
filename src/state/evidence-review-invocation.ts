/**
 * @module state/evidence-review-invocation
 * @description Independent-review invocation-evidence schema.
 *
 * `ReviewInvocationEvidence` captures the single sanctioned way an independent
 * reviewer is invoked: a host-observed SDK child session whose structured
 * findings were captured by the host. There is exactly one generation of this
 * evidence; any other mode or provenance is invalid state and fails parsing.
 *
 * @version v2
 */

import { z } from 'zod';
import { REVIEWER_SUBAGENT_TYPE } from '../shared/flowguard-identifiers.js';
import { ReviewObligationType } from './evidence-primitives.js';

const Sha256Digest = z.string().regex(/^[a-f0-9]{64}$/);

export const ReviewInvocationEvidence = z
  .object({
    invocationId: z.string().uuid(),
    obligationId: z.string().uuid(),
    obligationType: ReviewObligationType,
    parentSessionId: z.string().min(1),
    childSessionId: z.string().min(1),
    agentType: z.literal(REVIEWER_SUBAGENT_TYPE),
    /** Persisted host-authoritative attempt identity. */
    attemptId: z.string().uuid(),
    /** The only sanctioned invocation transport: a host-observed SDK session prompt. */
    invocationMode: z.literal('sdk_session_prompt'),
    /** Whether this invocation produced a host-visible child session in the host GUI. */
    hostVisible: z.boolean(),
    promptHash: z.string().min(1),
    canonicalPromptDigest: Sha256Digest.optional(),
    modelPromptDigest: Sha256Digest.nullable().optional(),
    mandateDigest: z.string().min(1),
    criteriaVersion: z.string().min(1),
    findingsHash: z.string().min(1),
    invokedAt: z.string().datetime(),
    fulfilledAt: z.string().datetime().nullable(),
    consumedByObligationId: z.string().uuid().nullable(),
    /** Verdict derived from the host-captured structured findings. */
    capturedVerdict: z.string().optional(),
    /** Complete structured findings captured by the host from the reviewer's output. */
    capturedRawFindings: z.record(z.string(), z.unknown()),
    /** Evidence is always host-orchestrated. */
    source: z.literal('host-orchestrated'),
    /** Findings are always host-observed structured model output. */
    reviewOutputMode: z.literal('structured_output'),
    /** Host-observed structured model output was used. */
    structuredOutputUsed: z.literal(true),
    /** Output assurance tier for host-observed structured output. */
    reviewAssuranceLevel: z.literal('structured_high'),
    /** Resolved full head commit SHA (branch reviews only). */
    resolvedBranchSha: z
      .string()
      .regex(/^[0-9a-f]{40,64}$/i)
      .nullable()
      .optional(),
    /** Resolved full base commit SHA (branch reviews only). */
    resolvedBaseSha: z
      .string()
      .regex(/^[0-9a-f]{40,64}$/i)
      .nullable()
      .optional(),
    /** SHA-256 digest of the extracted/reviewed content (branch reviews only). */
    reviewedContentDigest: z
      .string()
      .regex(/^[0-9a-f]{64}$/i)
      .nullable()
      .optional(),
  })
  .strict()
  .readonly();
export type ReviewInvocationEvidence = z.infer<typeof ReviewInvocationEvidence>;
