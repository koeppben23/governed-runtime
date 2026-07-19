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

import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';

// State & Machine
import { SessionState } from '../../state/schema.js';
import { hashText } from '../../shared/hashing.js';
import type { EvalResult } from '../../machine/evaluate.js';
import { resolveNextAction } from '../../machine/next-action.js';
import { TERMINAL } from '../../machine/topology.js';

// Rail helpers
import type { RailResult, RailContext, AutoAdvanceOverflow } from '../../rails/types.js';
import { AUTO_ADVANCE_OVERFLOW_CODE } from '../../rails/auto-advance-overflow.js';

// Adapters
import { readState, writeStateAlreadyLocked } from '../../adapters/persistence.js';
import { acquireSessionWriteLock, withSessionWriteLock } from '../../adapters/persistence-lock.js';
import { createRailContext } from '../../adapters/context.js';

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
import { buildBlockedDiagnostics } from '../../diagnostics/index.js';
import { getAdapterLogger, getLogTraceFields } from '../../logging/adapter-logger.js';
import { PHASE_LABELS, buildProductNextAction } from '../../presentation/index.js';
import { getReviewLoopProgress } from '../review/review-loop-progress.js';

const lockedSessionDir = new AsyncLocalStorage<string>();

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
  abort: AbortSignal | undefined;
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

/** Format a RailResult for LLM consumption. Audit transitions in metadata channel. */
export function formatRailResult(result: RailResult): ToolResult {
  if (result.kind === 'blocked') {
    getAdapterLogger().warn('machine', 'tool_blocked', {
      code: result.code,
      ...(result.overflow ? { overflowLimit: result.overflow.limit } : {}),
      ...getLogTraceFields(),
    });
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
      // #428: surface structured overflow context so the plugin boundary can
      // detect and log the fail-closed overflow without parsing the message.
      ...(result.overflow ? { autoAdvanceOverflow: result.overflow } : {}),
    });
  }
  const nextAction = resolveNextAction(result.state.phase, result.state);
  const aborted = result.state.error?.code === 'ABORTED';
  const productNext = buildProductNextAction(
    nextAction,
    result.state.phase,
    aborted,
    result.state.archiveStatus ?? null,
  );
  const reviewDecision = result.state.reviewDecision;
  const { archiveStatus } = result.state;
  const reviewLoop = getReviewLoopProgress(result.state);
  const json = JSON.stringify({
    phase: result.state.phase,
    phaseLabel: PHASE_LABELS[result.state.phase],
    status: 'ok',
    next: formatEval(result.evalResult),
    nextAction,
    productNextAction: productNext,
    // Governance integrity: mark an aborted terminal session explicitly so it is
    // never presented as an indistinguishable clean completion. Distinct from the
    // blocked-result `error: true` convention (this is a successful tool call that
    // reports a terminated session). Omitted for clean states.
    ...(aborted ? { aborted: true } : {}),
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
    ...(reviewLoop ? { reviewLoop } : {}),
  });
  return { output: json, metadata: { transitions: result.transitions } };
}

/**
 * Format a blocked error using the reason registry.
 * Used for inline blocked returns in tool logic (outside rail calls).
 */
export function formatBlocked(
  code: string,
  vars?: Record<string, string>,
  extra?: Record<string, unknown>,
): string {
  getAdapterLogger().warn('machine', 'tool_blocked', { code, ...getLogTraceFields() });
  const info = defaultReasonRegistry.format(code, vars);
  const diagnostics = buildBlockedDiagnostics(info.code, vars);
  return JSON.stringify({
    error: true,
    code: info.code,
    message: info.reason,
    recovery: info.recovery,
    quickFix: info.quickFix,
    ...(diagnostics ? { diagnostics } : {}),
    ...(extra ?? {}),
  });
}

/**
 * Format an auto-advance overflow (#428) as a fail-closed blocked tool result.
 *
 * Used by boundary tools that call autoAdvance directly. MUST be returned
 * BEFORE any state persistence: an overflow carries no advanced state, so the
 * tool must stop completely rather than write a partially-advanced session.
 *
 * Emits a structured `autoAdvanceOverflow: { phase, limit }` field so the
 * plugin boundary can detect and log the overflow without message parsing.
 */
