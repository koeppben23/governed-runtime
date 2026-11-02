/**
 * @module integration/review/native-review-execution
 * @description Host-neutral reviewer execution closure and output projection.
 *
 * Every function binds or closes only through the canonical durable dispatch
 * and evidence owners. The fulfilled projection is wired into the V2 capture;
 * the incoherent-verdict, pre-bind and expired-dispatch closures are retained
 * review policy whose V2 wiring is tracked in the implementation inventory
 * (parity work), not a second transport.
 */

import type { ToolHookAfterOutput } from '../../types.js';
import { buildEnforcementError, strictBlockedOutput } from '../../blocked-result.js';
import { projectReviewExecution } from './review-execution-projection.js';
import type { NativeReviewTransportRuntime, PersistedState } from './native-review-types.js';
import type { SessionEnforcementState } from '../types.js';
import { abandonAndBlockByHostCall } from './durable-dispatch.js';
import { readState } from '../../../adapters/persistence.js';

/** Remove the transient pending-review entry for a blocked obligation. */
function clearPendingReviewForObligation(
  state: SessionEnforcementState,
  obligationId: string,
): void {
  for (const [tool, pending] of state.pendingReviews) {
    if (pending.obligationId === obligationId) state.pendingReviews.delete(tool);
  }
}
/** Canonical terminal closure for an already-detected reviewer execution failure. */
export async function closeExecutionFailure(input: {
  readonly runtime: NativeReviewTransportRuntime;
  readonly sessDir: string;
  readonly callId: string;
  readonly childSessionId?: string;
  readonly code: string;
  readonly reason: string;
  readonly obligationId: string;
  readonly sessionId: string;
  readonly phase: string;
  readonly output: ToolHookAfterOutput;
}) {
  const closure = await abandonAndBlockByHostCall(
    input.runtime.orchestratorDeps,
    input.sessDir,
    input.callId,
    input.code,
    {
      obligationId: input.obligationId,
      ...(input.childSessionId === undefined ? {} : { childSessionId: input.childSessionId }),
    },
  );
  if (closure.kind === 'unresolved') {
    throw buildEnforcementError(closure.code, closure.reason);
  }
  if (closure.kind === 'terminal' && closure.status === 'completed') return closure;
  input.output.output = strictBlockedOutput(input.code, {
    obligationId: closure.kind === 'blocked' ? closure.obligationId : input.obligationId,
    reason: input.reason,
  });
  return closure;
}

export async function blockIncoherentCompletedCapture(input: {
  readonly runtime: NativeReviewTransportRuntime;
  readonly sessDir: string;
  readonly sessionId: string;
  readonly obligationId: string;
  readonly prepared: Record<string, unknown>;
  readonly output: ToolHookAfterOutput;
  readonly phase: string;
}): Promise<boolean> {
  const verdict = input.prepared.overallVerdict;
  const blocking = input.prepared.blockingIssues;
  if (verdict !== 'accept' || !Array.isArray(blocking) || blocking.length === 0) return false;
  await input.runtime.orchestratorDeps.blockReviewOutcome(
    { sessDir: input.sessDir, sessionId: input.sessionId, phase: input.phase },
    input.obligationId,
    'SUBAGENT_VERDICT_FINDINGS_INCOHERENT',
    {
      reason:
        'A completed reviewer capture reported accept together with blocking issues. This inconsistency is terminal and never re-arms another reviewer.',
    },
    input.output,
  );
  clearPendingReviewForObligation(
    input.runtime.ws.getEnforcementState(input.sessionId),
    input.obligationId,
  );
  return true;
}

/** Persistently close authorized dispatches whose absolute deadline elapsed
 * before a new reviewer subagent may be authorized. */
async function reconcileExpiredAuthorizedDispatches(input: {
  readonly runtime: NativeReviewTransportRuntime;
  readonly sessDir: string;
  readonly state: PersistedState;
  readonly timeoutMs: number;
}): Promise<number> {
  const now = Date.now();
  const expired = (input.state.reviewAssurance?.dispatches ?? []).filter(
    (dispatch) =>
      dispatch.dispatchStatus === 'authorized' &&
      Date.parse(dispatch.dispatchAuthorizedAt) + input.timeoutMs < now,
  );
  let blocked = 0;
  for (const dispatch of expired) {
    const result = await abandonAndBlockByHostCall(
      input.runtime.orchestratorDeps,
      input.sessDir,
      dispatch.hostCallId,
      'REVIEWER_EXECUTION_OUTCOME_UNKNOWN',
    );
    if (result.kind === 'blocked') blocked += 1;
  }
  return blocked;
}

export async function reconcileExpiredAuthorizedDispatchesOrThrow(
  runtime: NativeReviewTransportRuntime,
  sessionId: string,
  sessDir: string,
  state: PersistedState,
): Promise<{ readonly sessDir: string; readonly state: PersistedState }> {
  const expired = await reconcileExpiredAuthorizedDispatches({
    runtime,
    sessDir,
    state,
    timeoutMs: runtime.reviewerExecutionTimeoutMs ?? 600_000,
  });
  if (expired === 0) return { sessDir, state };
  const resolution = await runtime.ws.resolveSessionAuthority(sessionId);
  if (resolution.status !== 'resolved') {
    throw buildEnforcementError(
      'REVIEW_ASSURANCE_STATE_UNAVAILABLE',
      'Expired reviewer dispatch state is unreadable.',
    );
  }
  throw buildEnforcementError(
    'REVIEWER_EXECUTION_OUTCOME_UNKNOWN',
    'A prior authorized reviewer dispatch exceeded its absolute deadline before a child was observed. No new reviewer may start until that host outcome is reconciled.',
  );
}

export async function guardPreBindReview(input: {
  readonly runtime: NativeReviewTransportRuntime;
  readonly sessDir: string;
  readonly obligationId: string;
  readonly output: ToolHookAfterOutput;
}): Promise<boolean> {
  const state = await readState(input.sessDir);
  const lock = state?.reviewAssurance?.capacityLock;
  const obligation = state?.reviewAssurance?.obligations.find(
    (item) => item.obligationId === input.obligationId,
  );
  if (obligation?.status !== 'blocked') return false;
  input.output.output = strictBlockedOutput(
    lock?.code ?? obligation.blockedCode ?? 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN',
    {
      obligationId: input.obligationId,
      reason: 'The review was terminated before evidence binding.',
    },
  );
  return true;
}

export async function projectFulfilledReview(input: {
  readonly runtime: NativeReviewTransportRuntime;
  readonly sessDir: string;
  readonly sessionId: string;
  readonly childSessionId: string;
  readonly attemptId: string;
  readonly obligationId: string;
  readonly verdict: string;
  readonly output: ToolHookAfterOutput;
}): Promise<void> {
  const boundState = await readState(input.sessDir);
  const invocation = boundState?.reviewAssurance?.invocations.find(
    (item) => item.attemptId === input.attemptId && item.childSessionId === input.childSessionId,
  );
  input.output.output = JSON.stringify({
    status: 'Independent reviewer completed in a visible native child session.',
    reviewDispatch: { required: true, completed: true, verdict: input.verdict },
    ...(invocation ? { reviewExecution: projectReviewExecution(invocation) } : {}),
  });
  if (invocation)
    input.output.metadata.flowguardReviewExecution = projectReviewExecution(invocation);
  input.runtime.log.info('orchestrator', 'native reviewer subagent fulfilled review obligation', {
    sessionId: input.sessionId,
    childSessionId: input.childSessionId,
    obligationId: input.obligationId,
    attemptId: input.attemptId,
    verdict: input.verdict,
  });
}
