/**
 * @module binding
 * @description Resolves and validates the OpenCode <-> FlowGuard session binding.
 *
 * Maps OpenCode Custom Tool context to a FlowGuard binding:
 * - context.sessionID -> FlowGuard session identity
 * - context.worktree  -> git worktree root (used for fingerprint computation)
 *
 * Binding model:
 * - One worktree = one workspace fingerprint
 *   (workspace data lives at ~/.config/opencode/workspaces/{fingerprint}/)
 * - Multiple OpenCode sessions can work on the same worktree over time
 *   (session continuation: new conversation, same project)
 * - The binding.hostSessionId in SessionState records the ORIGINAL session that
 *   created it -- it does NOT update on continuation
 *
 * Resolution strategy:
 * 1. context.worktree is preferred (already resolved by OpenCode, no subprocess)
 * 2. Fallback: resolve from context.directory via `git rev-parse --show-toplevel`
 * 3. Validate: resolved path must be a git repository
 *
 * Validation:
 * - Worktree must match (same project, same workspace fingerprint)
 * - Session ID may differ (new OpenCode conversation = OK, same project)
 * - Path comparison is case-insensitive on Windows (NTFS is case-insensitive)
 *
 * @version v1
 */

import type { SessionState } from '../state/schema.js';
import { GitError, resolveRoot, isGitRepo, type GitErrorCode } from './git.js';
import * as path from 'node:path';

// -- Error --------------------------------------------------------------------

/**
 * Typed binding error codes.
 * Compile-time validated — no arbitrary strings allowed.
 */
export type BindingErrorCode =
  | 'MISSING_SESSION_ID'
  | 'NO_WORKTREE'
  | 'NOT_GIT_REPO'
  | 'WORKTREE_MISMATCH'
  | 'SESSION_BINDING_MISMATCH';

/**
 * Binding errors (workspace ↔ git worktree resolution).
 * Codes:
 * - MISSING_SESSION_ID: context has no session identifier
 * - NO_WORKTREE: neither worktree nor directory available in context
 * - NOT_GIT_REPO: directory is not inside a git repository
 * - WORKTREE_MISMATCH: state was created for a different worktree
 * - SESSION_BINDING_MISMATCH: persisted fingerprint differs from the canonical
 *   fingerprint of the resolved worktree root
 */
export class BindingError extends Error {
  readonly code: BindingErrorCode;

  constructor(code: BindingErrorCode, message: string) {
    super(message);
    this.name = 'BindingError';
    this.code = code;
  }
}

// -- Types --------------------------------------------------------------------

/**
 * OpenCode Custom Tool context -- subset of fields relevant to FlowGuard.
 *
 * Full OpenCode tool context:
 *   { agent, sessionID, messageID, directory, worktree }
 *
 * We consume:
 * - sessionId  (from context.sessionID) -- identifies the OpenCode session
 * - worktree   (from context.worktree)  -- git worktree root, resolved by OpenCode
 * - directory   (from context.directory)  -- working directory, fallback for resolution
 *
 * The mapping from OpenCode context to ToolContext is done in the integration
 * layer (Layer 5). This type documents the contract.
 */
export interface ToolContext {
  /** OpenCode session ID (from context.sessionID). */
  readonly sessionId: string;
  /** Git worktree root (from context.worktree). Preferred source. */
  readonly worktree: string;
  /** Working directory (from context.directory). Fallback for worktree resolution. */
  readonly directory: string;
}

/**
 * Resolved and validated binding -- ready for use by rails and persistence.
 */
export interface ResolvedBinding {
  /** Absolute path to the git worktree root. OS-normalized. */
  readonly worktreeRoot: string;
  /** OpenCode session ID (pass-through from context). */
  readonly sessionId: string;
}

// -- Public API ---------------------------------------------------------------

/**
 * Resolve a FlowGuard binding from OpenCode tool context.
 *
 * Strategy:
 * 1. Validate session ID is present
 * 2. Use context.worktree if non-empty (fast path, no subprocess)
 * 3. Otherwise resolve from context.directory via git
 * 4. Normalize the resolved path
 *
 * @param ctx - OpenCode tool context (mapped from Custom Tool context object).
 * @returns Resolved binding with validated worktree root.
 * @throws BindingError if resolution fails.
 */
export async function resolveBinding(ctx: ToolContext): Promise<ResolvedBinding> {
  // 1. Session ID is required
  if (!ctx.sessionId?.trim()) {
    throw new BindingError(
      'MISSING_SESSION_ID',
      'OpenCode session ID is required (context.sessionID). ' +
        'This should never be empty in a Custom Tool call.',
    );
  }

  // 2. Prefer context.worktree (fast path)
  let worktreeRoot = ctx.worktree?.trim() || '';

  // 3. Fallback: resolve from directory
  if (!worktreeRoot) {
    if (!ctx.directory?.trim()) {
      throw new BindingError(
        'NO_WORKTREE',
        'Neither context.worktree nor context.directory is available. ' +
          'Cannot determine FlowGuard session location.',
      );
    }

    const isRepo = await isGitRepo(ctx.directory);
    if (!isRepo) {
      throw new BindingError(
        'NOT_GIT_REPO',
        `Directory is not inside a git repository: ${ctx.directory}. ` +
          'FlowGuard requires a git repository.',
      );
    }

    worktreeRoot = await resolveRoot(ctx.directory);
  }

  // 4. Normalize (resolve symlinks, normalize separators)
  worktreeRoot = path.resolve(worktreeRoot);

  return {
    worktreeRoot,
    sessionId: ctx.sessionId,
  };
}

