/** Terminal capture closure and projection; never emits invocation evidence. */
import { abandonReviewDispatch, ensureReviewAssurance } from '../../../state/review-dispatch.js';
import { blockObligation } from '../obligations/obligation-state.js';
import { updateAttemptStatus } from '../obligations/attempt-lifecycle.js';
import {
  nativeReviewDispatchLineage,
  type NativeReviewStateAuthority,
} from './native-review-dispatch.js';
import { strictBlockedOutput } from '../../blocked-result.js';
import type { NativeCaptureRuntime } from './native-review-capture.js';

/** Terminal, tool-contaminated capture: reject the attempt and block atomically. */
export async function rejectNativeReviewCapture(input: {
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
