/**
 * @module hooks/shared/reviewer-capture-writer
 * @description Shared logic for writing host-captured reviewer corroboration records.
 *
 * Used by the PostToolUse and SubagentStop hooks. A capture is only written when the
 * hook fired inside a genuine `flowguard-reviewer` subagent (agent_type match). This is
 * the independent host witness that upgrades `manual_attested` review evidence to
 * `native_subagent_attested`.
 *
 * Fail-closed: never throws into the caller; capture-write failures are logged and the
 * informational hook still exits 0. Absence of a capture simply means no tier upgrade.
 *
 * @version v1
 */

import { REVIEWER_SUBAGENT_TYPE, TOOL_FLOWGUARD_REVIEW } from '../../integration/tool-names.js';
import { appendReviewerCapture } from '../../adapters/persistence-reviewer-capture.js';
import type { ReviewerSubagentCapture } from '../../state/evidence-reviewer-capture.js';

/** True when the hook's agent_type identifies the FlowGuard reviewer subagent. */
export function isReviewerAgentType(agentType: string | undefined): boolean {
  return agentType === REVIEWER_SUBAGENT_TYPE;
}

/**
 * True when the tool name refers to the FlowGuard review tool. Tolerates the MCP
 * namespacing the host applies, e.g. `mcp__flowguard__flowguard_review`.
 */
export function isReviewTool(toolName: string | undefined): boolean {
  if (typeof toolName !== 'string') return false;
  return toolName === TOOL_FLOWGUARD_REVIEW || toolName.endsWith(`__${TOOL_FLOWGUARD_REVIEW}`);
}

/**
 * Best-effort extraction of the obligation id from a review-tool input payload.
 * The reviewer submits a complete ReviewFindings object whose attestation carries
 * `toolObligationId`. Returns undefined when not present (no obligation binding).
 */
export function extractObligationId(toolInput: Record<string, unknown>): string | undefined {
  const candidates: unknown[] = [
    (toolInput['reviewFindings'] as Record<string, unknown> | undefined)?.['attestation'],
    toolInput['attestation'],
    toolInput,
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object') {
      const value = (candidate as Record<string, unknown>)['toolObligationId'];
      if (typeof value === 'string' && value.length > 0) return value;
    }
  }
  return undefined;
}

function captureWriteFailureDiagnostic(input: {
  readonly source: ReviewerSubagentCapture['source'];
  readonly obligationId?: string;
  readonly error: unknown;
}): string {
  const detail = {
    reason: 'capture_write_failed',
    source: input.source,
    ...(input.obligationId !== undefined ? { obligationId: input.obligationId } : {}),
    error: input.error instanceof Error ? input.error.message : String(input.error),
  };
  return `WARN: reviewer capture write failed: ${JSON.stringify(detail)}`;
}

/**
 * Build and persist a reviewer capture record. Returns the persisted record, or null
 * when no capture should be written (non-reviewer agent) or a write error occurred.
 *
 * @param log - Logger callback (hook writeLog) — never throws.
 */
export async function writeReviewerCapture(
  sessionDir: string,
  input: {
    readonly source: ReviewerSubagentCapture['source'];
    readonly sessionId: string;
    readonly agentId: string | undefined;
    readonly agentType: string | undefined;
    readonly toolName?: string;
    readonly reviewToolInvoked?: boolean;
    readonly obligationId?: string;
  },
  log: (msg: string) => void,
): Promise<ReviewerSubagentCapture | null> {
  // Fail-closed gate: only the reviewer subagent produces corroboration.
  if (!isReviewerAgentType(input.agentType) || !input.agentId) {
    return null;
  }

  const capture: ReviewerSubagentCapture = {
    capturedAt: new Date().toISOString(),
    source: input.source,
    sessionId: input.sessionId,
    agentId: input.agentId,
    agentType: REVIEWER_SUBAGENT_TYPE,
    ...(input.toolName !== undefined ? { toolName: input.toolName } : {}),
    reviewToolInvoked: input.reviewToolInvoked ?? false,
    ...(input.obligationId !== undefined ? { obligationId: input.obligationId } : {}),
  };

  try {
    const persisted = await appendReviewerCapture(sessionDir, capture);
    log(`reviewer capture persisted: ${input.source} agent=${input.agentId}`);
    return persisted;
  } catch (err) {
    log(
      captureWriteFailureDiagnostic({
        source: input.source,
        obligationId: input.obligationId,
        error: err,
      }),
    );
    return null;
  }
}
