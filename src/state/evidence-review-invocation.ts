/**
 * @module state/evidence-review-invocation
 * @description Independent-review invocation-evidence schema.
 *
 * `ReviewInvocationEvidence` captures host-observed reviewer execution and the
 * structured findings bound to it. The only sanctioned OpenCode transport keeps
 * one native, host-visible Task child across review execution and the
 * schema-constrained serialization follow-up.
 *
 * @version v4
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
    /**
     * The reviewer executes as a native OpenCode Task child and emits its
     * authoritative structured findings through a schema-constrained follow-up
     * in that same child session.
     */
    invocationMode: z.literal('native_task_structured_followup'),
    /** Native Task execution must be visible from the parent host session. */
    hostVisible: z.literal(true),
    /** Native Task metadata must provide a navigable child transcript. */
    transcriptNavigable: z.literal(true),
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
