/**
 * @module integration/review/native-task-review-execution
 * @description Native reviewer Task fallback for watchdog failures that could
 * not be persisted before the after-hook.
 */

import type { ToolHookAfterOutput } from '../../types.js';
import type { ReviewFindings } from '../../../state/evidence.js';
import { strictBlockedOutput, unableReviewDiagnostics } from '../../blocked-result.js';
import { projectReviewExecution } from './review-execution-projection.js';
import type { NativeReviewTransportRuntime } from './native-task-review-types.js';
import { abandonAndBlock, clearPendingReviewForObligation } from './capture-failure-routing.js';
import { abandonAndBlockByHostCall } from './durable-dispatch.js';
import { buildEnforcementError } from '../../blocked-result.js';
import { readState } from '../../../adapters/persistence.js';
import type { PersistedState } from './native-task-review-types.js';

export async function handleReviewerExecutionFailure(input: {
  readonly runtime: NativeReviewTransportRuntime;
  readonly sessDir: string;
  readonly callId: string;
  readonly childSessionId: string;
  readonly hookOutput: ToolHookAfterOutput;
  readonly obligationId: string;
}): Promise<boolean> {
  const { runtime, sessDir, callId, childSessionId, hookOutput, obligationId } = input;
  const failures = runtime.reviewerExecutionFailures;
  const failure = failures?.get(childSessionId);
  if (!failure) return false;
  failures?.delete(childSessionId);
  await abandonAndBlock({
    runtime,
    sessDir,
    callId,
    output: hookOutput,
    code: failure.code,
    reason: failure.reason,
    obligationId,
  });
  return true;
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

export function taskChildSessionId(output: ToolHookAfterOutput): string | null {
  return typeof output.metadata?.sessionId === 'string' && output.metadata.sessionId.length > 0
    ? output.metadata.sessionId
    : null;
}

export function projectUnableToReview(
  output: ToolHookAfterOutput,
  obligationId: string,
  findings: Pick<ReviewFindings, 'missingVerification' | 'unknowns'>,
): void {
  output.output = strictBlockedOutput('SUBAGENT_UNABLE_TO_REVIEW', {
    obligationId,
    ...unableReviewDiagnostics(findings),
  });
}

/** Persistently close authorized dispatches whose absolute deadline elapsed
 * before a new reviewer Task may be authorized. */
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
    timeoutMs: runtime.reviewerExecutionTimeoutMs ?? 120_000,
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
  input.runtime.log.info('orchestrator', 'native reviewer Task fulfilled review obligation', {
    sessionId: input.sessionId,
    childSessionId: input.childSessionId,
    obligationId: input.obligationId,
    attemptId: input.attemptId,
    verdict: input.verdict,
  });
}
