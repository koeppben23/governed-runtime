/**
 * @module hooks/shared/session-resolver
 * @description Resolve session directory and read state for hook scripts.
 *
 * Resolution chain:
 * 1. `resolveSessionAuthority` — canonical git root from cwd, fingerprint,
 *    session directory, state read, and worktree/fingerprint binding validation.
 * 2. `FLOWGUARD_SESSION_DIR` (testing/CI) is an assertion, never a bypass: the
 *    realpath-canonicalized override must equal the authority-derived session
 *    directory, otherwise the hook fails closed before any state is trusted.
 *
 * Fail-closed: if the root cannot be resolved, the override does not match the
 * canonical projection, state cannot be read, or the root does not belong to
 * the bound worktree, returns an explicit error that the calling hook can use
 * to deny tool execution.
 *
 * @version v3
 */

import { existsSync, realpathSync } from 'node:fs';
import * as path from 'node:path';
import { resolveSessionAuthority } from '../../adapters/session-authority.js';
import type { SessionState } from '../../state/schema.js';
import { SESSION_AUTHORITY_DEADLINE_MS } from './limits.js';

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
  // The canonical authority resolves the git root, fingerprints it, derives the
  // session directory, and validates the persisted worktree/fingerprint binding
  // before the hook trusts the state. This runs even under an override.
  let resolution: Awaited<ReturnType<typeof resolveSessionAuthority>>;
  try {
    resolution = await resolveSessionAuthority({
      root: cwd,
      sessionId,
      deadlineMs: SESSION_AUTHORITY_DEADLINE_MS,
    });
  } catch (err) {
    return {
      ok: false,
      code: 'SESSION_AUTHORITY_UNAVAILABLE',
      reason: `Cannot resolve the session authority from cwd "${cwd}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (resolution.status === 'unavailable') {
    return { ok: false, code: resolution.code, reason: resolution.reason };
  }

  // Testing/CI override as an assertion on the canonical projection: a foreign,
  // symlinked, stale, or merely different session path never becomes an
  // alternative authority.
  const override = process.env['FLOWGUARD_SESSION_DIR'];
  if (override !== undefined && override.length > 0) {
    const overrideFailure = validateSessionDirOverride(override, resolution.sessDir);
    if (overrideFailure !== null) return overrideFailure;
  }

  if (resolution.status === 'resolved') {
    return { ok: true, state: resolution.state, sessionDir: resolution.sessDir };
  }
  return {
    ok: false,
    code: existsSync(resolution.sessDir) ? 'STATE_MISSING' : 'SESSION_DIR_NOT_FOUND',
    reason: `No session state exists at "${resolution.sessDir}". Run /hydrate to initialize.`,
  };
}

/**
 * Canonicalize a path that may not exist yet by resolving its parent. Returns
 * null when neither the path nor its parent can be resolved.
 */
function canonicalizeExistingOrParent(targetPath: string): string | null {
  try {
    return realpathSync(targetPath);
  } catch {
    // Fall through: an absent session directory is still comparable by parent.
  }
  try {
    return path.join(realpathSync(path.dirname(targetPath)), path.basename(targetPath));
  } catch {
    return null;
  }
}

/**
 * Require the override to be the canonical session directory the authority
 * derived. Returns a fail-closed resolution on mismatch, null when it matches.
 */
function validateSessionDirOverride(
  override: string,
  canonicalSessDir: string,
): SessionResolution | null {
  const canonicalOverride = canonicalizeExistingOrParent(override);
  if (canonicalOverride === null) {
    return {
      ok: false,
      code: 'SESSION_OVERRIDE_UNRESOLVABLE',
      reason:
        `FLOWGUARD_SESSION_DIR cannot be resolved to an existing path: "${override}". ` +
        'The override must name the canonical session directory derived from the worktree, fingerprint, and host session id.',
    };
  }

  const expected = canonicalizeExistingOrParent(canonicalSessDir) ?? canonicalSessDir;
  if (canonicalOverride !== expected) {
    return {
      ok: false,
      code: 'SESSION_OVERRIDE_MISMATCH',
      reason:
        `FLOWGUARD_SESSION_DIR "${canonicalOverride}" does not match the canonical session ` +
        `directory "${expected}" derived from the worktree, fingerprint, and host session id.`,
    };
  }

  return null;
}
