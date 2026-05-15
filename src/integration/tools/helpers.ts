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
import * as crypto from 'node:crypto';

// State & Machine
import { SessionState } from '../../state/schema.js';
import type { EvalResult } from '../../machine/evaluate.js';
import { resolveNextAction } from '../../machine/next-action.js';

// Rail helpers
import type { RailResult, RailContext } from '../../rails/types.js';

// Adapters
import {
  readState,
  withSessionWriteLock,
  writeStateAlreadyLocked,
} from '../../adapters/persistence.js';

// Workspace
import {
  computeFingerprint,
  materializeEvidenceArtifacts,
  sessionDir as resolveSessionDir,
  verifyEvidenceArtifacts,
  workspaceDir as resolveWorkspaceDir,
} from '../../adapters/workspace/index.js';

// Config
import { resolvePolicyFromSnapshot } from '../../config/policy.js';
import type { FlowGuardPolicy } from '../../config/policy.js';
import { defaultReasonRegistry } from '../../config/reasons.js';
import { createRailContext } from '../../adapters/context.js';
import { buildBlockedDiagnostics } from '../../diagnostics/index.js';
import { PHASE_LABELS, buildProductNextAction } from '../../presentation/index.js';

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
  metadata(input: { title?: string; metadata?: Record<string, unknown> }): void;
}

/**
 * Result type for FlowGuard tools.
 *
 * Matches the OpenCode SDK `ToolResult` union:
 * - `string`: plain text result (current default for all FlowGuard tools)
 * - `{ output, metadata? }`: structured result with optional metadata
 *
 * @see https://opencode.ai/docs/custom-tools
 */
export type ToolResult = string | { output: string; metadata?: Record<string, unknown> };

export type ToolDefinition = {
  description: string;
  args: Record<string, z.ZodType>;
  // args shape is defined at runtime by this.args via Zod validation.
  // any is required because OpenCode passes tool args as plain objects
  // and the concrete type depends on each tool's runtime Zod schema,
  // which cannot be known at the ToolDefinition level.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute(args: any, context: ToolContext): Promise<ToolResult>;
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
    const diagnostics = buildBlockedDiagnostics(result.code, {
      reason: result.reason,
    });
    return JSON.stringify({
      error: true,
      code: result.code,
      message: result.reason,
      recovery: result.recovery,
      quickFix: result.quickFix,
      ...(diagnostics ? { diagnostics } : {}),
    });
  }
  const nextAction = resolveNextAction(result.state.phase, result.state);
  const productNext = buildProductNextAction(nextAction, result.state.phase);
  const reviewDecision = result.state.reviewDecision;
  const { archiveStatus } = result.state;
  const json = JSON.stringify({
    phase: result.state.phase,
    phaseLabel: PHASE_LABELS[result.state.phase],
    status: 'ok',
    next: formatEval(result.evalResult),
    nextAction,
    productNextAction: productNext,
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
    ...(archiveStatus ? { archiveStatus } : {}),
    _audit: { transitions: result.transitions },
  });
  return json + `\nNext action: ${productNext.text}`;
}

/**
 * Format a blocked error using the reason registry.
 * Used for inline blocked returns in tool logic (outside rail calls).
 */
