import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
// State & Machine
import { SessionState, type PendingAuditOperation } from '../../state/schema.js';
import { hashText } from '../../shared/hashing.js';
import { resolveWorkflowDirective } from '../../machine/workflow-directive.js';
// Rail helpers
import type { RailContext, AutoAdvanceOverflow } from '../../rails/types.js';
import { AUTO_ADVANCE_OVERFLOW_CODE } from '../../rails/auto-advance-overflow.js';
// Adapters
import {
  PersistenceError,
  readState,
  writeStateAlreadyLocked,
} from '../../adapters/persistence.js';
import { prepareStateWithAuditOperations, type SemanticAuditIntent } from '../audit-outbox.js';
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
import { PHASE_LABELS } from '../../presentation/index.js';
import { IntegrationInvariantError } from '../errors.js';
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
  workspaceFingerprint?: string;
  abort: AbortSignal | undefined;
  metadata(input: { title?: string; metadata?: Record<string, unknown> }): void;
}

/**
 * The workspace/session subset that session resolution and rail execution
 * need. Host hooks (which have no message/agent context) can resume canonical
 * system work with this narrower context.
 */
export type WorkspaceToolContext = Pick<ToolContext, 'sessionID' | 'worktree' | 'directory'>;

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- host-supplied args have no static shape; each tool validates them with its runtime Zod schema
  execute(args: any, context: ToolContext): Promise<ToolResult>;
};

// ─── Formatting Helpers ───────────────────────────────────────────────────────

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
  workspaceFingerprint?: string;
}): Promise<{
  worktree: string;
  fingerprint: string;
  sessDir: string;
  wsDir: string;
}> {
  const worktree = getWorktree(context);
  const fingerprint =
    context.workspaceFingerprint ?? (await computeFingerprint(worktree)).fingerprint;
  const sessDir = resolveSessionDir(fingerprint, context.sessionID);
  const wsDir = resolveWorkspaceDir(fingerprint);
  return { worktree, fingerprint, sessDir, wsDir };
}

// ─── State Helpers ────────────────────────────────────────────────────────────

