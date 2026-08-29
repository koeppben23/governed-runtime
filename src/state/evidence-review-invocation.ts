/**
 * @module state/evidence-review-invocation
 * @description Independent-review invocation-evidence schema.
 *
 * `ReviewInvocationEvidence` captures how an independent reviewer was invoked
 * for an obligation and the host-authoritative outcome of that invocation
 * (verdict, raw findings, transport mode, host corroboration). Extracted from
 * `evidence-review.ts` to keep that schema module within the production
 * file-size budget; re-exported there for the historical import surface.
 *
 * @version v1
 */

import { z } from 'zod';
import { REVIEWER_SUBAGENT_TYPE } from './evidence-identifiers.js';
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
    /** Persisted attempt identity. Populated at binding time from the host-authoritative
     *  attempt. Optional for legacy records; absent lineage MUST be treated as a hard
     *  blocker (attempt_lineage_unavailable) by any status-mutating path. */
    attemptId: z.string().uuid().optional(),
    /** How the reviewer was invoked: host-visible Task tool, SDK, manual attested, or
     *  manual attested corroborated by a FlowGuard-captured host hook (native_subagent_attested). */
    invocationMode: z.enum([
      'host_subagent_task',
      'sdk_session_prompt',
      'manual_attested',
      'native_subagent_attested',
    ]),
    /** Whether this invocation produced a host-visible child session in the OpenCode GUI. */
    hostVisible: z.boolean(),
    promptHash: z.string().min(1),
    canonicalPromptDigest: Sha256Digest.optional(),
    modelPromptDigest: Sha256Digest.nullable().optional(),
    hostTaskCallId: z.string().min(1).optional(),
    mandateDigest: z.string().min(1),
    criteriaVersion: z.string().min(1),
    findingsHash: z.string().min(1),
    invokedAt: z.string().datetime(),
    fulfilledAt: z.string().datetime().nullable(),
    consumedByObligationId: z.string().uuid().nullable(),
    /** Captured verdict from the reviewer's actual output (host-task authoritative). */
    capturedVerdict: z.string().optional(),
    /** Complete raw findings captured by the plugin from the reviewer's output (host-task only).
     *  Enables evidence-based findings resolution: the tool reads findings directly from
     *  invocation evidence, eliminating agent-side reconstruction of the ReviewFindings object. */
    capturedRawFindings: z.record(z.string(), z.unknown()).optional(),
    /** Evidence source: host-orchestrated or agent-submitted-attested. */
    source: z.enum(['host-orchestrated', 'agent-submitted-attested']).optional(),
    /** Reviewer output transport used to obtain the findings. */
    reviewOutputMode: z.enum(['structured_output', 'text_compat']).default('structured_output'),
    /** True only when OpenCode SDK structured_output was present and used. */
    structuredOutputUsed: z.boolean().default(true),
    /** Review-output assurance tier, distinct from actor identity assurance.
     *  - structured_high: reviewer output parsed as clean, schema-conforming JSON.
     *  - structured_recovered: findings recovered from an embedded/brace-balanced
     *    JSON block in mixed model output; extraction succeeded but the response
     *    was not a clean structured payload, so provenance confidence is reduced. (F8)
     *  - text_compat_lower: text-compatibility extraction path. */
    reviewAssuranceLevel: z
      .enum(['structured_high', 'structured_recovered', 'text_compat_lower'])
      .default('structured_high'),
    /** JSON extraction strategy used for text compatibility mode only. */
    extractionMethod: z.enum(['direct_json', 'json_fence', 'outermost_braces']).optional(),
    /** Original model capability error that caused text compatibility mode. */
    modelCapabilityError: z.string().optional(),
    /** Host-captured corroboration (native_subagent_attested only).
     *  Populated from a FlowGuard hook (SubagentStop / PostToolUse) that fired inside the
     *  reviewer subagent. These fields are the independent host witness that the review tool
     *  was invoked from within a genuine `flowguard-reviewer` subagent, not the main thread. */
    hostCapturedAgentId: z.string().min(1).optional(),
    hostCapturedAgentType: z.literal(REVIEWER_SUBAGENT_TYPE).optional(),
    hostCaptureSource: z.enum(['subagent_stop_hook', 'post_tool_use_hook']).optional(),
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
  .readonly();
export type ReviewInvocationEvidence = z.infer<typeof ReviewInvocationEvidence>;
