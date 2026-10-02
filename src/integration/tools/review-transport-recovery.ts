/**
 * @module integration/tools/review-transport-recovery
 * @description Shared typed transport recovery for a pending review dispatch.
 *
 * The `reviewRecovery: 'retry_transport'` intent is a cross-command operation:
 * plan, architecture, and implementation all re-emit or durably re-arm their
 * frozen review obligation without minting a new artifact revision. The
 * command contexts supply only the family and their response builder; the
 * dispatch ledger transitions stay here.
 *
 *   awaiting_task          -> re-emit the dispatch for the SAME current attempt
 *   interrupted_dispatch   -> durably re-arm a fresh attempt on the SAME frozen
 *                             obligation/subject (spent attempt staled; works
 *                             for a still-created interrupted release AND for
 *                             an already-staled spent attempt)
 *   everything else        -> fail closed; no synthetic reconstruction of
 *                             review authority from persisted material
 *
 * @version v1
 */

import { formatBlocked } from '../blocked-result.js';
import type { ReviewObligationType } from '../../state/evidence.js';
import type { SessionState } from '../../state/schema.js';
import { resolveReviewContinuation } from '../../state/review-continuation.js';
import { buildInterruptedDispatchRearm } from '../review/dispatch/durable-dispatch.js';
import {
  resolveReviewDispatchAuthority,
  type ReviewDispatchAuthority,
} from '../review/dispatch/dispatch-authority.js';
import { writeStateWithArtifacts } from './helpers.js';

export interface ReviewTransportRecoveryInput {
  readonly state: SessionState;
  readonly sessDir: string;
  readonly now: string;
  readonly obligationType: ReviewObligationType;
  /** Command-specific response projection for the still-authorized authority. */
  readonly buildResponse: (status: string, authority: ReviewDispatchAuthority) => string;
}

/** Human subject noun for the re-arm status; family-specific, never authority. */
function frozenSubjectNoun(obligationType: ReviewObligationType): string {
  switch (obligationType) {
    case 'plan':
      return 'plan';
    case 'architecture':
      return 'architecture';
    case 'implement':
      return 'implementation';
    case 'review':
      return 'review';
  }
}

/**
 * Typed transport recovery for the pending review of one obligation family.
 *
 * `awaiting_task`  — re-emit the dispatch for the SAME current attempt.
 * `interrupted_dispatch` — durably re-arm a fresh attempt on the SAME frozen
 * obligation/subject; the spent attempt is staled by the re-arm.
 * Everything else fails closed: no synthetic reconstruction of review
 * authority from persisted material.
 */
export async function handleReviewTransportRecovery(
  input: ReviewTransportRecoveryInput,
): Promise<string> {
  const { state, sessDir, now, obligationType, buildResponse } = input;
  const continuation = resolveReviewContinuation(state.reviewAssurance, obligationType);
  if (continuation.kind === 'awaiting_task') {
    const authority = resolveReviewDispatchAuthority(
      state.reviewAssurance,
      continuation.obligation.obligationId,
    );
    if (authority.kind === 'blocked') {
      return formatBlocked(authority.code, { reason: authority.reason });
    }
    return buildResponse(
      'Reviewer transport retry: the current review attempt remains authorized; dispatch the visible native reviewer Task.',
      authority.authority,
    );
  }
  if (continuation.kind === 'interrupted_dispatch') {
    const spent = state.reviewAssurance?.attempts.find(
      (attempt) => attempt.attemptId === continuation.attemptId,
    );
    if (!spent) {
      return formatBlocked('REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE', {
        obligationId: continuation.obligation.obligationId,
        reason: 'the interrupted reviewer attempt is absent from review assurance',
      });
    }
    const rearmed = buildInterruptedDispatchRearm(state.reviewAssurance, spent, now);
    if (rearmed.kind === 'blocked') {
      return formatBlocked('REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE', {
        obligationId: continuation.obligation.obligationId,
        reason: rearmed.reason,
      });
    }
    const persistedState: SessionState = { ...state, reviewAssurance: rearmed.assurance };
    await writeStateWithArtifacts(sessDir, persistedState);
    const authority = resolveReviewDispatchAuthority(
      rearmed.assurance,
      continuation.obligation.obligationId,
    );
    if (authority.kind === 'blocked') {
      return formatBlocked(authority.code, { reason: authority.reason });
    }
    return buildResponse(
      `Reviewer transport was interrupted; a fresh review attempt was re-armed on the same frozen ${frozenSubjectNoun(obligationType)} subject.`,
      authority.authority,
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
