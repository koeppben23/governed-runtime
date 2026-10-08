/**
 * @module session-authority
 * @description The single canonical session-location authority.
 *
 * Every entrypoint that needs to trust a FlowGuard session directory — plugin
 * hooks, tool execution, MCP projection, command hooks — must resolve it here.
 * No other production module may derive an authoritative session path from a
 * workspace fingerprint plus a session id.
 *
 * Pipeline (exactly once):
 *   resolveRoot(root) → computeFingerprint(canonical root)
 *   → optional claimed-fingerprint parity check
 *   → sessionDir(fingerprint, sessionId) → readState(sessDir)
 *   → absent when no state exists at the positively resolved location
 *   → binding.worktree equality and binding.fingerprint equality
 *   → resolved, including the validated session state.
 *
 * `resolved` is itself the proof: this state belongs to this canonical
 * workspace. `absent` is a fact, not a policy: first-hydrate may proceed,
 * mutating paths must block. `unavailable` keeps the original typed code
 * (`GitErrorCode`, `BindingErrorCode`, `PersistenceErrorCode`,
 * `WorkspaceErrorCode`) so callers never have to guess from strings.
 *
 * @version v1
 */

import type { SessionState } from '../state/schema.js';
import {
  BindingError,
  validateBinding,
  validateFingerprintBinding,
  type BindingErrorCode,
} from './binding.js';
import { GitError, resolveRoot, type GitErrorCode } from './git.js';
import { GIT_COMMAND_TIMEOUT_MS } from './git-command.js';
import { PersistenceError, readState, type PersistenceErrorCode } from './persistence.js';
import {
  computeFingerprint,
  sessionDir,
  WorkspaceError,
  type WorkspaceErrorCode,
} from './workspace/index.js';

/** Every typed code the authority can return for an unavailable resolution. */
export type SessionAuthorityErrorCode =
  GitErrorCode | BindingErrorCode | PersistenceErrorCode | WorkspaceErrorCode;

/** Outcome of resolving the canonical session authority for one session id. */
export type SessionAuthorityResolution =
  | {
      readonly status: 'resolved';
      readonly sessDir: string;
      readonly worktreeRoot: string;
      readonly fingerprint: string;
      readonly state: SessionState;
    }
  | {
      readonly status: 'absent';
      readonly sessDir: string;
      readonly worktreeRoot: string;
      readonly fingerprint: string;
    }
  | {
      readonly status: 'unavailable';
      readonly code: SessionAuthorityErrorCode;
      readonly reason: string;
    };

/** Input for the canonical session-authority resolution. */
export interface SessionAuthorityInput {
  /** Root supplied by the entrypoint (plugin worktree, tool context, MCP root). */
  readonly root: string;
  /** Host session id whose FlowGuard session directory is resolved. */
  readonly sessionId: string;
  /**
   * Fingerprint claimed by the entrypoint (MCP transport binding). Verified
   * against the freshly computed canonical projection — cross-entrypoint
   * parity, never a substitute for computing it.
   */
  readonly claimedFingerprint?: string | undefined;
  /**
   * Total monotone budget (ms) for the sequential git probes (worktree root and
   * remote origin). Each probe receives `min(default, remaining)`; an exhausted
   * budget fails closed with `GIT_TIMEOUT` instead of starting another probe.
   * The budget bounds the probes, not the whole calling process.
   */
  readonly deadlineMs?: number | undefined;
}

/**
 * Resolve the canonical session authority.
 *
 * @throws — never for expected failure modes (those are typed outcomes);
 *   unexpected internal errors propagate rather than being disguised as a
 *   known code.
 */
export async function resolveSessionAuthority(
  input: SessionAuthorityInput,
): Promise<SessionAuthorityResolution> {
  if (input.root.trim().length === 0) {
    return {
      status: 'unavailable',
      code: 'NO_WORKTREE',
      reason: 'Neither a worktree nor a directory is available to resolve the session workspace.',
    };
  }

  // One monotone deadline for the whole probe sequence. `performance.now()` is
  // monotone, so wall-clock adjustments cannot extend the budget.
  const deadlineAt = input.deadlineMs === undefined ? null : performance.now() + input.deadlineMs;

  /**
   * Remaining per-probe timeout, or undefined without a budget. Never returns
   * 0: `execFile` treats `timeout: 0` as "no timeout", so an exhausted budget
   * must fail closed before the probe instead.
   */
  const nextProbeTimeout = (): number | undefined => {
    if (deadlineAt === null) return undefined;
    const remaining = deadlineAt - performance.now();
    if (remaining <= 0) {
      throw new GitError(
        'GIT_TIMEOUT',
        'Session authority deadline exceeded before the next git probe',
      );
    }
    return Math.max(1, Math.min(GIT_COMMAND_TIMEOUT_MS, Math.floor(remaining)));
  };

  let worktreeRoot: string;
  try {
    worktreeRoot = await resolveRoot(input.root, nextProbeTimeout());
  } catch (err) {
    return unavailable(err, `Cannot resolve the git worktree root from "${input.root}"`);
  }

  let fingerprint: string;
  try {
    fingerprint = (await computeFingerprint(worktreeRoot, nextProbeTimeout())).fingerprint;
  } catch (err) {
    return unavailable(err, `Cannot compute the workspace fingerprint for "${worktreeRoot}"`);
  }

  if (input.claimedFingerprint !== undefined && input.claimedFingerprint !== fingerprint) {
    return {
      status: 'unavailable',
      code: 'SESSION_BINDING_MISMATCH',
      reason:
        `Claimed workspace fingerprint "${input.claimedFingerprint}" does not match ` +
        `the canonical fingerprint "${fingerprint}" of "${worktreeRoot}".`,
    };
  }

  let sessDir: string;
  try {
    sessDir = sessionDir(fingerprint, input.sessionId);
  } catch (err) {
    return unavailable(err, `Cannot derive the session directory for session "${input.sessionId}"`);
  }

  let state: SessionState | null;
  try {
    state = await readState(sessDir);
  } catch (err) {
    return unavailable(err, `Cannot read session state at "${sessDir}"`);
  }

  if (state === null) {
    return { status: 'absent', sessDir, worktreeRoot, fingerprint };
  }

  try {
    validateBinding(state, { worktreeRoot, sessionId: input.sessionId });
    validateFingerprintBinding(state, fingerprint);
  } catch (err) {
    return unavailable(err, 'Persisted session binding does not match the canonical workspace');
  }

  return { status: 'resolved', sessDir, worktreeRoot, fingerprint, state };
}

/** Map a typed adapter/workspace error to an unavailable outcome. */
function unavailable(
  err: unknown,
  context: string,
): Extract<SessionAuthorityResolution, { status: 'unavailable' }> {
  if (
    err instanceof GitError ||
    err instanceof BindingError ||
    err instanceof PersistenceError ||
    err instanceof WorkspaceError
  ) {
    return { status: 'unavailable', code: err.code, reason: `${context}: ${err.message}` };
  }
  throw err;
}
