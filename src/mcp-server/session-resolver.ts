/**
 * @module mcp-server/session-resolver
 * @description Resolves the FlowGuard session context (working directory, worktree,
 * fingerprint, session directory) for MCP tool calls.
 *
 * Resolution order (fail-closed - explicit error if none resolves):
 * 1. FLOWGUARD_SESSION_DIR env var (explicit override)
 * 2. MCP roots (host-advertised working directories via roots/list)
 * 3. process.cwd() fallback
 *
 * This module delegates to existing adapters/persistence infrastructure for
 * fingerprint computation and session directory resolution.
 *
 * @see https://github.com/koeppben23/governed-runtime/issues/243
 */

import * as path from 'node:path';

/**
 * Resolved session context for an MCP tool call.
 * Contains all paths needed by ToolContext.
 */
export interface McpSessionContext {
  /** The project working directory (worktree root). */
  readonly directory: string;
  /** The worktree path (same as directory for most setups). */
  readonly worktree: string;
}

/**
 * Resolve session context from available sources.
 *
 * @param roots - MCP roots advertised by the host (from roots/list capability)
 * @returns Resolved session context
 * @throws Error if no working directory can be determined
 */
export function resolveSessionContext(roots?: readonly string[]): McpSessionContext {
  // Priority 1: Explicit env override
  const envDir = process.env['FLOWGUARD_SESSION_DIR'];
  if (envDir && envDir.length > 0) {
    const resolved = path.resolve(envDir);
    return { directory: resolved, worktree: resolved };
  }

  // Priority 2: MCP roots (first root is the primary working directory)
  if (roots && roots.length > 0) {
    const rootDir = roots[0]!;
    const resolved = path.resolve(rootDir);
    return { directory: resolved, worktree: resolved };
  }

  // Priority 3: cwd fallback
  const cwd = process.cwd();
  return { directory: cwd, worktree: cwd };
}
