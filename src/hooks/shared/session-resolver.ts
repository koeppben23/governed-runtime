/**
 * @module hooks/shared/session-resolver
 * @description Resolve session directory and read state for hook scripts.
 *
 * Resolution chain:
 * 1. FLOWGUARD_SESSION_DIR env var (explicit override — testing and CI)
 * 2. Resolve the git worktree root from cwd; typed GitError codes are preserved
 * 3. Compute the fingerprint from the canonical root → derive the session dir
 * 4. Validate the canonical root against the state's authoritative worktree binding
 *
 * Canonicalizing before fingerprinting is required: `computeFingerprint()` is
 * defined over a worktree root, and the local-path fallback for repositories
 * without an `origin` would derive a different fingerprint for a subdirectory
 * or symlinked path than for the session's bound root.
 *
 * Fail-closed: if the root cannot be resolved, state cannot be read, or the
 * root does not belong to the bound worktree, returns an explicit error that
 * the calling hook can use to deny tool execution.
 *
 * @version v1
 */

import { existsSync } from 'node:fs';
import { validateCwdAgainstBinding } from '../../adapters/binding.js';
import { GitError, resolveRoot } from '../../adapters/git.js';
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

  // Priority 2: Canonicalize the payload cwd to the git worktree root first,
  // then derive the fingerprint from that root. A subdirectory or symlinked
  // path must not select a different workspace than the session's binding.
  let worktreeRoot: string;
  try {
    worktreeRoot = await resolveRoot(cwd);
  } catch (err) {
    if (err instanceof GitError) {
      return { ok: false, code: err.code, reason: err.message };
    }
    return {
      ok: false,
      code: 'WORKTREE_RESOLUTION_FAILED',
      reason: `Cannot resolve git worktree root from cwd "${cwd}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let fingerprint: string;
  try {
    const fpResult = await computeFingerprint(worktreeRoot);
    fingerprint = fpResult.fingerprint;
  } catch (err) {
    return {
      ok: false,
      code: 'FINGERPRINT_FAILED',
      reason: `Cannot compute workspace fingerprint from worktree "${worktreeRoot}": ${err instanceof Error ? err.message : String(err)}`,
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

  const resolution = await readSessionState(sessDir);
  if (!resolution.ok) return resolution;

  // The canonical root located the session; it must also match the
  // authoritative worktree binding before the caller trusts the state for
  // gating/audit.
  const cwdBinding = await validateCwdAgainstBinding(resolution.state, worktreeRoot);
  if (!cwdBinding.ok) {
    return { ok: false, code: cwdBinding.code, reason: cwdBinding.reason };
  }
  return resolution;
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
