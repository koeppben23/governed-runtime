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

/**
 * Machine-actionable metadata for a host-created reviewer child session; never
 * a reviewer prompt. On OpenCode the parent calls native Task with only the
 * reviewer identity/description. The plugin injects the canonical frozen prompt
 * at the Task before-hook, so model-authored prompt bytes never become review
 * authority.
 */
export function buildChildSessionReviewInstruction(input: ChildSessionReviewInstructionInput) {
  const obligation = input.obligation;
  const status = input.mode === 'unsupported_blocked' ? 'unsupported_blocked' : 'pending_review';
  const nativeTask =
    input.mode === 'host_structured' && input.platform === 'opencode'
      ? {
          transport: 'native_task_structured_followup' as const,
          action: 'call_task' as const,
          task: {
            tool: 'task' as const,
            subagentType: REVIEWER_SUBAGENT_TYPE as typeof REVIEWER_SUBAGENT_TYPE,
            description: 'FlowGuard independent review' as const,
            promptAuthority: 'host_injected_frozen_review_material' as const,
            findingsAuthority: 'same_child_json_schema_followup' as const,
          },
        }
      : {};
  const metadata = {
    mode: input.mode,
    platform: input.platform,
    status,
    reviewerSubagentType: REVIEWER_SUBAGENT_TYPE as typeof REVIEWER_SUBAGENT_TYPE,
    authority: 'review_obligation_evidence_binding' as const,
    ...nativeTask,
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
