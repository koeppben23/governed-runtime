/**
 * @module state/evidence-reviewer-capture
 * @description Host-captured corroboration that a `flowguard-reviewer` subagent ran.
 *
 * These records are written by FlowGuard's own hooks (SubagentStop / PostToolUse) when
 * they fire INSIDE a `flowguard-reviewer` subagent. They are an independent host witness,
 * separate from the agent's self-attestation, used to upgrade `manual_attested` review
 * evidence to `native_subagent_attested` on out-of-process hosts (Claude Code, Codex).
 *
 * Fail-closed: a capture is only ever written when `agent_type` equals the reviewer
 * subagent type. Absence of a capture simply means the stronger tier is not granted —
 * the review still falls back to `manual_attested` validation rules.
 *
 * @version v1
 */

import { z } from 'zod';
import { REVIEWER_SUBAGENT_TYPE } from '../shared/flowguard-identifiers.js';

/**
 * A single host-captured corroboration record for a reviewer subagent.
 *
 * - `post_tool_use_hook`: the reviewer subagent invoked the FlowGuard review tool.
 *   This is the strong witness — it binds the subagent identity to a specific
 *   obligation (`obligationId`, extracted from the review tool input).
 * - `subagent_stop_hook`: the reviewer subagent finished. Secondary witness —
 *   confirms subagent completion but carries no obligation binding.
 */
export const ReviewerSubagentCapture = z
  .object({
    capturedAt: z.string().datetime(),
    source: z.enum(['subagent_stop_hook', 'post_tool_use_hook']),
    /** Parent session id from the hook payload. */
    sessionId: z.string().min(1),
    /** Unique host identifier for the subagent invocation. */
    agentId: z.string().min(1),
    /** Always the reviewer subagent type — a capture is never written for other agents. */
    agentType: z.literal(REVIEWER_SUBAGENT_TYPE),
    /** Tool name (post_tool_use only). */
    toolName: z.string().optional(),
    /** Whether this capture observed the FlowGuard review tool being invoked. */
    reviewToolInvoked: z.boolean().default(false),
    /** Obligation the reviewer bound its findings to (post_tool_use only, best-effort). */
    obligationId: z.string().uuid().optional(),
  })
  .readonly();
export type ReviewerSubagentCapture = z.infer<typeof ReviewerSubagentCapture>;
