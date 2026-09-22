/**
 * @module integration/tools/implementation/implement-review-recovery
 * @description Typed transport recovery for the pending implementation review.
 *
 * The recovery intent exists only on `flowguard_review_implementation`:
 *
 *   awaiting_task          -> re-emit the dispatch for the SAME current attempt
 *   interrupted_dispatch   -> durably re-arm a fresh attempt on the SAME frozen
 *                             obligation/subject (spent attempt staled)
 *   everything else        -> fail closed; no synthetic reconstruction of
 *                             review authority from persisted material
 */

import { formatBlocked } from '../../blocked-result.js';
import { enrichWithWorkflowDirective, writeStateWithArtifacts } from '../helpers.js';
import type { SessionState } from '../../../state/schema.js';
import { resolveReviewContinuation } from '../../../state/review-continuation.js';
import { buildInterruptedDispatchRearm } from '../../review/dispatch/durable-dispatch.js';
import {
  resolveReviewDispatchAuthority,
  reviewObligationResponseFields,
} from '../../review/dispatch/dispatch-authority.js';
import type { ReviewDispatchAuthority } from '../../review/dispatch/dispatch-authority.js';
import type { ImplementRuntime } from './implement-shared.js';
import { buildImplementationReviewInstruction } from '../implementation-review-activation.js';

function buildImplementationRecoveryResponse(
  runtime: ImplementRuntime,
  authority: ReviewDispatchAuthority,
  status: string,
): string {
  const instruction = buildImplementationReviewInstruction(authority);
  const response: Record<string, unknown> = {
    phase: runtime.state.phase,
    status,
    reviewMode: 'subagent',
    ...reviewObligationResponseFields(authority),
    reviewDispatch: instruction.reviewDispatch,
    reviewInvocation: instruction,
    _audit: { transitions: [] },
  };
  return JSON.stringify(enrichWithWorkflowDirective(response, runtime.state));
}

/**
 * Typed transport recovery for the pending implementation review.
 *
 * `awaiting_task`  — re-emit the dispatch for the SAME current attempt.
 * `interrupted_dispatch` — durably re-arm a fresh attempt on the SAME frozen
 * obligation/subject; the spent attempt is staled by the re-arm.
 * Everything else fails closed: no synthetic reconstruction of review
 * authority from persisted material.
 */
export async function handleTransportRecovery(runtime: ImplementRuntime): Promise<string> {
  const continuation = resolveReviewContinuation(runtime.state.reviewAssurance, 'implement');
  if (continuation.kind === 'awaiting_task') {
    const authority = resolveReviewDispatchAuthority(
      runtime.state.reviewAssurance,
      continuation.obligation.obligationId,
    );
    if (authority.kind === 'blocked') {
      return formatBlocked(authority.code, { reason: authority.reason });
    }
    return buildImplementationRecoveryResponse(
      runtime,
      authority.authority,
      'Reviewer transport retry: the current review attempt remains authorized; dispatch the visible native reviewer Task.',
    );
  }
  if (continuation.kind === 'interrupted_dispatch') {
    const spent = runtime.state.reviewAssurance?.attempts.find(
      (attempt) => attempt.attemptId === continuation.attemptId,
    );
    if (!spent) {
      return formatBlocked('REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE', {
        obligationId: continuation.obligation.obligationId,
        reason: 'the interrupted reviewer attempt is absent from review assurance',
      });
    }
    const rearmed = buildInterruptedDispatchRearm(
      runtime.state.reviewAssurance,
      spent,
      runtime.ctx.now(),
    );
    if (rearmed.kind === 'blocked') {
      return formatBlocked('REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE', {
        obligationId: continuation.obligation.obligationId,
        reason: rearmed.reason,
      });
    }
    const persistedState: SessionState = { ...runtime.state, reviewAssurance: rearmed.assurance };
    await writeStateWithArtifacts(runtime.sessDir, persistedState);
    const authority = resolveReviewDispatchAuthority(
      rearmed.assurance,
      continuation.obligation.obligationId,
    );
    if (authority.kind === 'blocked') {
      return formatBlocked(authority.code, { reason: authority.reason });
    }
    return buildImplementationRecoveryResponse(
      { ...runtime, state: persistedState },
      authority.authority,
      'Reviewer transport was interrupted; a fresh review attempt was re-armed on the same frozen implementation subject.',
    );
  }
  if (continuation.kind === 'integrity_blocked') {
    return formatBlocked(continuation.code, {
      obligationId: continuation.obligation.obligationId,
      reason: continuation.reason,
    });
  }
  if (continuation.kind === 'awaiting_verdict') {
    return formatBlocked('SUBAGENT_REVIEW_NOT_INVOKED', {
      obligationId: continuation.obligation.obligationId,
      reason:
        'reviewer evidence is already bound; submit the reviewer verdict instead of a transport retry',
    });
  }
  const obligationId = 'obligation' in continuation ? continuation.obligation.obligationId : null;
  return formatBlocked('REVIEW_ATTEMPT_UNAVAILABLE', {
    ...(obligationId ? { obligationId } : {}),
    reason: `no safe review dispatch can be reconstructed (${continuation.kind}); the review authority must be restored or the session aborted`,
  });
}
