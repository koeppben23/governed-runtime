/**
 * @module integration/review/capture-failure-routing
 * @description Retry routing for native reviewer capture/binding failures.
 *
 * Terminal codes fail the review closed unchanged. Retryable codes abandon the
 * exact host release and re-arm a fresh attempt on the same frozen obligation
 * (bounded by the obligation budget); the failing child session is persisted on
 * the staled attempt in the same mutation. A refused re-arm fails closed with
 * the original capture code.
 *
 * @version v1
 */

import type { ToolHookAfterOutput } from '../../types.js';
import type { ReviewObligationType } from '../../../state/evidence.js';
import type {
  PendingReviewRetryDiagnostic,
  ReviewerOutputCapFailure,
  SessionEnforcementState,
} from '../types.js';
import type { NativeReviewTransportRuntime } from './native-task-review-types.js';
import type { OrchestratorDeps } from '../pipeline-types.js';
import { strictBlockedOutput } from '../../blocked-result.js';
import {
  abandonAndBlockByHostCall,
  abandonAndRearmByHostCall,
  abandonReviewDispatchByHostCall,
} from './durable-dispatch.js';
import {
  buildReviewerCaptureRetryOutput,
  captureFailureBlockDetail,
  classifyReviewerCaptureFailure,
  isCapacityReviewerCaptureCode,
} from './capture-retry.js';
import { registerPendingReviewForAttempt } from '../enforcement/enforcement.js';
import { reviewableToolForObligationType } from '../obligations/obligation-tools.js';

export interface BlockOutputInput {
  readonly runtime: NativeReviewTransportRuntime;
  readonly sessDir: string;
  readonly callId: string;
  readonly output: ToolHookAfterOutput;
  readonly code: string;
  readonly reason: string;
  readonly obligationId: string;
  readonly diagnostics?: readonly PendingReviewRetryDiagnostic[];
}

export interface CaptureFailureContext extends Omit<BlockOutputInput, 'code' | 'reason'> {
  readonly sessionId: string;
  readonly obligationType: ReviewObligationType;
  /** Bound reviewer child, when the failure happens after the Task release. */
  readonly childSessionId?: string;
}

export type CaptureFailureInput = CaptureFailureContext & {
  readonly code: string;
  readonly reason: string;
  readonly diagnostics: readonly PendingReviewRetryDiagnostic[];
};

export async function abandonAndBlock(input: BlockOutputInput): Promise<void> {
  await abandonReviewDispatchByHostCall(
    input.runtime.orchestratorDeps,
    input.sessDir,
    input.callId,
  );
  input.output.output = strictBlockedOutput(
    input.code,
    captureFailureBlockDetail({
      obligationId: input.obligationId,
      reason: input.reason,
      ...(input.diagnostics !== undefined ? { diagnostics: input.diagnostics } : {}),
    }),
  );
}

export async function abandonOrRetryCaptureFailure(input: CaptureFailureInput): Promise<void> {
  if (isCapacityReviewerCaptureCode(input.code)) {
    const closure = await abandonAndBlockByHostCall(
      input.runtime.orchestratorDeps,
      input.sessDir,
      input.callId,
      input.code,
      { ...(input.childSessionId !== undefined ? { childSessionId: input.childSessionId } : {}) },
    );
    if (closure.kind === 'blocked') {
      input.output.output = strictBlockedOutput(
        input.code,
        captureFailureBlockDetail({
          obligationId: closure.obligationId,
          reason: input.reason,
          ...(input.diagnostics !== undefined ? { diagnostics: input.diagnostics } : {}),
        }),
      );
      return;
    }
    await abandonAndBlock({
      ...input,
      reason: `${input.reason} Durable capacity closure could not resolve the exact dispatch lineage; the obligation was not marked blocked.`,
    });
    return;
  }

  const decision = classifyReviewerCaptureFailure(input.code);
  if (!decision.retryable) {
    await abandonAndBlock(input);
    return;
  }
  const rearm = await abandonAndRearmByHostCall(
    input.runtime.orchestratorDeps,
    input.sessDir,
    input.callId,
    undefined,
    {
      code: input.code,
      diagnostics: input.diagnostics,
      ...(input.childSessionId !== undefined ? { childSessionId: input.childSessionId } : {}),
    },
  );
  if (rearm.kind !== 'rearmed') {
    const blockedReason =
      rearm.kind === 'blocked'
        ? rearm.cause === 'budget_exhausted'
          ? `FlowGuard closed the broken review obligation because the re-arm budget is exhausted (${rearm.reason}); no fresh reviewer attempt was authorized. Re-run the originating command to submit the artifact again and mint a fresh obligation.`
          : `FlowGuard could not re-arm a fresh reviewer attempt: ${rearm.reason}.`
        : 'FlowGuard found no exact abandoned dispatch lineage to re-arm.';
    await abandonAndBlock({
      ...input,
      // The actionable recovery cause leads even when the capture detail is truncated.
      reason: `${blockedReason} Previous capture failure: ${input.reason}`,
    });
    return;
  }
  const reviewTool = reviewableToolForObligationType(input.obligationType);
  if (!reviewTool) {
    await abandonAndBlock({
      ...input,
      reason: `${input.reason} No reviewable tool owns obligation type ${input.obligationType}.`,
    });
    return;
  }
  registerPendingReviewForAttempt(
    input.runtime.ws.getEnforcementState(input.sessionId),
    reviewTool,
    {
      attemptId: rearm.attempt.attemptId,
      obligationId: rearm.obligationId,
      retryDiagnostics: input.diagnostics,
    },
    new Date().toISOString(),
  );
  input.output.output = buildReviewerCaptureRetryOutput({
    code: input.code,
    obligationId: rearm.obligationId,
    attemptId: rearm.attempt.attemptId,
    diagnostics: input.diagnostics,
  });
}

export interface ReviewerOutputCapObligationInput {
  readonly sessDir: string;
  readonly parentSessionId: string;
  readonly phase: string;
  readonly obligationId: string;
  readonly failure: ReviewerOutputCapFailure;
  readonly output: { output: string };
}

/** Block the obligation and append the canonical audit event. */
export async function blockReviewerOutputCapObligation(
  orchestratorDeps: Pick<OrchestratorDeps, 'blockReviewOutcome'>,
  input: ReviewerOutputCapObligationInput,
): Promise<void> {
  await orchestratorDeps.blockReviewOutcome(
    {
      sessDir: input.sessDir,
      sessionId: input.parentSessionId,
      phase: input.phase,
    },
    input.obligationId,
    'REVIEWER_OUTPUT_CAP_INVALID',
    { reason: `${input.failure.code}: ${input.failure.reason}` },
    input.output,
  );
}

/** Remove the transient pending-review entry for a blocked obligation. */
export function clearPendingReviewForObligation(
  state: SessionEnforcementState,
  obligationId: string,
): void {
  for (const [tool, pending] of state.pendingReviews) {
    if (pending.obligationId === obligationId) state.pendingReviews.delete(tool);
  }
}
