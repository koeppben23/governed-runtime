/**
 * @module integration/tools/implementation/implement-review-recovery
 * @description Typed transport recovery for the pending implementation review.
 *
 * The implementation-specific projection lives here; the dispatch-ledger
 * transitions are owned by the shared `review-transport-recovery` handler.
 *
 *   awaiting_task          -> re-emit the dispatch for the SAME current attempt
 *   interrupted_dispatch   -> durably re-arm a fresh attempt on the SAME frozen
 *                             obligation/subject (spent attempt staled)
 *   everything else        -> fail closed; no synthetic reconstruction of
 *                             review authority from persisted material
 */

import { enrichWithWorkflowDirective } from '../helpers.js';
import { reviewObligationResponseFields } from '../../review/dispatch/dispatch-authority.js';
import type { ReviewDispatchAuthority } from '../../review/dispatch/dispatch-authority.js';
import type { ImplementRuntime } from './implement-shared.js';
import { buildImplementationReviewInstruction } from '../implementation-review-activation.js';
import { handleReviewTransportRecovery } from '../review-transport-recovery.js';

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
  return handleReviewTransportRecovery({
    state: runtime.state,
    sessDir: runtime.sessDir,
    now: runtime.ctx.now(),
    obligationType: 'implement',
    buildResponse: (status, authority) =>
      buildImplementationRecoveryResponse(runtime, authority, status),
  });
}
