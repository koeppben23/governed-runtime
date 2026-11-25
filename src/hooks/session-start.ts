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
import { resolveSession } from './shared/session-resolver.js';
import { detectPlatform } from './shared/platform-detect.js';
import { ensureWorkspace } from '../adapters/workspace/index.js';
import { resolveRoot } from '../adapters/git.js';
import { appendAuditEvent } from '../adapters/persistence-audit.js';
import type { AuditEventBody } from '../state/evidence-audit.js';

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

/**
 * Ensure the FlowGuard workspace exists for the git-resolved worktree root.
 *
 * The payload cwd is never used as a filesystem authority: bootstrap runs only
 * on the root that `git rev-parse --show-toplevel` resolves from it. An active
 * FLOWGUARD_SESSION_DIR override skips bootstrap because the resolver accepts it
 * only when it equals the authority-derived session directory (the workspace
 * already exists); the override never selects a different session.
 *
 * @returns false when bootstrap was skipped or failed; the caller must stop.
 */
async function bootstrapWorkspace(cwd: string): Promise<boolean> {
  const envOverride = process.env['FLOWGUARD_SESSION_DIR'];
  if (envOverride !== undefined && envOverride.length > 0) return true;

  let worktreeRoot: string;
  try {
    worktreeRoot = await resolveRoot(cwd);
  } catch (err) {
    writeLog(
      `WARN: workspace bootstrap skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }

  try {
    await ensureWorkspace(worktreeRoot);
    writeLog(`workspace ensured: ${worktreeRoot}`);
    return true;
  } catch (err) {
    writeLog(
      `WARN: workspace bootstrap failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
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

  if (!(await bootstrapWorkspace(cwd))) return;

  // Resolve the governed session. Audit v3 events require the explicit
  // FlowGuard identity (flowguardSessionId); without resolved state the
  // session_start event is skipped — no polymorphic sessionId records.
  const resolution = await resolveSession(cwd, session_id);
  if (!resolution.ok) {
    writeLog(
      `INFO: session state not available (${resolution.code}) — session_start audit skipped`,
    );
    return;
  }
  const { state, sessionDir: sessDir } = resolution;

  const now = new Date().toISOString();
  const auditEvent: AuditEventBody = {
    id: randomUUID(),
    flowguardSessionId: state.flowguardSessionId,
    hostSessionId: session_id,
    phase: 'READY',
    event: 'lifecycle',
    occurredAt: now,
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
