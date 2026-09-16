/**
 * @module integration/tools/auto-validation
 * @description Automatic validation execution on entry to a validation phase.
 *
 * The canonical workflow runs the active verification checks without a
 * user-typed `/check` step:
 * - after a human approval enters VALIDATION (PLAN_REVIEW → VALIDATION), and
 * - after `/implement` records evidence and enters IMPL_VALIDATION.
 *
 * Both phases are `system_work` states whose exit is normally driven by
 * explicit `/run_check` calls. This module closes that gap: it executes every
 * active check in order through the production run-check path (candidate
 * resolution, execution-subject attestation, evidence persistence,
 * phase-aware auto-advance), so the phase exits on the same evidence the
 * explicit surface would have produced. The explicit `/run_check`
 * compatibility surface remains available and unchanged.
 *
 * Durability: entering a validation phase atomically records
 * `pendingSystemWork` in the same transition write (`applyTransition`). If the
 * process dies before or during the automatic run, `resumePendingSystemWork`
 * re-runs the checks on the next runtime contact and clears the marker once
 * the attempt completed. An unreadable session is a typed fail-closed
 * `SYSTEM_WORK_STATE_UNREADABLE` result, never a silent "do not run".
 *
 * Reentrancy: the runner is guarded per session, never process-globally. Two
 * sessions may validate concurrently; a second re-entrant call for the SAME
 * session is a no-op returning `null`.
 *
 * @version v2
 */

import type { Phase } from '../../state/schema.js';
import type { SystemWorkOperation } from '../../state/system-work.js';
import type { ToolResult, WorkspaceToolContext } from './helpers.js';
import {
  formatBlocked,
  withMutableSessionTransaction,
  withReadOnlySession,
  writeStateWithArtifacts,
} from './helpers.js';
import { PersistenceError } from '../../adapters/lock-retry.js';
import { executeRunCheckPhased } from './run-check-tool.js';
import { formatError } from './error-format.js';
import { getAdapterLogger, getLogTraceFields } from '../../logging/adapter-logger.js';
import type { VerificationCandidateKind } from '../../state/discovery-schemas.js';

type ValidationPhase = 'VALIDATION' | 'IMPL_VALIDATION';

/**
 * Sessions with an in-flight automatic validation. Session-scoped (not a
 * process-global boolean): validation is canonical `system_work`, so one
 * session validating must never suppress another session's automatic run.
 */
const activeValidationSessions = new Set<string>();

function responseText(result: ToolResult): string {
  return typeof result === 'string' ? result : result.output;
}

function isValidationPhase(phase: Phase): phase is ValidationPhase {
  return phase === 'VALIDATION' || phase === 'IMPL_VALIDATION';
}

/**
 * A check response is a fail-closed stop signal when its JSON payload reports
 * `error === true`. Unparseable payloads are treated the same way: the runner
 * must not keep executing checks against an unexpected tool response.
 *
 * Hook sites also use this to skip automatic validation when the primary call
 * was blocked without entering the phase (e.g. a rejected `/plan` at an
 * existing VALIDATION) — only a call that actually landed in a validation
 * phase may trigger the runner.
 */
export function responseReportsError(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as unknown;
    return (
      parsed !== null &&
      typeof parsed === 'object' &&
      (parsed as { error?: unknown }).error === true
    );
  } catch {
    return true;
  }
}

interface SessionRead {
  readonly phase: Phase;
  readonly activeChecks: readonly string[];
  readonly pendingSystemWork: SystemWorkOperation | null;
}

type ReadOutcome =
  | { readonly kind: 'ok'; readonly session: SessionRead }
  | { readonly kind: 'none' }
  | { readonly kind: 'unreadable'; readonly reason: string };

/**
 * Read the session, distinguishing "no session" from "unreadable".
 *
 * An unreadable/contract-incompatible session in a system-work path must fail
 * closed with a typed result; swallowing the error into `null` would leave the
 * session silently stuck in a `system_work` phase with no commands.
 */
