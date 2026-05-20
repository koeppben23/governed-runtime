/**
 * @module hooks/shared/session-resolver
 * @description Resolve session directory and read state for hook scripts.
 *
 * Resolution chain:
 * 1. FLOWGUARD_SESSION_DIR env var (explicit override — testing and CI)
 * 2. Compute fingerprint from cwd → derive session dir from fingerprint + session_id
 *
 * Fail-closed: if state cannot be resolved or read, returns an explicit error
 * that the calling hook can use to deny tool execution.
 *
 * @version v1
 */

import { existsSync } from 'node:fs';
import { computeFingerprint } from '../../adapters/workspace/index.js';
import { sessionDir } from '../../adapters/workspace/index.js';
import { readState } from '../../adapters/persistence.js';
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

  // Priority 2: Compute from cwd + sessionId
  let fingerprint: string;
  try {
    const fpResult = await computeFingerprint(cwd);
    fingerprint = fpResult.fingerprint;
  } catch (err) {
    return {
      ok: false,
      code: 'FINGERPRINT_FAILED',
      reason: `Cannot compute workspace fingerprint from cwd "${cwd}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let sessDir: string;
  try {
    sessDir = sessionDir(fingerprint, sessionId);
  } catch (err) {
    return {
      ok: false,
      code: 'SESSION_DIR_INVALID',
      reason: `Cannot derive session directory (fingerprint="${fingerprint}", sessionId="${sessionId}"): ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return readSessionState(sessDir);
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
