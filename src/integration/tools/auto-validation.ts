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
    // A completed attempt (success, failure, or execution error) consumes the
    // pending marker. If the process dies mid-run the marker survives and the
    // next runtime contact resumes the work.
    await clearPendingSystemWorkIfStillValidation(context);
  }
}

/**
 * Resume a pending system-work operation after a crash or an interrupted run.
 *
 * Called on the next runtime contact (any host command). A marker whose phase
 * already left validation is stale and is cleared; a marker in a validation
 * phase with active checks runs the automatic validation.
 */
export async function resumePendingSystemWork(
  context: WorkspaceToolContext,
): Promise<string | null> {
  const outcome = await readSession(context);
  if (outcome.kind === 'unreadable') return unreadableResponse(outcome);
  if (outcome.kind === 'none') return null;
  const { phase, activeChecks, pendingSystemWork } = outcome.session;
  if (pendingSystemWork === null) return null;
  if (!isValidationPhase(phase) || activeChecks.length === 0) {
    await clearPendingSystemWorkIfStillValidation(context);
    return null;
  }
  return runActiveChecksAutomatically(context);
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
async function clearPendingSystemWorkIfStillValidation(
  context: WorkspaceToolContext,
): Promise<void> {
  try {
    await withMutableSessionTransaction(context, async ({ sessDir, state }) => {
      if (state.pendingSystemWork === null) return;
      if (!isValidationPhase(state.phase)) return;
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
