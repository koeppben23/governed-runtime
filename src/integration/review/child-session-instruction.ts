import { REVIEWER_SUBAGENT_TYPE } from '../../shared/flowguard-identifiers.js';
import type { ReviewObligation } from '../../state/evidence.js';
import type { ReviewHostPlatform, ReviewOrchestrationMode } from './orchestration-mode.js';
import { reviewDispatchRequired } from './dispatch-signal.js';

export interface ChildSessionReviewInstructionInput {
  readonly mode: ReviewOrchestrationMode;
  readonly platform: ReviewHostPlatform;
  readonly obligation: ReviewObligation | null;
  readonly iteration: number;
  readonly planVersion: number;
  readonly observationCapability?: string;
}

/** Metadata for a host-created reviewer child session; never a reviewer prompt. */
export function buildChildSessionReviewInstruction(input: ChildSessionReviewInstructionInput) {
  const obligation = input.obligation;
  const status = input.mode === 'unsupported_blocked' ? 'unsupported_blocked' : 'pending_review';
  const metadata = {
    mode: input.mode,
    platform: input.platform,
    status,
    reviewerSubagentType: REVIEWER_SUBAGENT_TYPE as typeof REVIEWER_SUBAGENT_TYPE,
    authority: 'review_obligation_evidence_binding' as const,
    ...(obligation ? { obligationId: obligation.obligationId } : {}),
    ...(obligation
      ? {
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
        }
      : {}),
  };
  return {
    ...metadata,
    reviewDispatch: reviewDispatchRequired(),
  };
}
