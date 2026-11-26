/** Terminal capture closure and projection; never emits invocation evidence. */
import { abandonReviewDispatch, ensureReviewAssurance } from '../../../state/review-dispatch.js';
import { blockObligation } from '../obligations/obligation-state.js';
import { updateAttemptStatus } from '../obligations/attempt-lifecycle.js';
import { registerPendingReviewForAttempt } from '../enforcement/enforcement.js';
import {
  nativeReviewDispatchLineage,
  type NativeReviewStateAuthority,
} from './native-review-dispatch.js';
import { buildEnforcementError, strictBlockedOutput } from '../../blocked-result.js';
import type { NativeCaptureRuntime, NativeCaptureOutcome } from './native-review-capture.js';
import { abandonAndBlockByHostCall, abandonAndRearmByHostCall } from './durable-dispatch.js';
import {
  buildCaptureFailureDiagnostics,
  buildReviewerCaptureRetryOutput,
  classifyReviewerCaptureFailure,
} from './capture-retry.js';

type ReviewContext = {
  readonly session: {
    context(input: { readonly sessionID: string }): Promise<readonly unknown[]>;
  };
};

type CloseDeps = Parameters<typeof abandonAndBlockByHostCall>[0];

function row(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function bounded(value: string): string {
  return value.length > 500 ? `${value.slice(0, 500)}…` : value;
}

type ChildFailureCause = {
  readonly code: string;
  readonly message: string;
};

/** Read the child's terminal FlowGuard error without treating it as evidence. */
async function childFailureCause(
  ctx: ReviewContext,
  childSessionId: string,
): Promise<ChildFailureCause | null> {
  try {
    const history = await ctx.session.context({ sessionID: childSessionId });
    const last = row(history.at(-1));
    const error = row(last.error);
    const raw = typeof error.message === 'string' ? error.message : '';
    const prefix = '[FlowGuard] ';
    if (raw.startsWith(prefix)) {
      try {
        const payload = row(JSON.parse(raw.slice(prefix.length)));
        if (typeof payload.code === 'string')
          return {
            code: payload.code,
            message: bounded(typeof payload.message === 'string' ? payload.message : raw),
          };
      } catch {
        // Fall through to the host error type/message.
      }
    }
    if (typeof error.type === 'string')
      return { code: error.type, message: bounded(raw || error.type) };
    return null;
  } catch {
    return null;
  }
}

function childCauseDetail(
  cause: ChildFailureCause | null,
  childSessionId: string,
): Record<string, string> {
  return {
    childSessionId,
    transportCode: 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN',
    ...(cause === null
      ? { causeCode: 'UNAVAILABLE' }
      : { causeCode: cause.code, causeMessage: cause.message }),
  };
}

function closeLineage(
  closed: Awaited<ReturnType<typeof abandonAndBlockByHostCall>> | null,
): boolean {
  return closed?.kind === 'blocked' || (closed?.kind === 'terminal' && closed.status === 'blocked');
}

/**
 * The host concluded the subagent with an error, so no completed child exists.
 * Durably close the exact authorized dispatch first, then preserve the child's
 * terminal cause in the parent error. A terminal cause (integrity/provenance)
 * is never downgraded to a retryable transport failure; an unknown transport
 * outcome keeps the canonical retry_transport recovery only when the durable
 * lineage was actually closed.
 */
export async function closeUnknownOutcomeCapture(input: {
  readonly ctx: ReviewContext;
  readonly childSessionId: string;
  readonly nativeCallId: string;
  readonly resolveDeps: () => Promise<{ readonly deps: CloseDeps; readonly sessDir: string }>;
}): Promise<never> {
  const cause = await childFailureCause(input.ctx, input.childSessionId);
  const terminal = cause !== null && !classifyReviewerCaptureFailure(cause.code).retryable;
  const closureCode =
    terminal && cause !== null ? cause.code : 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN';
  let closed: Awaited<ReturnType<typeof abandonAndBlockByHostCall>> | null = null;
  try {
    const { deps, sessDir } = await input.resolveDeps();
    closed = await abandonAndBlockByHostCall(deps, sessDir, input.nativeCallId, closureCode, {
      childSessionId: input.childSessionId,
    });
  } catch {
    // The parent still fails closed; no retry is offered without a proven closure.
  }
  const detail = childCauseDetail(cause, input.childSessionId);
  if (!closeLineage(closed)) {
    throw buildEnforcementError(
      'REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE',
      'The reviewer child failed before exact completion and no unique unfinished dispatch lineage could be closed.',
      { ...detail, reason: 'The reviewer outcome could not be durably closed.' },
    );
  }
  if (terminal && cause !== null) {
    throw buildEnforcementError(cause.code, cause.message, detail);
  }
  throw buildEnforcementError(
    'REVIEWER_EXECUTION_OUTCOME_UNKNOWN',
    'The native reviewer completion did not expose an exact completed child; the child terminal cause is retained in detail.',
    detail,
  );
}

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
    const enforcement = runtime.ws.getEnforcementState(authority.parentSessionId);
    const pending = [...enforcement.pendingReviews.entries()].filter(
      ([, review]) =>
        review.obligationId === input.obligationId && review.attemptId === input.attemptId,
    );
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
    if (rearm.kind === 'rearmed' && pending.length === 1 && pending[0] !== undefined) {
      registerPendingReviewForAttempt(
        enforcement,
        pending[0][0],
        {
          obligationId: rearm.obligationId,
          attemptId: rearm.attempt.attemptId,
          retryDiagnostics: diagnostics,
        },
        rearm.attempt.createdAt,
      );
      return {
        kind: 'retry',
        output: buildReviewerCaptureRetryOutput({
          code: outcome.code,
          obligationId: rearm.obligationId,
          attemptId: rearm.attempt.attemptId,
          diagnostics,
        }),
      };
    }
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
