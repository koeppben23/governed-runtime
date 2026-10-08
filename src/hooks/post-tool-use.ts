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
import {
  readStdinRaw,
  validateToolHookPayload,
  StdinReadError,
  type StdinReadResult,
} from './shared/stdin-reader.js';
import { writeLog } from './shared/stdout-writer.js';
import { installHookStdoutGuard } from './shared/stdout-guard.js';
import { resolveSession } from './shared/session-resolver.js';
import { detectPlatform } from './shared/platform-detect.js';
import { isMutatingHostTool } from './shared/phase-gate.js';
import { assessObligationEscalation } from './shared/obligation-tracker.js';
import { appendAuditEvent } from '../adapters/persistence-audit.js';
import { appendHookIngestFailure } from '../adapters/persistence-hook-ingest.js';
import type { AuditEventBody } from '../state/evidence-audit.js';

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Install stdout guard — informational hooks never write stdout,
  // but transitive deps must not corrupt the empty-stdout ALLOW signal.
  const guard = installHookStdoutGuard();
  try {
    await postToolUseLogic();
  } finally {
    guard.restore();
  }
}

/**
 * Record an unattributable ingestion failure in the bounded, non-audit
 * transport ledger. The hook must never hang or fail on a broken ledger.
 */
async function recordIngestFailure(input: {
  readonly reasonCode: string;
  readonly observedBytes: number | null;
  readonly observedPrefix: Buffer | null;
}): Promise<void> {
  const result = await appendHookIngestFailure({
    transport: 'command_hook',
    event: 'PostToolUse',
    ...input,
  });
  writeLog(
    result.recorded
      ? `WARN: transport ingestion failure recorded (${input.reasonCode}); NOT a tool-call audit event`
      : `WARN: transport ingestion failure NOT recorded (${input.reasonCode}, ${result.reason ?? 'unknown'}); NOT a tool-call audit event`,
  );
}

async function postToolUseLogic(): Promise<void> {
  let read: StdinReadResult;
  try {
    read = await readStdinRaw();
  } catch (err) {
    writeLog(`stdin read failed: ${err instanceof Error ? err.message : String(err)}`);
    // PostToolUse is informational — exit 0 even on read failure.
    await recordIngestFailure({
      reasonCode: err instanceof StdinReadError ? err.code : 'HOOK_STDIN_INVALID',
      observedBytes: err instanceof StdinReadError ? err.observedBytes : null,
      observedPrefix: err instanceof StdinReadError ? err.observedPrefix : null,
    });
    return;
  }

  const payload = read.payload;
  const platform = detectPlatform(payload);
  writeLog(`post-tool-use platform: ${platform}`);

  let validated: ReturnType<typeof validateToolHookPayload>;
  try {
    validated = validateToolHookPayload(payload);
  } catch (err) {
    writeLog(`validation failed: ${err instanceof Error ? err.message : String(err)}`);
    await recordIngestFailure({
      reasonCode: 'HOOK_PAYLOAD_INVALID',
      observedBytes: read.raw.byteLength,
      observedPrefix: read.raw,
    });
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
  const auditEvent: AuditEventBody = {
    id: randomUUID(),
    flowguardSessionId: state.flowguardSessionId,
    hostSessionId: session_id,
    phase: state.phase,
    event: 'tool_call',
    occurredAt: now,
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

  // Gap 4 mitigation: escalating warnings for pending review obligations.
  const escalation = assessObligationEscalation(state, isMutatingHostTool(tool_name.toLowerCase()));
  if (escalation.message) {
    writeLog(escalation.message);
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
