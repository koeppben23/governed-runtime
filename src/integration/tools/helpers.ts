/**
 * @module integration/tools/helpers
 * @description Shared helpers for FlowGuard tool definitions.
 *
 * Contains:
 * - ToolContext / ToolDefinition interfaces (OpenCode contract)
 * - Formatting helpers (formatEval, formatRailResult, formatBlocked, formatError)
 * - Workspace resolution (getWorktree, resolveWorkspacePaths)
 * - State helpers (requireState, resolvePolicyFromState, createPolicyContext)
 * - Persistence helper (persistAndFormat)
 * - Plan parsing (extractSections)
 *
 * @version v3
 */

import { z } from 'zod';

// State & Machine
import type { SessionState } from '../../state/schema';
import type { EvalResult } from '../../machine/evaluate';
import { resolveNextAction } from '../../machine/next-action';
import type { NextAction } from '../../machine/next-action';

// Rail helpers
import type { RailResult, RailContext } from '../../rails/types';

// Adapters
import { readState, writeState } from '../../adapters/persistence';

// Workspace
import {
  computeFingerprint,
  sessionDir as resolveSessionDir,
  workspaceDir as resolveWorkspaceDir,
} from '../../adapters/workspace';

// Config
import { policyFromSnapshot, resolvePolicy } from '../../config/policy';
import type { FlowGuardPolicy } from '../../config/policy';
import { defaultReasonRegistry } from '../../config/reasons';
import { createRailContext } from '../../adapters/context';

// ─── Interfaces ───────────────────────────────────────────────────────────────

/**
 * Tool definition shape expected by OpenCode.
 *
 * OpenCode accepts plain objects with { description, args, execute }.
 * The `tool()` helper from @opencode-ai/plugin is a passthrough (identity function)
 * that only provides TypeScript type safety — it adds no runtime behavior.
 *
 * By defining ToolDefinition ourselves and exporting plain objects, we eliminate
 * the runtime dependency on @opencode-ai/plugin. This is critical because:
 * - The thin wrappers in .opencode/ use relative imports back into src/
 * - .opencode/ resolves bare specifiers from .opencode/node_modules/
 * - src/ resolves bare specifiers from the project root node_modules/
 * - A freshly-cloned repo may not have root node_modules/ (no npm install yet)
 * - OpenCode's bun install only runs on .opencode/package.json, not the root
 *
 * The @opencode-ai/plugin docs explicitly support plain object exports:
 * "You can also import Zod directly and return a plain object"
 */
export interface ToolContext {
  sessionID: string;
  messageID: string;
  agent: string;
  directory: string;
  worktree: string;
  abort: AbortSignal;
  /** Optional trusted host assertion payload (OIDC-first identity path). */
  identityAssertion?: unknown;
  /** Optional fallback host assertion aliases for compatibility. */
  identity?: unknown;
  hostContext?: unknown;
  metadata(input: { title?: string; metadata?: Record<string, unknown> }): void;
}

export type ToolDefinition = {
  description: string;
  args: Record<string, z.ZodTypeAny>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute(args: any, context: ToolContext): Promise<string>;
};

// ─── Formatting Helpers ───────────────────────────────────────────────────────

/** Format an EvalResult into a human-readable next-action string. */
export function formatEval(ev: EvalResult): string {
  switch (ev.kind) {
    case 'transition':
      return `Auto-advanced to ${ev.target} via ${ev.event}.`;
    case 'waiting':
      return ev.reason;
    case 'terminal':
      return 'Workflow complete. Session is terminal.';
    case 'pending':
      return `Phase ${ev.phase} needs more work.`;
  }
}

/** Format a RailResult for LLM consumption. Includes _audit for the audit plugin. */
export function formatRailResult(result: RailResult): string {
  if (result.kind === 'blocked') {
    return JSON.stringify({
      error: true,
      code: result.code,
      message: result.reason,
      recovery: result.recovery,
      quickFix: result.quickFix,
    });
  }
  const nextAction = resolveNextAction(result.state.phase, result.state);
  const reviewDecision = result.state.reviewDecision;
  const json = JSON.stringify({
    phase: result.state.phase,
    status: 'ok',
    next: formatEval(result.evalResult),
    nextAction,
    ...(reviewDecision
      ? {
          reviewDecision: {
            verdict: reviewDecision.verdict,
            rationale: reviewDecision.rationale,
            decidedBy: reviewDecision.decidedBy,
            decidedAt: reviewDecision.decidedAt,
          },
        }
      : {}),
    _audit: { transitions: result.transitions },
  });
  return json + `\nNext action: ${nextAction.text}`;
}

