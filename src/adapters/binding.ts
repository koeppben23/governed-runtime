/**
 * @module binding
 * @description Resolves and validates the OpenCode <-> governance session binding.
 *
 * Maps OpenCode Custom Tool context to a governance binding:
 * - context.sessionID -> governance session identity
 * - context.worktree  -> git worktree root (state storage location)
 *
 * Binding model:
 * - One worktree = one governance session at a time
 *   (the .governance/ directory is per-worktree)
 * - Multiple OpenCode sessions can work on the same worktree over time
 *   (session continuation: new conversation, same project)
 * - The binding.sessionId in SessionState records the ORIGINAL session that
 *   created it -- it does NOT update on continuation
 *
 * Resolution strategy:
 * 1. context.worktree is preferred (already resolved by OpenCode, no subprocess)
 * 2. Fallback: resolve from context.directory via `git rev-parse --show-toplevel`
 * 3. Validate: resolved path must be a git repository
 *
 * Validation:
 * - Worktree must match (same project, same .governance/ directory)
 * - Session ID may differ (new OpenCode conversation = OK, same project)
 * - Path comparison is case-insensitive on Windows (NTFS is case-insensitive)
 *
 * @version v1
 */

import type { SessionState } from "../state/schema";
import { resolveRoot, isGitRepo } from "./git";
import * as path from "node:path";

// -- Error --------------------------------------------------------------------

/**
 * Typed binding error.
 * Codes:
 * - MISSING_SESSION_ID: OpenCode context has no session ID
 * - NO_WORKTREE: neither worktree nor directory available in context
 * - NOT_GIT_REPO: directory is not inside a git repository
 * - WORKTREE_MISMATCH: state was created for a different worktree
 */
export class BindingError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BindingError";
    this.code = code;
  }
}

// -- Types --------------------------------------------------------------------

/**
 * OpenCode Custom Tool context -- subset of fields relevant to governance.
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
 * Resolve a governance binding from OpenCode tool context.
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
export async function resolveBinding(
  ctx: ToolContext,
): Promise<ResolvedBinding> {
  // 1. Session ID is required
  if (!ctx.sessionId?.trim()) {
    throw new BindingError(
      "MISSING_SESSION_ID",
      "OpenCode session ID is required (context.sessionID). " +
        "This should never be empty in a Custom Tool call.",
    );
  }

  // 2. Prefer context.worktree (fast path)
  let worktreeRoot = ctx.worktree?.trim() || "";

  // 3. Fallback: resolve from directory
  if (!worktreeRoot) {
    if (!ctx.directory?.trim()) {
      throw new BindingError(
        "NO_WORKTREE",
        "Neither context.worktree nor context.directory is available. " +
          "Cannot determine governance session location.",
      );
    }

    const isRepo = await isGitRepo(ctx.directory);
    if (!isRepo) {
      throw new BindingError(
        "NOT_GIT_REPO",
        `Directory is not inside a git repository: ${ctx.directory}. ` +
          "Governance requires a git repository.",
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
 * - Worktree MUST match (same project = same .governance/ directory)
 * - Session ID MAY differ (new OpenCode session continuing same project is OK)
 *
 * Why allow different session IDs?
 *   A developer starts a governance session, closes their terminal, opens a new
 *   OpenCode session, and continues. The project (worktree) is the same, the
 *   governance state should persist. Only the OpenCode session ID changes.
 *
 * Why reject different worktrees?
 *   If the state's worktree doesn't match, the .governance/ directory is in the
 *   wrong place. This indicates a configuration error or state file corruption.
 *
 * @returns true if compatible.
 * @throws BindingError if worktree mismatch.
 */
export function validateBinding(
  state: SessionState,
  binding: ResolvedBinding,
): true {
  const stateWorktree = normalizePath(state.binding.worktree);
  const currentWorktree = normalizePath(binding.worktreeRoot);

  if (stateWorktree !== currentWorktree) {
    throw new BindingError(
      "WORKTREE_MISMATCH",
      `Session was created for worktree "${state.binding.worktree}" ` +
        `but current worktree is "${binding.worktreeRoot}". ` +
        `This state file belongs to a different project. ` +
        `Either switch to the correct worktree or start a new session with /hydrate.`,
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
 * Normalize a path for comparison.
 * - Replace backslashes with forward slashes
 * - Remove trailing separators
 * - Lowercase on Windows (NTFS is case-insensitive)
 */
function normalizePath(p: string): string {
  let normalized = path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");

  // Windows: case-insensitive comparison
  if (process.platform === "win32") {
    normalized = normalized.toLowerCase();
  }

  return normalized;
}
