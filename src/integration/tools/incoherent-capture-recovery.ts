/**
 * @module integration/tools/incoherent-capture-recovery
 * @description Shared tool-boundary interception for F12 incoherent reviewer
 *              captures.
 *
 * `resolveStructuredEffectiveFindings` fails closed with
 * `SUBAGENT_VERDICT_FINDINGS_INCOHERENT` when the host-captured reviewer record
 * contradicts itself (an `accept` verdict that still carries blocking issues).
 * Because the capture COMPLETED — attempt bound, invocation persisted, durable
 * dispatch completed — the originating command may re-arm one fresh attempt on
 * the SAME frozen obligation instead of dead-ending the flow.
 *
 * Command families supply only their canonical review-required response builder;
 * the bounded re-arm decision, the atomic persistence, and the dispatch
 * authority resolution stay here.
 *
 * @version v1
 */

import { formatBlocked } from '../blocked-result.js';
import { getAdapterLogger } from '../../logging/adapter-logger.js';
import type { SessionState } from '../../state/schema.js';
import type { ReviewValidationFailure } from '../review/validation/review-validation-failure.js';
import { logStructuredResolutionDiagnostics } from '../review/validation/review-validation-failure.js';
import { buildIncoherentCaptureRearm } from '../review/obligations/incoherent-capture-rearm.js';
import {
  resolveReviewDispatchAuthority,
  type ReviewDispatchAuthority,
} from '../review/dispatch/dispatch-authority.js';
import { writeStateWithArtifacts } from './helpers.js';

/** The captured-evidence coherence code the F12 re-arm intercepts. */
const INCOHERENT_CAPTURE_FAILURE_CODE = 'SUBAGENT_VERDICT_FINDINGS_INCOHERENT' as const;

export interface IncoherentCaptureRetryInput {
  /** The structured-resolution failure that blocked the verdict submission. */
  readonly failure: ReviewValidationFailure;
  readonly state: SessionState;
  readonly sessDir: string;
  /** Pending/fulfilled obligation whose captured evidence failed coherence. */
  readonly obligationId: string | undefined;
  readonly now: string;
  /**
   * Family-specific canonical review-required response for the fresh attempt.
   * The fresh state and the exact A2 dispatch authority are supplied; the
   * family builder stays in its command context.
   */
  readonly buildResponse: (state: SessionState, authority: ReviewDispatchAuthority) => string;
}

export type IncoherentCaptureRetryOutcome =
  | { readonly kind: 'rearmed'; readonly response: string }
  | { readonly kind: 'blocked'; readonly response: string }
  | { readonly kind: 'not_applicable' };

/**
 * Intercept one structured-resolution blocked result. Non-F12 failures and
 * F12 failures without a resolvable obligation identity return
 * `not_applicable` so the caller keeps its canonical fail-closed response.
 * An F12 within budget re-arms and persists A2 inside the caller's existing
 * mutable transaction; an F12 outside budget keeps the fail-closed envelope
 * with the budget reason appended.
 */
export async function attemptIncoherentCaptureRetry(
  input: IncoherentCaptureRetryInput,
): Promise<IncoherentCaptureRetryOutcome> {
  if (input.failure.code !== INCOHERENT_CAPTURE_FAILURE_CODE) {
    return { kind: 'not_applicable' };
  }
  if (input.obligationId === undefined) return { kind: 'not_applicable' };

  const rearm = buildIncoherentCaptureRearm({
    assurance: input.state.reviewAssurance,
    obligationId: input.obligationId,
    maxIncoherentReviewerCaptureRetries:
      input.state.policySnapshot.maxIncoherentReviewerCaptureRetries,
    now: input.now,
  });
  if (rearm.kind === 'blocked') {
    logStructuredResolutionDiagnostics(getAdapterLogger(), input.failure.diagnostics ?? []);
    return {
      kind: 'blocked',
      response: formatBlocked(
        input.failure.code,
        { ...input.failure.vars },
        {
          rearmBlockedReason: rearm.reason,
        },
      ),
    };
  }

  const nextState: SessionState = { ...input.state, reviewAssurance: rearm.assurance };
  const persisted = await writeStateWithArtifacts(input.sessDir, nextState);
  const authority = resolveReviewDispatchAuthority(persisted.reviewAssurance, input.obligationId);
  if (authority.kind === 'blocked') {
    return {
      kind: 'blocked',
      response: formatBlocked(authority.code, { reason: authority.reason }),
    };
  }
  return { kind: 'rearmed', response: input.buildResponse(persisted, authority.authority) };
}
