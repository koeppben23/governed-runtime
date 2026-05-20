/**
 * @module hooks/shared/phase-gate
 * @description Thin delegation layer to the canonical phase-tool-gate authority.
 *
 * Hook scripts use this module to access phase gate logic.
 * All enforcement decisions delegate to `src/integration/phase-tool-gate.ts` —
 * the single canonical authority for host-tool phase gating.
 *
 * Additionally provides subagent authorization as defense-in-depth:
 * external platforms (Claude Code, Codex) do not have the same subagent model
 * as OpenCode, but if a `task` tool call with `subagent_type` is detected,
 * only the authorized reviewer subagent type is permitted.
 *
 * @version v1
 */

export {
  isMutatingHostTool,
  isHostToolAllowedInPhase,
  type PhaseGateResult,
} from '../../integration/phase-tool-gate.js';

import { REVIEWER_SUBAGENT_TYPE } from '../../shared/flowguard-identifiers.js';
import type { PhaseGateResult } from '../../integration/phase-tool-gate.js';

// ─── Subagent Authorization (Defense-in-Depth) ───────────────────────────────

/**
 * Check if a tool call targets an unauthorized subagent.
 *
 * On external platforms, the `task` tool may or may not exist with the same
 * semantics as OpenCode. This function provides defense-in-depth: if a tool
 * named `task` carries a `subagent_type` argument, only the authorized
 * reviewer subagent type is permitted.
 *
 * @param toolName - Lowercase tool name from hook payload.
 * @param toolInput - Tool input arguments from hook payload.
 * @returns Gate result — allowed if not a subagent call or authorized type; denied otherwise.
 */
export function isSubagentAuthorized(
  toolName: string,
  toolInput: Record<string, unknown>,
): PhaseGateResult {
  // Only applies to the `task` tool.
  if (toolName !== 'task') {
    return { allowed: true };
  }

  // If no subagent_type present, this is not a subagent call — allow.
  const subagentType = toolInput['subagent_type'];
  if (subagentType === undefined || subagentType === null) {
    return { allowed: true };
  }

  // If subagent_type is not a string, deny (malformed input).
  if (typeof subagentType !== 'string') {
    return {
      allowed: false,
      code: 'SUBAGENT_TYPE_UNAUTHORIZED',
      reason: `subagent_type must be a string, got ${typeof subagentType}. Only '${REVIEWER_SUBAGENT_TYPE}' is authorized.`,
    };
  }

  // Empty string — not a subagent call, allow.
  if (subagentType === '') {
    return { allowed: true };
  }

  // Authorized type — allow.
  if (subagentType === REVIEWER_SUBAGENT_TYPE) {
    return { allowed: true };
  }

  // Unauthorized subagent type — deny.
  return {
    allowed: false,
    code: 'SUBAGENT_TYPE_UNAUTHORIZED',
    reason:
      `Subagent type '${subagentType}' is not authorized by FlowGuard governance. ` +
      `Only '${REVIEWER_SUBAGENT_TYPE}' is allowed.`,
  };
}
