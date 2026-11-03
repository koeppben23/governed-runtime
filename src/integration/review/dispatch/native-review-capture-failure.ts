/** Terminal capture closure and projection; never emits invocation evidence. */
import { abandonReviewDispatch, ensureReviewAssurance } from '../../../state/review-dispatch.js';
import { blockObligation } from '../obligations/obligation-state.js';
import { updateAttemptStatus } from '../obligations/attempt-lifecycle.js';
import {
  nativeReviewDispatchLineage,
  type NativeReviewStateAuthority,
} from './native-review-dispatch.js';
import { strictBlockedOutput } from '../../blocked-result.js';
import type { NativeCaptureRuntime, NativeCaptureOutcome } from './native-review-capture.js';
import { abandonAndBlockByHostCall, abandonAndRearmByHostCall } from './durable-dispatch.js';
import {
  buildCaptureFailureDiagnostics,
  buildReviewerCaptureRetryOutput,
  classifyReviewerCaptureFailure,
} from './capture-retry.js';

/** Terminal, tool-contaminated capture: reject the attempt and block atomically. */
async function rejectNativeReviewCapture(input: {
  readonly runtime: NativeCaptureRuntime;
  readonly sessDir: string;
  readonly authority: NativeReviewStateAuthority;
  readonly nativeCallId: string;
  readonly childSessionId: string;
  readonly code: string;
  readonly reason: string;
}): Promise<void> {
  let obligationId: string | undefined;
  await input.runtime.orchestratorDeps.updateReviewAssurance(
    input.sessDir,
    (state, now) => {
      const lineage = nativeReviewDispatchLineage(
        state,
        input.authority,
        input.nativeCallId,
        input.childSessionId,
      );
      obligationId = lineage.obligation.obligationId;
      const blocked = blockObligation(state, lineage.obligation.obligationId, input.code);
      const abandoned = abandonReviewDispatch(
        ensureReviewAssurance(blocked.reviewAssurance),
        input.nativeCallId,
      );
      return {
        ...blocked,
        reviewAssurance: updateAttemptStatus(abandoned, lineage.attempt.attemptId, 'rejected', now),
      };
    },
    (state, now) => [
      {
        phase: state.phase,
        event: 'review:obligation_blocked',
        occurredAt: now,
        detail: { obligationId: obligationId ?? '', code: input.code, reason: input.reason },
      },
    ],
  );
}

/** The output projection is deliberately filled only after durable binding. */
export function blockedCaptureOutput(code: string, reason: string): string {
  return strictBlockedOutput(code, { reason });
}

export type CaptureClosure =
  | { readonly kind: 'retry'; readonly output: string }
  | { readonly kind: 'blocked'; readonly code: string; readonly reason: string };

export async function closeNativeReviewerCapture(input: {
  readonly runtime: NativeCaptureRuntime;
  readonly sessDir: string;
  readonly authority: NativeReviewStateAuthority;
  readonly nativeCallId: string;
  readonly childSessionId: string;
  readonly obligationId: string;
  readonly attemptId: string;
  readonly outcome: Extract<NativeCaptureOutcome, { readonly kind: 'blocked' }>;
}): Promise<CaptureClosure> {
  const { runtime, sessDir, authority, nativeCallId, childSessionId, outcome } = input;
  const decision = classifyReviewerCaptureFailure(outcome.code);
  if (decision.retryable) {
    const diagnostics = buildCaptureFailureDiagnostics(
      outcome.code,
      parseCaptureDetails(outcome.reason),
    );
    const rearm = await abandonAndRearmByHostCall(
      runtime.orchestratorDeps,
      sessDir,
      nativeCallId,
      undefined,
      { code: outcome.code, diagnostics, childSessionId },
    );
    if (rearm.kind === 'rearmed')
      return {
        kind: 'retry',
        output: buildReviewerCaptureRetryOutput({
          code: outcome.code,
          obligationId: rearm.obligationId,
          attemptId: rearm.attempt.attemptId,
          diagnostics,
        }),
      };
    return {
      kind: 'blocked',
      code: 'REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE',
      reason:
        rearm.kind === 'blocked'
          ? `Reviewer retry budget exhausted: ${rearm.reason}`
          : 'The retryable reviewer failure could not be re-armed on its exact lineage.',
    };
  }
  if (outcome.code === 'SUBAGENT_VERDICT_FINDINGS_INCOHERENT')
    return { kind: 'blocked', code: outcome.code, reason: outcome.reason };
  if (outcome.code === 'REVIEWER_CAPTURE_PROVENANCE_INVALID') {
    await rejectNativeReviewCapture({
      runtime,
      sessDir,
      authority,
      nativeCallId,
      childSessionId,
      code: outcome.code,
      reason: outcome.reason,
    });
    return { kind: 'blocked', code: outcome.code, reason: outcome.reason };
  }
  await abandonAndBlockByHostCall(runtime.orchestratorDeps, sessDir, nativeCallId, outcome.code, {
    childSessionId,
    obligationId: input.obligationId,
    attemptId: input.attemptId,
  });
  return { kind: 'blocked', code: outcome.code, reason: outcome.reason };
}

function parseCaptureDetails(reason: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(reason);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
