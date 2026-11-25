import { REVIEWER_SUBAGENT_TYPE } from '../../../shared/flowguard-identifiers.js';
import type { ReviewOrchestrationMode } from './orchestration-mode.js';
import { reviewDispatchRequired } from '../enforcement/dispatch-signal.js';
import type { ReviewDispatchAuthority } from './dispatch-authority.js';

export interface ChildSessionReviewInstructionInput {
  readonly mode: ReviewOrchestrationMode;
  /** Exact current obligation/attempt authority; a dispatch cannot exist without it. */
  readonly authority: ReviewDispatchAuthority;
  readonly iteration: number;
  readonly planVersion: number;
  readonly observationCapability?: string;
}

/**
 * Machine-actionable metadata for a host-created reviewer child session; never
 * a reviewer prompt. For host_structured review the parent calls its native
 * subagent with only the reviewer identity/description. The host adapter injects
 * the canonical frozen prompt at the native before-hook, so model-authored
 * prompt bytes never become review authority.
 */
export function buildChildSessionReviewInstruction(input: ChildSessionReviewInstructionInput) {
  const obligation = input.authority.obligation;
  const status = input.mode === 'unsupported_blocked' ? 'unsupported_blocked' : 'pending_review';
  const nativeSubagent =
    input.mode === 'host_structured'
      ? {
          transport: 'native_subagent' as const,
          action: 'call_subagent' as const,
          subagent: {
            tool: 'subagent' as const,
            agent: REVIEWER_SUBAGENT_TYPE as typeof REVIEWER_SUBAGENT_TYPE,
            background: false,
            description: 'FlowGuard independent review' as const,
            promptAuthority: 'host_injected_frozen_review_material' as const,
            findingsAuthority: 'blocked_pending_native_capture' as const,
          },
        }
      : {};
  const metadata = {
    mode: input.mode,
    status,
    reviewerAgent: REVIEWER_SUBAGENT_TYPE as typeof REVIEWER_SUBAGENT_TYPE,
    authority: 'review_obligation_evidence_binding' as const,
    ...nativeSubagent,
    obligationId: obligation.obligationId,
    reviewAttemptId: input.authority.attempt.attemptId,
    requiredReviewAttestation: {
      reviewedBy: REVIEWER_SUBAGENT_TYPE as typeof REVIEWER_SUBAGENT_TYPE,
      mandateDigest: obligation.mandateDigest,
      criteriaVersion: obligation.criteriaVersion,
      toolObligationId: obligation.obligationId,
      iteration: input.iteration,
      planVersion: input.planVersion,
      ...(input.observationCapability
        ? { observationCapability: input.observationCapability }
        : {}),
    },
  };
  return {
    ...metadata,
    reviewDispatch: reviewDispatchRequired(),
  };
}