export function formatAutoAdvanceOverflow(overflow: AutoAdvanceOverflow): string {
  const info = defaultReasonRegistry.format(AUTO_ADVANCE_OVERFLOW_CODE, {
    phase: overflow.phase,
    limit: String(overflow.limit),
  });
  return JSON.stringify({
    error: true,
    code: info.code,
    message: info.reason,
    recovery: info.recovery,
    quickFix: info.quickFix,
    autoAdvanceOverflow: { phase: overflow.phase, limit: overflow.limit },
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
export async function writeStateWithArtifactsAlreadyLocked(
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
  const preComputedStateHash = hashText(serialized);

  await materializeEvidenceArtifacts(sessDir, nextState, preComputedStateHash);
  await writeStateAlreadyLocked(sessDir, nextState);
}

export async function writeStateWithArtifacts(
  sessDir: string,
  nextState: SessionState,
): Promise<void> {
  if (lockedSessionDir.getStore() === sessDir) {
    await writeStateWithArtifactsAlreadyLocked(sessDir, nextState);
    return;
  }

  // 3. Materialize artifacts and write state atomically under the session lock
  await withSessionWriteLock(sessDir, async () => {
    await lockedSessionDir.run(sessDir, () =>
      writeStateWithArtifactsAlreadyLocked(sessDir, nextState),
    );
  });
}

/** Context handed to a {@link withSessionWriteTransaction} callback. */
export interface SessionWriteTransaction {
  /**
   * Whether the session write lock contended with a live holder before it
   * could be acquired. `false` when acquired immediately (uncontended).
   *
   * Deterministic — derived from the lock acquisition path, not a timing
   * heuristic — so callers can faithfully report contention without noise.
   */
  readonly waited: boolean;
}

/**
 * Run a full read-modify-write transaction while holding the session write lock.
 *
 * Unlike {@link withMutableSessionTransaction}, this does NOT pre-read or
 * require existing state via requireStateForMutation (which throws NO_SESSION
 * when no state exists). The callback owns its entire read-modify-write and may
 * tolerate an absent session — this is the create-or-update path used by
 * hydrate, which bootstraps a brand-new session OR reloads an existing one.
 *
 * The session dir is registered in {@link lockedSessionDir} for the duration of
 * the callback, so any nested {@link writeStateWithArtifacts} takes the
 * already-locked path (no re-entrant lock acquisition, no deadlock).
 *
 * Fail-closed: if the lock cannot be acquired within the adapter timeout,
 * {@link acquireSessionWriteLock} throws PersistenceError(LOCK_TIMEOUT); the
 * caller is responsible for mapping that to an explicit BLOCKED result.
 */
export async function withSessionWriteTransaction<T>(
  sessDir: string,
  fn: (tx: SessionWriteTransaction) => Promise<T>,
): Promise<T> {
  const lock = await acquireSessionWriteLock(sessDir);
  try {
    return await lockedSessionDir.run(sessDir, () => fn({ waited: lock.waited }));
  } finally {
    await lock.release();
  }
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
export async function persistAndFormat(sessDir: string, result: RailResult): Promise<ToolResult> {
  if (result.kind === 'ok') {
    if (result.transitions.length > 0) {
      getAdapterLogger().info('machine', 'transitions_applied', {
        sessionId: result.state.binding.sessionId,
        stateId: result.state.id,
        path: result.transitions.map((t) => `${t.from}\u2192${t.to}`),
        count: result.transitions.length,
        ...getLogTraceFields(),
      });
    }
    await writeStateWithArtifacts(sessDir, result.state);
    logPersistedLifecycle(result);
  }
  return formatRailResult(result);
}

function logPersistedLifecycle(result: Extract<RailResult, { kind: 'ok' }>): void {
  if (result.transitions.length === 0) return;
  const sessionId = result.state.binding.sessionId;
  const phase = result.state.phase;
  const log = getAdapterLogger();

  if (isPersistedAbort(result)) {
    log.info('machine', 'session_aborted', {
      sessionId,
      phase,
      ...getLogTraceFields(),
    });
    return;
  }

  if (TERMINAL.has(phase)) {
    log.info('machine', 'session_completed', {
      sessionId,
      phase,
      ...getLogTraceFields(),
    });
  }
}

function isPersistedAbort(result: Extract<RailResult, { kind: 'ok' }>): boolean {
  return (
    result.state.error?.code === 'ABORTED' && result.transitions.some((t) => t.event === 'ABORT')
  );
}

/**
 * Append NextAction to a custom JSON response string.
 *
 * Use this when a tool builds custom JSON (not via formatRailResult)
 * but still needs the mandatory NextAction footer.
 *
 * Delegates to {@link enrichWithNextAction} for the actual logic —
 * this function is a thin JSON-parse/serialize wrapper for backwards
 * compatibility.
 *
 * @param jsonStr - The JSON string to augment (will be parsed, extended, re-serialized).
 * @param state - Current session state for NextAction resolution.
 * @returns JSON string with nextAction field + trailing footer line.
 */
export function appendNextAction(jsonStr: string, state: SessionState): string {
  return JSON.stringify(enrichWithNextAction(JSON.parse(jsonStr), state));
}

/** Fields appended by {@link enrichWithNextAction}. */
export interface NextActionFields {
  nextAction: ReturnType<typeof resolveNextAction>;
  phaseLabel: string;
  productNextAction: ReturnType<typeof buildProductNextAction>;
}

/**
 * Enrich an arbitrary value object with NextAction fields.
 *
 * This is the canonical implementation — {@link appendNextAction}
 * delegates to it for the JSON-based path. Callers that already work
 * with objects (instead of pre-serialized JSON strings) should use this
 * function directly to avoid unnecessary parse/serialize rounds.
 *
 * @param value - The object to enrich.
 * @param state - Current session state for NextAction resolution.
 * @returns The value augmented with nextAction, phaseLabel, and productNextAction.
 */
export function enrichWithNextAction<T extends Record<string, unknown>>(
  value: T,
  state: SessionState,
): T & NextActionFields {
  const nextAction = resolveNextAction(state.phase, state);
  const productNext = buildProductNextAction(
    nextAction,
    state.phase,
    state.error?.code === 'ABORTED',
    state.archiveStatus ?? null,
  );
  return {
    ...value,
    nextAction,
    phaseLabel: PHASE_LABELS[state.phase],
    productNextAction: productNext,
  };
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

export type MutableSession = Awaited<ReturnType<typeof withMutableSession>>;

export async function withMutableSessionTransaction<T>(
  context: {
    sessionID: string;
    worktree: string;
    directory: string;
  },
  fn: (session: MutableSession) => Promise<T>,
): Promise<T> {
  const { worktree, fingerprint, sessDir, wsDir } = await resolveWorkspacePaths(context);
  return withSessionWriteLock(sessDir, async () =>
    lockedSessionDir.run(sessDir, async () => {
      const state = await requireStateForMutation(sessDir);
      const policy = resolvePolicyFromState(state);
      const ctx = createPolicyContext(policy);
      return fn({ worktree, fingerprint, sessDir, wsDir, state, policy, ctx });
    }),
  );
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
