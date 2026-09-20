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
 * `pendingSystemWork` in the same transition write (`applyTransition`). Every
 * automatic attempt — initial or resumed — either leaves validation, durably
 * re-arms the exact pending operation generation with backoff, or blocks. A
 * retry metadata write is therefore never best-effort.
 *
 * Reentrancy: the runner is guarded per session, never process-globally. Two
 * sessions may validate concurrently; a second re-entrant call for the SAME
 * session is a no-op.
 *
 * @version v3
 */

import type { Phase, SessionState } from '../../state/schema.js';
import type { SystemWorkOperation } from '../../state/system-work.js';
import type { ToolResult, WorkspaceToolContext } from './helpers.js';
import { formatBlocked } from '../blocked-result.js';
import {
  withMutableSessionTransaction,
  withReadOnlySession,
  writeStateWithArtifacts,
} from './helpers.js';
import { PersistenceError } from '../../adapters/lock-retry.js';
import { executeRunCheckPhased } from './validation/run-check-tool.js';
import { formatError } from './error-format.js';
import { getAdapterLogger, getLogTraceFields } from '../../logging/adapter-logger.js';
import type { VerificationCandidateKind } from '../../state/discovery-schemas.js';
import { IntegrationInvariantError } from '../errors.js';

type ValidationPhase = 'VALIDATION' | 'IMPL_VALIDATION';

/**
 * Retry persistence dependencies. The default is production persistence; the
 * optional override keeps the durability boundary directly testable without
 * weakening the production contract.
 */
export interface SystemWorkRetryDeps {
  readonly persistState: (sessDir: string, state: SessionState) => Promise<SessionState>;
  readonly nowMs: () => number;
}

const DEFAULT_SYSTEM_WORK_RETRY_DEPS: SystemWorkRetryDeps = {
  persistState: writeStateWithArtifacts,
  nowMs: Date.now,
};

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

function pendingSystemWorkMarkerMissingError(): IntegrationInvariantError {
  return new IntegrationInvariantError(
    'SYSTEM_WORK_MARKER_MISSING',
    'pending system-work marker missing while validation remained active',
  );
}

function retryPersistenceBlockedResponse(
  context: WorkspaceToolContext,
  err: unknown,
): {
  readonly kind: 'blocked';
  readonly code: 'WRITE_FAILED';
  readonly response: string;
} {
  const message = err instanceof Error ? err.message : String(err);
  getAdapterLogger().error('tool', 'system_work_retry_state_failed', {
    sessionId: context.sessionID,
    error: message,
    ...getLogTraceFields(),
  });
  return {
    kind: 'blocked',
    code: 'WRITE_FAILED',
    response: formatBlocked('WRITE_FAILED', {
      message: `system-work retry authority could not be persisted: ${message}`,
    }),
  };
}

/**
 * Typed outcome of a system-work attempt. Callers must consume the result
 * instead of discarding it:
 * - `none`          — no runnable pending work (or a concurrent attempt owns it).
 * - `completed`     — the run left the validation phase.
 * - `still_pending` — the run hit a technical outcome and the exact operation
 *                     generation was durably re-armed for a later retry.
 * - `blocked`       — state or retry-authority persistence failed; fail closed.
 */
export type SystemWorkResumeOutcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'completed'; readonly phase: Phase; readonly response: string }
  | { readonly kind: 'still_pending'; readonly phase: Phase; readonly response: string }
  | { readonly kind: 'blocked'; readonly code: string; readonly response: string };

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

type RearmResult =
  | { readonly kind: 'rearmed'; readonly marker: SystemWorkOperation }
  | { readonly kind: 'superseded' }
  | { readonly kind: 'completed' };

/**
 * Durably re-arm exactly the pending operation generation that produced the
 * technical outcome. `requestedAt + attempt` is the generation fence: a stale
 * attempt may never overwrite a newer operation or a concurrently re-armed
 * attempt.
 */
export async function rearmPendingSystemWork(
  context: WorkspaceToolContext,
  expectedMarker: SystemWorkOperation,
  deps: SystemWorkRetryDeps = DEFAULT_SYSTEM_WORK_RETRY_DEPS,
): Promise<RearmResult> {
  return withMutableSessionTransaction(context, async ({ sessDir, state }) => {
    const current = state.pendingSystemWork;
    if (current === null || !isValidationPhase(state.phase)) {
      return { kind: 'completed' };
    }
    if (
      current.requestedAt !== expectedMarker.requestedAt ||
      current.attempt !== expectedMarker.attempt ||
      current.retryAfter !== expectedMarker.retryAfter
    ) {
      return { kind: 'superseded' };
    }

    const nextAttempt = current.attempt + 1;
    const marker: SystemWorkOperation = {
      ...current,
      attempt: nextAttempt,
      retryAfter: new Date(deps.nowMs() + retryDelayMs(nextAttempt)).toISOString(),
    };
    await deps.persistState(sessDir, {
      ...state,
      pendingSystemWork: marker,
    });
    return { kind: 'rearmed', marker };
  });
}

