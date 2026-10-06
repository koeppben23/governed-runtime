/**
 * @module hooks/shared/session-resolver
 * @description Resolve session directory and read state for hook scripts.
 *
 * Resolution chain:
 * 1. FLOWGUARD_SESSION_DIR env var (explicit override — testing and CI)
 * 2. `resolveSessionAuthority` — canonical git root from cwd, fingerprint,
 *    session directory, state read, and worktree/fingerprint binding validation
 *
 * Fail-closed: if the root cannot be resolved, state cannot be read, or the
 * root does not belong to the bound worktree, returns an explicit error that
 * the calling hook can use to deny tool execution.
 *
 * @version v2
 */

import { existsSync } from 'node:fs';
import { readState } from '../../adapters/persistence.js';
import { resolveSessionAuthority } from '../../adapters/session-authority.js';
import type { SessionState } from '../../state/schema.js';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Result of session resolution — either success with state or failure with reason. */
export type SessionResolution =
  | { readonly ok: true; readonly state: SessionState; readonly sessionDir: string }
  | { readonly ok: false; readonly code: string; readonly reason: string };

// ─── Resolution ──────────────────────────────────────────────────────────────

/**
 * Resolve the session directory and read the current session state.
 *
 * @param cwd - Working directory (from hook stdin payload).
 * @param sessionId - Session ID (from hook stdin payload).
 * @returns SessionResolution — either success with state or failure with code/reason.
 */
export async function resolveSession(cwd: string, sessionId: string): Promise<SessionResolution> {
  // Priority 1: Explicit override via env var
  const envDir = process.env['FLOWGUARD_SESSION_DIR'];
  if (envDir && envDir.length > 0) {
    return readSessionState(envDir);
  }

  // Priority 2: the canonical session authority resolves the git root,
  // fingerprints it, derives the session directory, and validates the
  // persisted worktree/fingerprint binding before the hook trusts the state.
  let resolution: Awaited<ReturnType<typeof resolveSessionAuthority>>;
  try {
    resolution = await resolveSessionAuthority({ root: cwd, sessionId });
  } catch (err) {
    return {
      ok: false,
      code: 'SESSION_AUTHORITY_UNAVAILABLE',
      reason: `Cannot resolve the session authority from cwd "${cwd}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (resolution.status === 'resolved') {
    return { ok: true, state: resolution.state, sessionDir: resolution.sessDir };
  }
  if (resolution.status === 'unavailable') {
    return { ok: false, code: resolution.code, reason: resolution.reason };
  }
  return {
    ok: false,
    code: existsSync(resolution.sessDir) ? 'STATE_MISSING' : 'SESSION_DIR_NOT_FOUND',
    reason: `No session state exists at "${resolution.sessDir}". Run /hydrate to initialize.`,
  };
}

/**
 * Read session state from a known session directory.
 * Fail-closed: missing directory, missing file, or corrupt file all produce explicit errors.
 */
async function readSessionState(sessDir: string): Promise<SessionResolution> {
  if (!existsSync(sessDir)) {
    return {
      ok: false,
      code: 'SESSION_DIR_NOT_FOUND',
      reason: `Session directory does not exist: "${sessDir}". Run /hydrate to initialize.`,
    };
  }

  let state: SessionState | null;
  try {
    state = await readState(sessDir);
  } catch (err) {
    return {
      ok: false,
      code: 'STATE_UNREADABLE',
      reason: `Session state exists but is unreadable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (state === null) {
    return {
      ok: false,
      code: 'STATE_MISSING',
      reason: `Session directory exists but contains no state file. Run /hydrate to initialize.`,
    };
  }

  return { ok: true, state, sessionDir: sessDir };
}
