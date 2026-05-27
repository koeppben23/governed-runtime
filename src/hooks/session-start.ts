#!/usr/bin/env node
/**
 * @module hooks/session-start
 * @description FlowGuard SessionStart command hook — workspace bootstrap.
 *
 * Invoked by Claude Code or Codex when a new session begins.
 * Ensures the FlowGuard workspace directory structure exists for the project.
 *
 * SessionStart hooks are informational — they do NOT block session creation.
 * The hook ensures workspace readiness so subsequent PreToolUse hooks can
 * resolve the session directory.
 *
 * @see https://github.com/koeppben23/governed-runtime/issues/244
 * @version v1
 */

import { randomUUID } from 'node:crypto';
import { readStdin, validateSessionPayload } from './shared/stdin-reader.js';
import { writeLog } from './shared/stdout-writer.js';
import { installHookStdoutGuard } from './shared/stdout-guard.js';
import { detectPlatform } from './shared/platform-detect.js';
import { ensureWorkspace } from '../adapters/workspace/index.js';
import { appendAuditEvent } from '../adapters/persistence-audit.js';
import { sessionDir } from '../adapters/workspace/index.js';
import type { AuditEvent } from '../state/evidence-audit.js';

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Install stdout guard — informational hooks never write stdout,
  // but transitive deps must not corrupt host communication.
  const guard = installHookStdoutGuard();
  try {
    await sessionStartLogic();
  } finally {
    guard.restore();
  }
}

async function sessionStartLogic(): Promise<void> {
  let payload: Record<string, unknown>;
  try {
    payload = await readStdin();
  } catch (err) {
    writeLog(`stdin read failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const platform = detectPlatform(payload);
  writeLog(`session-start platform: ${platform}`);

  let validated: ReturnType<typeof validateSessionPayload>;
  try {
    validated = validateSessionPayload(payload);
  } catch (err) {
    writeLog(`validation failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const { session_id, cwd } = validated;

  // Ensure workspace directories exist (idempotent).
  let fingerprint: string;
  try {
    const result = await ensureWorkspace(cwd);
    fingerprint = result.fingerprint;
    writeLog(`workspace ensured: ${result.workspaceDir}`);
  } catch (err) {
    writeLog(
      `WARN: workspace bootstrap failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  // Attempt to write session_start audit event.
  // This may fail if session dir doesn't exist yet (no /hydrate run).
  // That's OK — PreToolUse will enforce hydration requirement.
  let sessDir: string;
  try {
    sessDir = sessionDir(fingerprint, session_id);
  } catch {
    writeLog(`WARN: cannot derive session dir (sessionId="${session_id}")`);
    return;
  }

  const now = new Date().toISOString();
  const auditEvent: AuditEvent = {
    id: randomUUID(),
    sessionId: session_id,
    phase: 'READY',
    event: 'lifecycle',
    timestamp: now,
    actor: 'system',
    detail: {
      action: 'session_start',
      hookSource: 'command_hook',
      platform,
      cwd,
    },
    enforcementLevel: 'hook_gated',
  };

  try {
    await appendAuditEvent(sessDir, auditEvent);
    writeLog(`session_start audit persisted: ${session_id}`);
  } catch {
    // Session dir may not exist yet — acceptable, not an error.
    writeLog(`INFO: audit skipped (session dir not initialized yet)`);
  }
}

main().catch((err: unknown) => {
  writeLog(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  // SessionStart is never blocking.
  process.exitCode = 0;
});