/**
 * Validate that an existing session state is compatible with the current binding.
 *
 * Rules:
 * - Worktree MUST match (same project = same workspace fingerprint)
 * - Session ID MAY differ (new OpenCode session continuing same project is OK)
 *
 * Why allow different session IDs?
 *   A developer starts a FlowGuard session, closes their terminal, opens a new
 *   OpenCode session, and continues. The project (worktree) is the same, the
 *   FlowGuard state should persist. Only the OpenCode session ID changes.
 *
 * Why reject different worktrees?
 *   If the state's worktree doesn't match, the workspace fingerprint resolves
 *   differently. This indicates a configuration error or state file corruption.
 *
 * @returns true if compatible.
 * @throws BindingError if worktree mismatch.
 */
export function validateBinding(state: SessionState, binding: ResolvedBinding): true {
  const stateWorktree = normalizeBindingPath(state.binding.worktree);
  const currentWorktree = normalizeBindingPath(binding.worktreeRoot);

  if (stateWorktree !== currentWorktree) {
    throw new BindingError(
      'WORKTREE_MISMATCH',
      `Session was created for worktree "${state.binding.worktree}" ` +
        `but current worktree is "${binding.worktreeRoot}". ` +
        `This state file belongs to a different project. ` +
        `Either switch to the correct worktree or start a new session with /hydrate.`,
    );
  }

  return true;
}

/**
 * Outcome of validating a payload working directory against an existing binding.
 */
export type CwdBindingValidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: BindingErrorCode | GitErrorCode;
      readonly reason: string;
    };

/**
 * Validate that a payload working directory belongs to the session's bound worktree.
 *
 * The comparison is git-resolved worktree-root equality: a normalized equal path
 * is accepted directly; any other directory must resolve via `git rev-parse
 * --show-toplevel` to the same worktree root. Git resolution failures keep their
 * typed code (`NOT_GIT_REPO`, `GIT_NOT_FOUND`, `GIT_TIMEOUT`,
 * `GIT_COMMAND_FAILED`) instead of collapsing into a generic mismatch.
 *
 * The resolved session ID is deliberately not compared: binding.ts documents
 * that a new host session may continue the same worktree.
 *
 * @param state - The session state whose binding is authoritative.
 * @param cwd - Payload working directory (untrusted hook input).
 * @returns Validation outcome; every failure mode is fail-closed at the caller.
 */
export async function validateCwdAgainstBinding(
  state: SessionState,
  cwd: string,
): Promise<CwdBindingValidation> {
  if (normalizeBindingPath(cwd) === normalizeBindingPath(state.binding.worktree)) {
    return { ok: true };
  }

  let worktreeRoot: string;
  try {
    worktreeRoot = await resolveRoot(cwd);
  } catch (err) {
    if (err instanceof GitError) return { ok: false, code: err.code, reason: err.message };
    throw err;
  }

  try {
    validateBinding(state, { worktreeRoot, sessionId: state.binding.hostSessionId });
    return { ok: true };
  } catch (err) {
    if (err instanceof BindingError) return { ok: false, code: err.code, reason: err.message };
    throw err;
  }
}

/**
 * Validate that the persisted workspace fingerprint matches the fingerprint
 * computed from the canonical worktree root.
 *
 * Same-root fingerprint drift indicates a corrupted or foreign state file that
 * happens to live under the canonical session directory; it must never be
 * trusted for state or audit writes.
 *
 * @returns true if compatible.
 * @throws BindingError if the persisted fingerprint differs.
 */
export function validateFingerprintBinding(state: SessionState, fingerprint: string): true {
  if (state.binding.fingerprint !== fingerprint) {
    throw new BindingError(
      'SESSION_BINDING_MISMATCH',
      `Session binding fingerprint "${state.binding.fingerprint}" does not match ` +
        `the canonical workspace fingerprint "${fingerprint}". ` +
        `The persisted state does not belong to this workspace.`,
    );
  }

  return true;
}

/**
 * Create a ToolContext from raw OpenCode Custom Tool context.
 *
 * This is the mapping function used in the integration layer.
 * It normalizes the OpenCode context field names to our internal convention.
 *
 * @param openCodeCtx - Raw context object from OpenCode's tool() callback.
 */
export function fromOpenCodeContext(openCodeCtx: {
  sessionID: string;
  worktree: string;
  directory: string;
}): ToolContext {
  return {
    sessionId: openCodeCtx.sessionID,
    worktree: openCodeCtx.worktree,
    directory: openCodeCtx.directory,
  };
}

// -- Internals ----------------------------------------------------------------

/**
 * Normalize a path for binding comparison.
 * - Replace backslashes with forward slashes
 * - Remove trailing separators
 * - Lowercase on Windows (NTFS is case-insensitive)
 *
 * Exported for read-only worktree attribution (workspace store scans) so the
 * comparison stays one authority; it is not a persistence or validation API.
 */
export function normalizeBindingPath(p: string): string {
  let normalized = path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');

  // Windows: case-insensitive comparison
  if (process.platform === 'win32') {
    normalized = normalized.toLowerCase();
  }

  return normalized;
}