/**
 * Format a blocked error using the reason registry.
 * Used for inline blocked returns in tool logic (outside rail calls).
 */
export function formatBlocked(code: string, vars?: Record<string, string>): string {
  const info = defaultReasonRegistry.format(code, vars);
  return JSON.stringify({
    error: true,
    code: info.code,
    message: info.reason,
    recovery: info.recovery,
    quickFix: info.quickFix,
  });
}

/** Wrap any thrown error into a structured JSON string via the registry. */
export function formatError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const code =
    err instanceof Error && 'code' in err
      ? String((err as { code: unknown }).code)
      : 'INTERNAL_ERROR';
  return formatBlocked(code, { message });
}

// ─── Workspace Helpers ────────────────────────────────────────────────────────

/** Extract worktree from OpenCode tool context. */
export function getWorktree(context: {
  sessionID: string;
  worktree: string;
  directory: string;
}): string {
  return context.worktree || context.directory;
}

/**
 * Resolve workspace paths from tool context.
 * Returns fingerprint, sessionDir, and workspaceDir.
 * This is the workspace-aware equivalent of getWorktree + readState.
 */
export async function resolveWorkspacePaths(context: {
  sessionID: string;
  worktree: string;
  directory: string;
}): Promise<{
  worktree: string;
  fingerprint: string;
  sessDir: string;
  wsDir: string;
}> {
  const worktree = getWorktree(context);
  const fpResult = await computeFingerprint(worktree);
  const sessDir = resolveSessionDir(fpResult.fingerprint, context.sessionID);
  const wsDir = resolveWorkspaceDir(fpResult.fingerprint);
  return { worktree, fingerprint: fpResult.fingerprint, sessDir, wsDir };
}

// ─── State Helpers ────────────────────────────────────────────────────────────

/** Read state with null-safety messaging. */
export async function requireState(sessDir: string): Promise<SessionState> {
  const state = await readState(sessDir);
  if (!state) {
    throw Object.assign(
      new Error('No FlowGuard session found. Run /hydrate first to bootstrap a session.'),
      { code: 'NO_SESSION' },
    );
  }
  return state;
}

/**
 * Resolve policy from session state (existing session)
 * or default to SOLO_POLICY (no session yet).
 */
export function resolvePolicyFromState(state: SessionState | null): FlowGuardPolicy {
  if (state?.policySnapshot) {
    return policyFromSnapshot(state.policySnapshot);
  }
  return resolvePolicy();
}

/**
 * Create a policy-aware RailContext.
 * Merges the production context with the resolved policy.
 */
export function createPolicyContext(policy: FlowGuardPolicy): RailContext {
  return { ...createRailContext(), policy };
}

/**
 * Persist a RailResult if it's an "ok" result. Returns the formatted JSON.
 * Rails don't persist — the caller (this tool layer) does it atomically.
 */
export async function persistAndFormat(sessDir: string, result: RailResult): Promise<string> {
  if (result.kind === 'ok') {
    await writeState(sessDir, result.state);
  }
  return formatRailResult(result);
}

/**
 * Append NextAction to a custom JSON response string.
 *
 * Use this when a tool builds custom JSON (not via formatRailResult)
 * but still needs the mandatory NextAction footer.
 *
 * @param jsonStr - The JSON string to augment (will be parsed, extended, re-serialized).
 * @param state - Current session state for NextAction resolution.
 * @returns JSON string with nextAction field + trailing footer line.
 */
export function appendNextAction(jsonStr: string, state: SessionState): string {
  const nextAction = resolveNextAction(state.phase, state);
  const parsed = JSON.parse(jsonStr);
  parsed.nextAction = nextAction;
  return JSON.stringify(parsed) + `\nNext action: ${nextAction.text}`;
}

// ─── Plan Parsing ─────────────────────────────────────────────────────────────

/** Extract markdown section headers from plan text. */
export function extractSections(body: string): string[] {
  return body
    .split('\n')
    .filter((line) => /^#{1,3}\s/.test(line))
    .map((line) => line.replace(/^#+\s*/, '').trim());
}