function unavailableAfterAttemptResponse(
  reason: string,
): Extract<SystemWorkResumeOutcome, { readonly kind: 'blocked' }> {
  return {
    kind: 'blocked',
    code: 'SYSTEM_WORK_STATE_UNREADABLE',
    response: formatBlocked('SYSTEM_WORK_STATE_UNREADABLE', { reason }),
  };
}

type CheckSequenceResult =
  | { readonly kind: 'completed'; readonly phase: Phase; readonly response: string }
  | { readonly kind: 'blocked'; readonly code: string; readonly response: string }
  | { readonly kind: 'finished'; readonly lastResponse: string }
  | { readonly kind: 'empty' };

async function runActiveCheckSequence(
  context: WorkspaceToolContext,
  phase: ValidationPhase,
  activeChecks: readonly string[],
): Promise<CheckSequenceResult> {
  let lastResponse: string | null = null;
  for (const kind of activeChecks) {
    const text = await executeCheckResponse(kind as VerificationCandidateKind, context);
    lastResponse = text;

    if (responseReportsError(text)) break;

    const fresh = await readSession(context);
    if (fresh.kind === 'unreadable') {
      return {
        kind: 'blocked',
        code: 'SYSTEM_WORK_STATE_UNREADABLE',
        response: unreadableResponse(fresh),
      };
    }
    if (fresh.kind === 'none') {
      return unavailableAfterAttemptResponse(
        'session disappeared while automatic validation was running',
      );
    }
    if (fresh.session.phase !== phase) {
      return { kind: 'completed', phase: fresh.session.phase, response: text };
    }
  }

  if (lastResponse === null) return { kind: 'empty' };
  return { kind: 'finished', lastResponse };
}

async function rearmAfterTechnicalOutcome(input: {
  readonly context: WorkspaceToolContext;
  readonly deps: SystemWorkRetryDeps;
  readonly pendingSystemWork: SystemWorkOperation;
  readonly fallbackPhase: Phase;
  readonly lastResponse: string;
}): Promise<SystemWorkResumeOutcome> {
  try {
    const rearmed = await rearmPendingSystemWork(
      input.context,
      input.pendingSystemWork,
      input.deps,
    );
    if (rearmed.kind === 'completed') {
      const completed = await readSession(input.context);
      if (completed.kind === 'ok' && !isValidationPhase(completed.session.phase)) {
        return {
          kind: 'completed',
          phase: completed.session.phase,
          response: input.lastResponse,
        };
      }
    }
    return {
      kind: 'still_pending',
      phase: input.fallbackPhase,
      response: input.lastResponse,
    };
  } catch (err) {
    return retryPersistenceBlockedResponse(input.context, err);
  }
}

async function finalizeAutomaticValidationAttempt(input: {
  readonly context: WorkspaceToolContext;
  readonly deps: SystemWorkRetryDeps;
  readonly pendingSystemWork: SystemWorkOperation | null;
  readonly lastResponse: string;
}): Promise<SystemWorkResumeOutcome> {
  const after = await readSession(input.context);
  if (after.kind === 'unreadable') {
    return {
      kind: 'blocked',
      code: 'SYSTEM_WORK_STATE_UNREADABLE',
      response: unreadableResponse(after),
    };
  }
  if (after.kind === 'none') {
    return unavailableAfterAttemptResponse(
      'session disappeared after automatic validation completed',
    );
  }
  if (!isValidationPhase(after.session.phase)) {
    return { kind: 'completed', phase: after.session.phase, response: input.lastResponse };
  }
  if (input.pendingSystemWork === null) {
    return retryPersistenceBlockedResponse(input.context, pendingSystemWorkMarkerMissingError());
  }
  return rearmAfterTechnicalOutcome({
    context: input.context,
    deps: input.deps,
    pendingSystemWork: input.pendingSystemWork,
    fallbackPhase: after.session.phase,
    lastResponse: input.lastResponse,
  });
}

