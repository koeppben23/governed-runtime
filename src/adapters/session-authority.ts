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
import { isHistoricalReviewTransport } from '../state/evidence-review-invocation.js';
import { isTerminalPhase } from '../machine/topology.js';
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

type UnavailableResolution = Extract<SessionAuthorityResolution, { status: 'unavailable' }>;
type ProbeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly unavailable: UnavailableResolution };

interface SessionProbeDeadline {
  nextProbeTimeout(): number | undefined;
  assertWithinDeadline(probe: string): void;
}

function createSessionProbeDeadline(deadlineMs: number | undefined): SessionProbeDeadline {
  const deadlineAt = deadlineMs === undefined ? null : performance.now() + deadlineMs;
  return {
    nextProbeTimeout() {
      if (deadlineAt === null) return undefined;
      const remaining = deadlineAt - performance.now();
      if (remaining <= 0) {
        throw new GitError(
          'GIT_TIMEOUT',
          'Session authority deadline exceeded before the next git probe',
        );
      }
      return Math.max(1, Math.min(GIT_COMMAND_TIMEOUT_MS, Math.floor(remaining)));
    },
    assertWithinDeadline(probe: string) {
      if (deadlineAt !== null && performance.now() >= deadlineAt) {
        throw new GitError(
          'GIT_TIMEOUT',
          `Session authority deadline exceeded after the ${probe} git probe`,
        );
      }
    },
  };
}

async function probeWorktreeRoot(
  input: SessionAuthorityInput,
  deadline: SessionProbeDeadline,
): Promise<ProbeResult<string>> {
  try {
    const value = await resolveRoot(input.root, deadline.nextProbeTimeout());
    deadline.assertWithinDeadline('worktree root');
    return { ok: true, value };
  } catch (err) {
    return {
      ok: false,
      unavailable: unavailable(err, `Cannot resolve the git worktree root from "${input.root}"`),
    };
  }
}

async function probeFingerprint(
  worktreeRoot: string,
  deadline: SessionProbeDeadline,
): Promise<ProbeResult<string>> {
  try {
    const value = (await computeFingerprint(worktreeRoot, deadline.nextProbeTimeout())).fingerprint;
    deadline.assertWithinDeadline('remote-origin fingerprint');
    return { ok: true, value };
  } catch (err) {
    return {
      ok: false,
      unavailable: unavailable(
        err,
        `Cannot compute the workspace fingerprint for "${worktreeRoot}"`,
      ),
    };
  }
}

async function loadSessionState(sessDir: string): Promise<ProbeResult<SessionState | null>> {
  try {
    return { ok: true, value: await readState(sessDir) };
  } catch (err) {
    return {
      ok: false,
      unavailable: unavailable(err, `Cannot read session state at "${sessDir}"`),
    };
  }
}

function claimedFingerprintMismatch(
  input: SessionAuthorityInput,
  fingerprint: string,
  worktreeRoot: string,
): UnavailableResolution | null {
  if (input.claimedFingerprint === undefined || input.claimedFingerprint === fingerprint) {
    return null;
  }
  return {
    status: 'unavailable',
    code: 'SESSION_BINDING_MISMATCH',
    reason:
      `Claimed workspace fingerprint "${input.claimedFingerprint}" does not match ` +
      `the canonical fingerprint "${fingerprint}" of "${worktreeRoot}".`,
  };
}

function resolveSessionDirectory(fingerprint: string, sessionId: string): ProbeResult<string> {
  try {
    return { ok: true, value: sessionDir(fingerprint, sessionId) };
  } catch (err) {
    return {
      ok: false,
      unavailable: unavailable(
        err,
        `Cannot derive the session directory for session "${sessionId}"`,
      ),
    };
  }
}

function historicalEvidenceUnavailable(state: SessionState): UnavailableResolution | null {
  if (
    isTerminalPhase(state.phase) ||
    !(state.reviewAssurance?.invocations ?? []).some(isHistoricalReviewTransport)
  ) {
    return null;
  }
  return {
    status: 'unavailable',
    code: 'SESSION_STATE_INCOMPATIBLE',
    reason:
      'The active session holds historical review evidence (transport generation 5, V1 native Task). It remains verifiable after archiving but cannot be continued or bound; no migration to the current generation exists. Start a new session.',
  };
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
  const deadline = createSessionProbeDeadline(input.deadlineMs);
  const worktree = await probeWorktreeRoot(input, deadline);
  if (!worktree.ok) return worktree.unavailable;
  const worktreeRoot = worktree.value;

  const fingerprintResult = await probeFingerprint(worktreeRoot, deadline);
  if (!fingerprintResult.ok) return fingerprintResult.unavailable;
  const fingerprint = fingerprintResult.value;

  const mismatch = claimedFingerprintMismatch(input, fingerprint, worktreeRoot);
  if (mismatch) return mismatch;

  const sessionDirResult = resolveSessionDirectory(fingerprint, input.sessionId);
  if (!sessionDirResult.ok) return sessionDirResult.unavailable;
  const sessDir = sessionDirResult.value;

  const stateResult = await loadSessionState(sessDir);
  if (!stateResult.ok) return stateResult.unavailable;
  const state = stateResult.value;
  if (state === null) return { status: 'absent', sessDir, worktreeRoot, fingerprint };

  try {
    validateBinding(state, { worktreeRoot, sessionId: input.sessionId });
    validateFingerprintBinding(state, fingerprint);
  } catch (err) {
    return unavailable(err, 'Persisted session binding does not match the canonical workspace');
  }

  const historical = historicalEvidenceUnavailable(state);
  if (historical) return historical;

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