export function formatBlocked(code: string, vars?: Record<string, string>): string {
  const info = defaultReasonRegistry.format(code, vars);
  const diagnostics = buildBlockedDiagnostics(info.code, vars);
  return JSON.stringify({
    error: true,
    code: info.code,
    message: info.reason,
    recovery: info.recovery,
    quickFix: info.quickFix,
    ...(diagnostics ? { diagnostics } : {}),
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
 * Read state and enforce derived evidence integrity for mutating governance paths.
 * Use this for commands that can advance workflow state.
 */
export async function requireStateForMutation(sessDir: string): Promise<SessionState> {
  const state = await requireState(sessDir);
  await verifyEvidenceArtifacts(sessDir, state);
  return state;
}

/**
 * Persist state and materialize derived evidence artifacts.
 *
 * Ordering: artifacts-first, state-last.
 *
 * This prevents the EVIDENCE_ARTIFACT_MISSING corruption scenario:
 * if a crash occurs between state write and artifact materialization,
 * state references artifacts that don't exist on disk.
 *
 * With artifacts-first ordering:
 * - Crash after artifacts, before state → orphan artifact files (benign;
 *   verification only checks state→artifacts direction).
 * - Crash after state → both exist, consistent.
 *
 * The sourceStateHash is pre-computed from the serialized nextState so that
 * materializeEvidenceArtifacts does not need to read state from disk.
 *
 * The session write lock is acquired over both artifact materialization and
 * state write to prevent interleaved writes from corrupting the artifact-state
 * relationship.
 *
 * ASSERTION: materializeEvidenceArtifacts does NOT recursively acquire the
 * session-state lock. If it ever does, this will deadlock.
 *
 * Failure semantics:
 * - If validation fails: nothing written.
 * - If artifact materialization fails: no state change persisted.
 * - If state write fails after artifacts: orphan artifacts only (benign).
 */
export async function writeStateWithArtifacts(
  sessDir: string,
  nextState: SessionState,
): Promise<void> {
  // 1. Validate BEFORE any I/O — fail-closed
  const result = SessionState.safeParse(nextState);
  if (!result.success) {
    throw Object.assign(new Error(`Refusing to persist invalid state: ${result.error.message}`), {
      code: 'SCHEMA_VALIDATION_FAILED',
    });
  }

  // 2. Pre-compute serialized form and hash (identical to what writeState would produce)
  const serialized = JSON.stringify(result.data, null, 2) + '\n';
  const preComputedStateHash = crypto
    .createHash('sha256')
    .update(serialized, 'utf-8')
    .digest('hex');

  // 3. Materialize artifacts and write state atomically under the session lock
  await withSessionWriteLock(sessDir, async () => {
    await materializeEvidenceArtifacts(sessDir, nextState, preComputedStateHash);
    await writeStateAlreadyLocked(sessDir, nextState);
  });
}

/**
 * Resolve policy from session state's frozen snapshot.
 *
 * P2c: Accepts only non-null SessionState. All callers guard null before calling.
 * Fail-closed: if policySnapshot is missing (corrupt state), throws instead of
 * silently falling back to a reconstructed policy from a mode string.
 *
 * This is the helper/plugin fallback path. Hydrate owns its own
 * developer-friendly solo fallback via the P21 config chain.
 */
export function resolvePolicyFromState(state: SessionState): FlowGuardPolicy {
  if (state.policySnapshot) {
    return resolvePolicyFromSnapshot(state.policySnapshot);
  }
  // Fail-closed: a hydrated session must always have a policySnapshot.
  // If missing, this is a data integrity error — not a recoverable fallback.
  throw Object.assign(
    new Error(
      'Session state is missing policySnapshot. This indicates data corruption — ' +
        'every hydrated session must have a frozen policy snapshot.',
    ),
    { code: 'POLICY_SNAPSHOT_MISSING' },
  );
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
    await writeStateWithArtifacts(sessDir, result.state);
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
  const productNext = buildProductNextAction(nextAction, state.phase);
  const parsed = JSON.parse(jsonStr);
  parsed.nextAction = nextAction;
  parsed.phaseLabel = PHASE_LABELS[state.phase];
  parsed.productNextAction = productNext;
  return JSON.stringify(parsed) + `\nNext action: ${productNext.text}`;
}

// ─── Plan Parsing ─────────────────────────────────────────────────────────────

/** Extract markdown section headers from plan text. */
export function extractSections(body: string): string[] {
  return body
    .split('\n')
    .filter((line) => /^#{1,3}\s/.test(line))
    .map((line) => line.replace(/^#+\s*/, '').trim());
}

// ─── Session Bootstrap Wrappers ────────────────────────────────────────────────

/**
 * Bootstrap a mutable session context for tools that modify state.
 *
 * Eliminates the 5× repeated boilerplate:
 *   resolveWorkspacePaths → requireStateForMutation → resolvePolicyFromState → createPolicyContext
 *
 * Used by: ticket, decision, validate, review, abort_session.
 */
export async function withMutableSession(context: {
  sessionID: string;
  worktree: string;
  directory: string;
}) {
  const { worktree, fingerprint, sessDir, wsDir } = await resolveWorkspacePaths(context);
  const state = await requireStateForMutation(sessDir);
  const policy = resolvePolicyFromState(state);
  const ctx = createPolicyContext(policy);
  return { worktree, fingerprint, sessDir, wsDir, state, policy, ctx };
}

/**
 * Bootstrap a read-only session context for tools that only inspect state.
 *
 * Used by: status.
 */
export async function withReadOnlySession(context: {
  sessionID: string;
  worktree: string;
  directory: string;
}) {
  const { fingerprint, sessDir } = await resolveWorkspacePaths(context);
  const state = await readState(sessDir);

  if (!state) {
    return { fingerprint, sessDir, state: null, policy: null };
  }

  const policy = resolvePolicyFromState(state);
  return { fingerprint, sessDir, state, policy };
}