async function readSession(context: WorkspaceToolContext): Promise<ReadOutcome> {
  try {
    const { state } = await withReadOnlySession(context);
    if (!state) return { kind: 'none' };
    return {
      kind: 'ok',
      session: {
        phase: state.phase,
        activeChecks: [...state.activeChecks],
        pendingSystemWork: state.pendingSystemWork,
      },
    };
  } catch (err) {
    const reason =
      err instanceof PersistenceError
        ? `${err.code}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    return { kind: 'unreadable', reason };
  }
}

function unreadableResponse(outcome: Extract<ReadOutcome, { kind: 'unreadable' }>): string {
  return formatBlocked('SYSTEM_WORK_STATE_UNREADABLE', { reason: outcome.reason });
}

/**
 * Execute all active checks for the current validation phase.
 *
 * Additive to the primary mutation that entered the phase: callers return the
 * primary tool output when this runner returns `null`, and the runner's
 * response when it returns a string. The phase state, evidence, and audit trail
 * are all persisted by the run-check path, not here.
 */
export async function runActiveChecksAutomatically(
  context: WorkspaceToolContext,
): Promise<string | null> {
  const sessionKey = context.sessionID;
  if (activeValidationSessions.has(sessionKey)) return null;
  activeValidationSessions.add(sessionKey);
  try {
    const outcome = await readSession(context);
    if (outcome.kind === 'unreadable') return unreadableResponse(outcome);
    if (outcome.kind === 'none') return null;
    const { phase, activeChecks } = outcome.session;
    if (!isValidationPhase(phase)) return null;
    if (activeChecks.length === 0) return null;

    getAdapterLogger().info('tool', 'auto_validation', {
      sessionId: context.sessionID,
      phase,
      checks: activeChecks.join(','),
      ...getLogTraceFields(),
    });

    let lastResponse: string | null = null;
    for (const kind of activeChecks) {
      const text = await executeCheckResponse(kind as VerificationCandidateKind, context);
      lastResponse = text;
      if (responseReportsError(text)) return lastResponse;
      const fresh = await readSession(context);
      if (fresh.kind !== 'ok' || fresh.session.phase !== phase) return lastResponse;
    }
    return lastResponse;
  } finally {
    activeValidationSessions.delete(sessionKey);
    // The pending marker is consumed ONLY when the run leaves validation:
    // success (VALIDATION → IMPLEMENTATION) and a genuine negative result
    // (VALIDATION → PLAN, IMPL_VALIDATION → IMPLEMENTATION) both transition,
    // and `applyTransition` clears it atomically. A technical outcome that
    // keeps the phase in validation (execution error, lock/subject/integrity
    // problem, unexpected response) MUST leave the marker pending so the next
    // runtime contact retries instead of stranding a `system_work` phase with
    // no commands.
  }
}

/**
 * Typed outcome of a system-work resume attempt. Callers must consume the
 * result instead of discarding it:
 * - `none`          — no pending work (or the marker was already claimed).
 * - `completed`     — the run left the validation phase.
 * - `still_pending` — the run hit a technical outcome; the phase and the
 *                     pending marker remain for a later retry.
 * - `blocked`       — the session state is unreadable; fail closed.
 */
export type SystemWorkResumeOutcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'completed'; readonly phase: Phase; readonly response: string }
  | { readonly kind: 'still_pending'; readonly phase: Phase; readonly response: string }
  | { readonly kind: 'blocked'; readonly code: string; readonly response: string };

/**
 * In-flight resume attempts per session. The claim exists only for the
 * DURATION of an attempt (concurrent lifecycle events dedupe); it is released
 * when the attempt finishes, so a later lifecycle opportunity can retry a
 * `still_pending` operation after its backoff window.
 */
const inFlightSystemWorkResumes = new Set<string>();

/** Backoff before the next automatic retry of the same pending operation. */
const SYSTEM_WORK_RETRY_BASE_MS = 5_000;
const SYSTEM_WORK_RETRY_MAX_MS = 60_000;

function retryDelayMs(attempt: number): number {
  return Math.min(
    SYSTEM_WORK_RETRY_BASE_MS * 2 ** Math.max(attempt - 1, 0),
    SYSTEM_WORK_RETRY_MAX_MS,
  );
}

function isBackoffActive(retryAfter: string | null, nowMs: number): boolean {
  if (retryAfter === null) return false;
  const at = Date.parse(retryAfter);
  return Number.isFinite(at) && at > nowMs;
}

/**
 * Resume a pending system-work operation.
 *
 * Triggered by the host session lifecycle (session becomes idle/active), never
 * by a user workflow command: `system_work` phases have no commands, so the
 * runtime owns the continuation. A marker whose phase already left validation
 * is stale and is cleared. A technical outcome keeps the operation pending and
 * records attempt/backoff so the next lifecycle opportunity retries without a
 * tight loop; the in-memory claim is released when the attempt ends.
 */
type PendingOperationDecision =
  | { readonly kind: 'none' }
  | { readonly kind: 'stale' }
  | { readonly kind: 'attempt'; readonly phase: ValidationPhase };

/**
 * Decide whether a persisted session has a resumable pending operation. A
 * marker outside a validation phase is stale (defensive: applyTransition clears
 * it atomically); an active backoff window defers the retry to a later
 * lifecycle opportunity.
 */
function classifyPendingOperation(session: SessionRead, nowMs: number): PendingOperationDecision {
  const { phase, activeChecks, pendingSystemWork } = session;
  if (pendingSystemWork === null) return { kind: 'none' };
  if (!isValidationPhase(phase)) return { kind: 'stale' };
  if (activeChecks.length === 0) return { kind: 'none' };
  if (isBackoffActive(pendingSystemWork.retryAfter, nowMs)) return { kind: 'none' };
  return { kind: 'attempt', phase };
}

export async function resumePendingSystemWork(
  context: WorkspaceToolContext,
): Promise<SystemWorkResumeOutcome> {
  const outcome = await readSession(context);
  if (outcome.kind === 'unreadable') {
    return {
      kind: 'blocked',
      code: 'SYSTEM_WORK_STATE_UNREADABLE',
      response: unreadableResponse(outcome),
    };
  }
  if (outcome.kind === 'none') return { kind: 'none' };
  const decision = classifyPendingOperation(outcome.session, Date.now());
  if (decision.kind === 'none') return { kind: 'none' };
  if (decision.kind === 'stale') {
    // The marker can only be stale if the phase already left validation in a
    // way that bypassed applyTransition (not a legal path). Clear defensively.
    await clearStalePendingSystemWork(context);
    return { kind: 'none' };
  }
  const phase = decision.phase;

  const sessionKey = context.sessionID;
  if (inFlightSystemWorkResumes.has(sessionKey)) return { kind: 'none' };
  inFlightSystemWorkResumes.add(sessionKey);
  try {
    const response = await runActiveChecksAutomatically(context);
    if (response === null) return { kind: 'none' };

    const after = await readSession(context);
    if (after.kind !== 'ok' || !isValidationPhase(after.session.phase)) {
      const completedPhase = after.kind === 'ok' ? after.session.phase : phase;
      return { kind: 'completed', phase: completedPhase, response };
    }

    // Technical outcome: keep the operation pending, record the attempt, and
    // set the backoff for the next lifecycle opportunity.
    const freshMarker = after.session.pendingSystemWork;
    if (freshMarker !== null) {
      await persistRetryState(
        context,
        freshMarker.attempt + 1,
        retryDelayMs(freshMarker.attempt + 1),
      );
    }
    return { kind: 'still_pending', phase: after.session.phase, response };
  } finally {
    inFlightSystemWorkResumes.delete(sessionKey);
  }
}

/**
 * Persist the retry state for a pending operation that stayed in validation.
 * A no-op when the marker disappeared (the run left validation) or the phase
 * changed concurrently.
 */
async function persistRetryState(
  context: WorkspaceToolContext,
  attempt: number,
  delayMs: number,
): Promise<void> {
  try {
    await withMutableSessionTransaction(context, async ({ sessDir, state }) => {
      if (state.pendingSystemWork === null || !isValidationPhase(state.phase)) return;
      await writeStateWithArtifacts(sessDir, {
        ...state,
        pendingSystemWork: {
          ...state.pendingSystemWork,
          attempt,
          retryAfter: new Date(Date.now() + delayMs).toISOString(),
        },
      });
    });
  } catch (err) {
    getAdapterLogger().warn('tool', 'system_work_retry_state_failed', {
      sessionId: context.sessionID,
      error: err instanceof Error ? err.message : String(err),
      ...getLogTraceFields(),
    });
  }
}

async function executeCheckResponse(
  kind: VerificationCandidateKind,
  context: WorkspaceToolContext,
): Promise<string> {
  try {
    return responseText(await executeRunCheckPhased(kind, undefined, context));
  } catch (err) {
    return formatError(err);
  }
}

/**
 * Clear the pending marker, but only while the session still sits in a
 * validation phase: a transition out of validation already cleared it
 * atomically, and re-reading prevents clobbering a newer state.
 */
/**
 * Clear a marker that is stale because the session already left validation.
 * Never clear while the phase is still a validation phase: a pending marker
 * there is authoritative retry authority, not garbage.
 */
async function clearStalePendingSystemWork(context: WorkspaceToolContext): Promise<void> {
  try {
    await withMutableSessionTransaction(context, async ({ sessDir, state }) => {
      if (state.pendingSystemWork === null) return;
      if (isValidationPhase(state.phase)) return;
      await writeStateWithArtifacts(sessDir, { ...state, pendingSystemWork: null });
    });
  } catch (err) {
    getAdapterLogger().warn('tool', 'system_work_marker_clear_failed', {
      sessionId: context.sessionID,
      error: err instanceof Error ? err.message : String(err),
      ...getLogTraceFields(),
    });
  }
}