/**
 * Execute one canonical automatic-validation attempt. This owns the complete
 * attempt lifecycle for both the initial in-flow run and lifecycle recovery:
 * execute checks → inspect phase → either complete or durably re-arm.
 */
async function runAutomaticValidationAttempt(
  context: WorkspaceToolContext,
  deps: SystemWorkRetryDeps,
): Promise<SystemWorkResumeOutcome> {
  const sessionKey = context.sessionID;
  if (activeValidationSessions.has(sessionKey)) return { kind: 'none' };
  activeValidationSessions.add(sessionKey);

  try {
    const before = await readSession(context);
    if (before.kind === 'unreadable') {
      return {
        kind: 'blocked',
        code: 'SYSTEM_WORK_STATE_UNREADABLE',
        response: unreadableResponse(before),
      };
    }
    if (before.kind === 'none') return { kind: 'none' };

    const { phase, activeChecks, pendingSystemWork } = before.session;
    if (!isValidationPhase(phase)) return { kind: 'none' };
    if (activeChecks.length === 0) return { kind: 'none' };
    if (pendingSystemWork !== null && isBackoffActive(pendingSystemWork.retryAfter, deps.nowMs())) {
      return { kind: 'none' };
    }

    getAdapterLogger().info('tool', 'auto_validation', {
      sessionId: context.sessionID,
      phase,
      checks: activeChecks.join(','),
      ...getLogTraceFields(),
    });

    const sequence = await runActiveCheckSequence(context, phase, activeChecks);
    if (sequence.kind === 'completed' || sequence.kind === 'blocked') return sequence;
    if (sequence.kind === 'empty') return { kind: 'none' };

    return finalizeAutomaticValidationAttempt({
      context,
      deps,
      pendingSystemWork,
      lastResponse: sequence.lastResponse,
    });
  } finally {
    activeValidationSessions.delete(sessionKey);
  }
}

/**
 * Execute all active checks for the current validation phase.
 *
 * Additive to the primary mutation that entered the phase: callers return the
 * primary tool output when this runner returns `null`, and the runner's
 * response when it returns a string. A technical outcome is returned only
 * after the exact pending operation generation has been durably re-armed.
 */
export async function runActiveChecksAutomatically(
  context: WorkspaceToolContext,
  deps: SystemWorkRetryDeps = DEFAULT_SYSTEM_WORK_RETRY_DEPS,
): Promise<string | null> {
  const outcome = await runAutomaticValidationAttempt(context, deps);
  return outcome.kind === 'none' ? null : outcome.response;
}

/**
 * In-flight lifecycle resumes per session. The claim exists only for the
 * duration of a resume decision/attempt; `runAutomaticValidationAttempt` owns
 * the execution guard and durable retry authority.
 */
const inFlightSystemWorkResumes = new Set<string>();

/**
 * Resume a pending system-work operation.
 *
 * Triggered by the host session lifecycle (session becomes idle/active), never
 * by a user workflow command: `system_work` phases have no commands, so the
 * runtime owns the continuation.
 */
type PendingOperationDecision =
  { readonly kind: 'none' } | { readonly kind: 'stale' } | { readonly kind: 'attempt' };

function classifyPendingOperation(session: SessionRead, nowMs: number): PendingOperationDecision {
  const { phase, activeChecks, pendingSystemWork } = session;
  if (pendingSystemWork === null) return { kind: 'none' };
  if (!isValidationPhase(phase)) return { kind: 'stale' };
  if (activeChecks.length === 0) return { kind: 'none' };
  if (isBackoffActive(pendingSystemWork.retryAfter, nowMs)) return { kind: 'none' };
  return { kind: 'attempt' };
}

export async function resumePendingSystemWork(
  context: WorkspaceToolContext,
  deps: SystemWorkRetryDeps = DEFAULT_SYSTEM_WORK_RETRY_DEPS,
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

  const decision = classifyPendingOperation(outcome.session, deps.nowMs());
  if (decision.kind === 'none') return { kind: 'none' };
  if (decision.kind === 'stale') {
    await clearStalePendingSystemWork(context);
    return { kind: 'none' };
  }

  const sessionKey = context.sessionID;
  if (inFlightSystemWorkResumes.has(sessionKey)) return { kind: 'none' };
  inFlightSystemWorkResumes.add(sessionKey);
  try {
    return await runAutomaticValidationAttempt(context, deps);
  } finally {
    inFlightSystemWorkResumes.delete(sessionKey);
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
