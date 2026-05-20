#!/usr/bin/env node
/**
 * @module hooks/post-tool-use
 * @description FlowGuard PostToolUse command hook — audit persistence and enforcement tracking.
 *
 * Invoked by Claude Code or Codex after each tool execution completes.
 * Records a tool execution audit event to the session's JSONL audit trail.
 *
 * PostToolUse hooks are informational — they do NOT block tool execution
 * (the tool has already completed). This hook always exits 0.
 *
 * Scope (per user decision): Audit + Enforcement tracking only.
 * Orchestrator logic (review subagent triggering) remains in-process.
 *
 * @see https://github.com/koeppben23/governed-runtime/issues/244
 * @version v1
 */

import { randomUUID } from 'node:crypto';
import { readStdin, validateToolHookPayload } from './shared/stdin-reader.js';
import { writeLog } from './shared/stdout-writer.js';
import { resolveSession } from './shared/session-resolver.js';
import { detectPlatform } from './shared/platform-detect.js';
import { appendAuditEvent } from '../adapters/persistence-audit.js';
import type { AuditEvent } from '../state/evidence-audit.js';

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let payload: Record<string, unknown>;
  try {
    payload = await readStdin();
  } catch (err) {
    writeLog(`stdin read failed: ${err instanceof Error ? err.message : String(err)}`);
    // PostToolUse is informational — exit 0 even on read failure.
    return;
  }

  const platform = detectPlatform(payload);
  writeLog(`post-tool-use platform: ${platform}`);

  let validated: ReturnType<typeof validateToolHookPayload>;
  try {
    validated = validateToolHookPayload(payload);
  } catch (err) {
    writeLog(`validation failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const { tool_name, tool_input, session_id, cwd } = validated;

  // Resolve session state — needed for audit context.
  const resolution = await resolveSession(cwd, session_id);

  if (!resolution.ok) {
    // Cannot persist audit without session dir — log warning and exit.
    writeLog(`WARN: cannot persist audit (${resolution.code}): ${resolution.reason}`);
    return;
  }

  const { state, sessionDir } = resolution;
  const now = new Date().toISOString();

  // Build and persist audit event.
  const auditEvent: AuditEvent = {
    id: randomUUID(),
    sessionId: session_id,
    phase: state.phase,
    event: 'tool_call',
    timestamp: now,
    actor: 'machine',
    detail: {
      tool: tool_name,
      input: sanitizeToolInput(tool_input),
      hookSource: 'command_hook',
      platform,
    },
    enforcementLevel: 'hook_gated',
  };

  try {
    await appendAuditEvent(sessionDir, auditEvent);
    writeLog(`audit persisted: ${tool_name} (${session_id})`);
  } catch (err) {
    // Audit failure is non-blocking in post hooks (tool already executed).
    writeLog(`WARN: audit write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Sanitize tool input for audit persistence.
 * Truncates large values to prevent audit trail bloat.
 */
function sanitizeToolInput(input: Record<string, unknown>): Record<string, unknown> {
  const MAX_VALUE_LENGTH = 500;
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string' && value.length > MAX_VALUE_LENGTH) {
      sanitized[key] = value.slice(0, MAX_VALUE_LENGTH) + `... [truncated, ${value.length} chars]`;
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

main().catch((err: unknown) => {
  writeLog(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  // PostToolUse is never blocking — always exit 0.
  process.exitCode = 0;
});