/** Read state with null-safety messaging. */
export async function requireState(sessDir: string): Promise<SessionState> {
  const state = await readState(sessDir);
  if (!state) {
    throw new IntegrationInvariantError(
      'NO_SESSION',
      'No FlowGuard session found. Run /hydrate first to bootstrap a session.',
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
 * Commit an already prepared state and materialize derived evidence artifacts.
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
 * The sourceStateHash is pre-computed from the serialized prepared state so that
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
 * - If the state rename fails: the old state remains and orphan artifacts may remain.
 * - If directory fsync fails after rename: WRITE_FAILED is surfaced, but the
 *   persisted outcome is uncertain; recovery must re-read state and its outbox.
 */
async function commitPreparedStateWithArtifactsAlreadyLocked(
  sessDir: string,
  preparedState: SessionState,
): Promise<SessionState> {
  // 1. Validate BEFORE any I/O — fail-closed
  const result = SessionState.safeParse(preparedState);
  if (!result.success) {
    throw new PersistenceError(
      'SCHEMA_VALIDATION_FAILED',
      `Refusing to persist invalid state: ${result.error.message}`,
    );
  }

  // Preparation (implementation base, ProofGraph, audit operations) has already
  // completed under the session lock. Nothing here may change the authority
  // state after the audit operation's postStateDigest was computed.
  const serialized = JSON.stringify(result.data, null, 2) + '\n';
  const preComputedStateHash = hashText(serialized);

  await materializeEvidenceArtifacts(sessDir, result.data, preComputedStateHash);
  await writeStateAlreadyLocked(sessDir, result.data);
  // Return the persisted state so callers render the prepared ProofGraph.
  return result.data;
}

export async function writeStateWithArtifacts(
  sessDir: string,
  nextState: SessionState,
): Promise<SessionState> {
  return writeStateWithArtifactsAndAuditOperations(sessDir, nextState);
}

export async function writeStateWithArtifactsAndAuditOperations(
  sessDir: string,
  nextState: SessionState,
  transitions?: ReadonlyArray<{ from: string; to: string; event: string; at: string }>,
  semanticIntents: readonly SemanticAuditIntent[] = [],
): Promise<SessionState> {
  const persist = (): Promise<SessionState> =>
    writeStateWithArtifactsAndAuditOperationsAlreadyLocked(
      sessDir,
      nextState,
      transitions,
      semanticIntents,
    );

  if (lockedSessionDir.getStore() === sessDir) {
    return persist();
  }

  return withSessionWriteLock(sessDir, async () => lockedSessionDir.run(sessDir, persist));
}

/**
 * Carry forward every audit operation of the current authority that the
 * caller's prepared state does not contain while preserving the persisted
 * operation order.
 *
 * A caller that held a snapshot from before an intervening writer committed an
 * operation would otherwise drop committed, possibly unreconciled evidence when
 * persisting its next state. The persisted authority list wins on id collision
 * (its status is the durable one). A new operation may be inserted only at one
 * unambiguous position between common neighbor IDs; conflicting placement fails
 * closed. Authority digests are unaffected: the outbox is excluded from
 * `computeStateDigest`.
 */
function withCarriedAuditOperations(previous: SessionState, next: SessionState): SessionState {
  const persisted = previous.pendingAuditOperations;
  if (persisted.length === 0) return next;

  const persistedById = new Map(persisted.map((operation) => [operation.operationId, operation]));
  assertPreparedOrderMatchesPersisted(next.pendingAuditOperations, persisted, persistedById);
  const insertions = collectPreparedInsertions(
    next.pendingAuditOperations,
    persisted,
    persistedById,
  );
  return { ...next, pendingAuditOperations: applyPreparedInsertions(persisted, insertions) };
}

function assertPreparedOrderMatchesPersisted(
  prepared: readonly PendingAuditOperation[],
  persisted: readonly PendingAuditOperation[],
  persistedById: ReadonlyMap<string, PendingAuditOperation>,
): void {
  const commonIds = prepared
    .map((operation) => operation.operationId)
    .filter((id) => persistedById.has(id));
  const persistedCommonIds = persisted
    .map((operation) => operation.operationId)
    .filter((id) => commonIds.includes(id));
  if (!sameOrder(commonIds, persistedCommonIds)) {
    throw new PersistenceError(
      'OUTBOX_ORDER_CONFLICT',
      'Refusing prepared state that reorders persisted pending audit operations',
    );
  }
}

function collectPreparedInsertions(
  prepared: readonly PendingAuditOperation[],
  persisted: readonly PendingAuditOperation[],
  persistedById: ReadonlyMap<string, PendingAuditOperation>,
): ReadonlyMap<string, PendingAuditOperation> {
  const persistedIndexById = new Map(
    persisted.map((operation, index) => [operation.operationId, index]),
  );
  const insertions = new Map<string, PendingAuditOperation>();
  for (let index = 0; index < prepared.length; index++) {
    const operation = prepared[index];
    if (operation === undefined) continue;
    if (persistedById.has(operation.operationId)) continue;
    const before = nearestPersistedId(prepared, index, -1, persistedById);
    const after = nearestPersistedId(prepared, index, 1, persistedById);
    if (before === undefined && after === undefined) {
      throw new PersistenceError(
        'OUTBOX_ORDER_CONFLICT',
        'Refusing prepared audit operation without persisted ordering neighbors',
      );
    }
    if (!areAdjacentAnchors(before, after, persisted, persistedIndexById)) {
      throw new PersistenceError(
        'OUTBOX_ORDER_CONFLICT',
        'Refusing prepared audit operation without an unambiguous persisted position',
      );
    }
    const anchor = `${before ?? ''}:${after ?? ''}`;
    if (insertions.has(anchor)) {
      throw new PersistenceError(
        'OUTBOX_ORDER_CONFLICT',
        'Refusing ambiguous prepared audit operations with identical ordering neighbors',
      );
    }
    insertions.set(anchor, operation);
  }
  return insertions;
}

function applyPreparedInsertions(
  persisted: readonly PendingAuditOperation[],
  insertions: ReadonlyMap<string, PendingAuditOperation>,
): PendingAuditOperation[] {
  const merged: PendingAuditOperation[] = [];
  const firstOperation = persisted[0];
  if (firstOperation === undefined) return merged;
  const firstInsertion = insertions.get(`:${firstOperation.operationId}`);
  if (firstInsertion !== undefined) merged.push(firstInsertion);
  for (let index = 0; index < persisted.length; index++) {
    const operation = persisted[index];
    if (operation === undefined) continue;
    merged.push(operation);
    const afterOperation = insertions.get(
      `${operation.operationId}:${persisted[index + 1]?.operationId ?? ''}`,
    );
    if (afterOperation !== undefined) merged.push(afterOperation);
  }
  return merged;
}

function areAdjacentAnchors(
  before: string | undefined,
  after: string | undefined,
  persisted: readonly PendingAuditOperation[],
  persistedIndexById: ReadonlyMap<string, number>,
): boolean {
  if (before === undefined) return after === persisted[0]?.operationId;
  if (after === undefined) return before === persisted.at(-1)?.operationId;
  const beforeIndex = persistedIndexById.get(before);
  const afterIndex = persistedIndexById.get(after);
  return beforeIndex !== undefined && afterIndex === beforeIndex + 1;
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function nearestPersistedId(
  operations: readonly PendingAuditOperation[],
  start: number,
  direction: -1 | 1,
  persistedById: ReadonlyMap<string, PendingAuditOperation>,
): string | undefined {
  for (let index = start + direction; index >= 0 && index < operations.length; index += direction) {
    const operation = operations[index];
    if (operation && persistedById.has(operation.operationId)) return operation.operationId;
  }
  return undefined;
}

export async function writeStateWithArtifactsAndAuditOperationsAlreadyLocked(
  sessDir: string,
  nextState: SessionState,
  transitions?: ReadonlyArray<{ from: string; to: string; event: string; at: string }>,
  semanticIntents: readonly SemanticAuditIntent[] = [],
): Promise<SessionState> {
  const previous = await readState(sessDir);
  const preparedNext =
    previous === null ? nextState : withCarriedAuditOperations(previous, nextState);
  const stateWithOperations = await prepareStateWithAuditOperations(
    previous,
    preparedNext,
    transitions,
    semanticIntents,
  );
  return commitPreparedStateWithArtifactsAlreadyLocked(sessDir, stateWithOperations);
}

export interface SessionWriteTransaction {
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
  throw new IntegrationInvariantError(
    'POLICY_SNAPSHOT_MISSING',
    'Session state is missing policySnapshot. This indicates data corruption — ' +
      'every hydrated session must have a frozen policy snapshot.',
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
 * Machine-readable NextAction routing fields appended by
 * {@link enrichWithWorkflowDirective}. These are NOT a rendered footer — user-facing
 * next-action text is owned by the presentation conclusion where a rendered
 * document exists.
 */
export interface WorkflowDirectiveFields {
  directive: ReturnType<typeof resolveWorkflowDirective>;
  phaseLabel: string;
}

/**
 * Enrich an arbitrary value object with a workflow directive.
 *
 * Callers serialize the enriched object only at their response boundary.
 *
 * @param value - The object to enrich.
 * @param state - Current session state for workflow-directive resolution.
 * @returns The value augmented with directive and phaseLabel.
 */
export function enrichWithWorkflowDirective<T extends Record<string, unknown>>(
  value: T,
  state: SessionState,
): T & WorkflowDirectiveFields {
  const directive = resolveWorkflowDirective(state);
  return {
    ...value,
    directive,
    phaseLabel: PHASE_LABELS[state.phase],
  };
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
