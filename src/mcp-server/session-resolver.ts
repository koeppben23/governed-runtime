/**
 * @module mcp-server/session-resolver
 * @description Resolves the FlowGuard session context (working directory, worktree,
 * fingerprint, session directory) for MCP tool calls.
 *
 * Resolution order (fail-closed — throws if none resolves):
 * 1. FLOWGUARD_SESSION_DIR env var (explicit session override)
 * 2. FLOWGUARD_PROJECT_DIR env var (host-advertised project dir, e.g. Claude
 *    Code's CLAUDE_PROJECT_DIR)
 * 3. MCP roots (host-advertised working directories via roots/list)
 * 4. No source → throw SESSION_UNRESOLVABLE
 *
 * There is deliberately NO process.cwd() fallback: a guessed working directory
 * is not a host-advertised input and would silently bind the session to the
 * wrong project. When no explicit source is present, resolution MUST fail
 * closed so the boundary can surface a governance denial (non-interactive
 * runtime rule).
 *
 * This module is the single authority for MCP project-/session-dir resolution.
 * It delegates to existing adapters/persistence infrastructure for fingerprint
 * computation and session directory resolution.
 *
 * @see https://github.com/koeppben23/governed-runtime/issues/243
 * @see https://github.com/koeppben23/governed-runtime/issues/422
 */

import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Env var: explicit session directory override (testing, CI, session-bound calls). */
const ENV_SESSION_DIR = 'FLOWGUARD_SESSION_DIR';
/** Env var: host-advertised project directory (e.g. Claude Code's CLAUDE_PROJECT_DIR). */
const ENV_PROJECT_DIR = 'FLOWGUARD_PROJECT_DIR';
/** Governance denial code emitted when no session source can be resolved. */
export const SESSION_UNRESOLVABLE_CODE = 'SESSION_UNRESOLVABLE';

/** Trusted fail-closed error produced only by this resolver boundary. */
export class McpSessionResolutionError extends Error {
  readonly code = SESSION_UNRESOLVABLE_CODE;

  constructor() {
    super(
      `[${SESSION_UNRESOLVABLE_CODE}] No session source: set ${ENV_SESSION_DIR} or ${ENV_PROJECT_DIR}, or advertise MCP roots.`,
    );
    this.name = 'McpSessionResolutionError';
  }
}

/**
 * Resolved session context for an MCP tool call.
 * Contains all paths needed by ToolContext.
 */
export interface McpSessionContext {
  /** Stable FlowGuard session identifier for this MCP server/transport session. */
  readonly sessionId: string;
  /** The project working directory (worktree root). */
  readonly directory: string;
  /** The worktree path (same as directory for most setups). */
  readonly worktree: string;
}

/** Build a session context that binds both directory and worktree to one dir. */
function contextFor(sessionId: string, dir: string): McpSessionContext {
  const resolved = path.resolve(dir);
  return { sessionId, directory: resolved, worktree: resolved };
}

/**
 * Resolve session context from available sources.
 *
 * @param roots - MCP roots advertised by the host (from roots/list capability)
 * @param sessionId - Stable session identifier for this MCP transport session
 * @returns Resolved session context
 * @throws Error (with `code === 'SESSION_UNRESOLVABLE'`) when no env source and
 *   no roots are available — resolution fails closed rather than guessing cwd.
 */
export function resolveSessionContext(
  roots?: readonly string[],
  sessionId = `mcp-${randomUUID()}`,
): McpSessionContext {
  // Priority 1: Explicit session-dir override.
  const sessionDir = process.env[ENV_SESSION_DIR];
  if (sessionDir && sessionDir.length > 0) {
    return contextFor(sessionId, sessionDir);
  }

  // Priority 2: Host-advertised project dir (wires the FLOWGUARD_PROJECT_DIR
  // contract emitted by the Claude Code MCP template). Host-advertised, not a
  // cwd guess.
  const projectDir = process.env[ENV_PROJECT_DIR];
  if (projectDir && projectDir.length > 0) {
    return contextFor(sessionId, projectDir);
  }

  // Priority 3: MCP roots (first root is the primary working directory).
  if (roots && roots.length > 0) {
    return contextFor(sessionId, roots[0]!);
  }

  // Priority 4: Fail closed — no host-advertised working directory available.
  throw new McpSessionResolutionError();
}
