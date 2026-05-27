#!/usr/bin/env node
/**
 * @module hooks/stop
 * @description FlowGuard Stop command hook — session cleanup and pending review check.
 *
 * Invoked by Claude Code or Codex when a session ends.
 * Checks for outstanding review obligations and logs a warning if
 * the session ends with unresolved governance requirements.
 *
 * Stop hooks are informational — they do NOT block session termination.
 *
 * @see https://github.com/koeppben23/governed-runtime/issues/244
 * @version v1
 */

import { randomUUID } from 'node:crypto';
import { readStdin, validateSessionPayload } from './shared/stdin-reader.js';
import { writeLog } from './shared/stdout-writer.js';
import { installHookStdoutGuard } from './shared/stdout-guard.js';
import { resolveSession } from './shared/session-resolver.js';
import { detectPlatform } from './shared/platform-detect.js';
import { appendAuditEvent } from '../adapters/persistence-audit.js';
import type { AuditEvent } from '../state/evidence-audit.js';

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Install stdout guard — informational hooks never write stdout,
  // but transitive deps must not corrupt host communication.
  const guard = installHookStdoutGuard();
  try {
    await stopLogic();
  } finally {
    guard.restore();
  }
}

async function stopLogic(): Promise<void> {
  let payload: Record<string, unknown>;
  try {
    payload = await readStdin();
  } catch (err) {
    writeLog(`stdin read failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const platform = detectPlatform(payload);
  writeLog(`stop platform: ${platform}`);

  let validated: ReturnType<typeof validateSessionPayload>;
  try {
    validated = validateSessionPayload(payload);
  } catch (err) {
    writeLog(`validation failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const { session_id, cwd } = validated;

  // Resolve session state to check for pending obligations.
  const resolution = await resolveSession(cwd, session_id);

  if (!resolution.ok) {
    writeLog(`INFO: session state not available (${resolution.code}) — skip cleanup`);
    return;
  }

  const { state, sessionDir } = resolution;

  // Check for outstanding review obligations.
  const pendingObligations =
    state.reviewAssurance?.obligations.filter(
      (ob) => ob.status !== 'consumed' && ob.consumedAt == null,
    ) ?? [];

  if (pendingObligations.length > 0) {
    writeLog(
      `WARN: session ending with ${pendingObligations.length} unresolved review obligation(s). ` +
        `Phase: ${state.phase}. Obligations: ${pendingObligations.map((ob) => ob.obligationId).join(', ')}`,
    );
  }

  // Persist session_stop audit event.
  const now = new Date().toISOString();
  const auditEvent: AuditEvent = {
    id: randomUUID(),
    sessionId: session_id,
    phase: state.phase,
    event: 'lifecycle',
    timestamp: now,
    actor: 'system',
    detail: {
      action: 'session_stop',
      hookSource: 'command_hook',
      platform,
      pendingObligations: pendingObligations.length,
      finalPhase: state.phase,
    },
    enforcementLevel: 'hook_gated',
  };

  try {
    await appendAuditEvent(sessionDir, auditEvent);
    writeLog(`session_stop audit persisted: ${session_id}`);
  } catch {
    writeLog(`INFO: audit write skipped (session dir may not be initialized)`);
  }
}

main().catch((err: unknown) => {
  writeLog(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  // Stop is never blocking.
  process.exitCode = 0;
});
