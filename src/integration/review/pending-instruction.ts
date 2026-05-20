/**
 * @module integration/review/pending-instruction
 * @description LLM-visible pending review instructions for external transports.
 *
 * These strings are transport guidance only. Review completion still requires
 * validated, obligation-bound ReviewFindings through the existing evidence
 * binding pipeline.
 */

import { REVIEWER_SUBAGENT_TYPE } from '../../shared/flowguard-identifiers.js';
import type { ReviewObligation } from '../../state/evidence.js';
import type { ReviewHostPlatform, ReviewOrchestrationMode } from './orchestration-mode.js';

export interface PendingReviewInstructionInput {
  readonly mode: ReviewOrchestrationMode;
  readonly platform: ReviewHostPlatform;
  readonly reviewKind: 'plan' | 'implementation' | 'architecture' | 'review';
  readonly obligation: ReviewObligation | null;
  readonly iteration: number;
  readonly planVersion: number;
  readonly subjectLabel: string;
}

export interface PendingReviewInstruction {
  readonly reviewInvocation: {
    readonly mode: ReviewOrchestrationMode;
    readonly platform: ReviewHostPlatform;
    readonly status: 'pending_review' | 'manual_attested_required' | 'unsupported_blocked';
    readonly reviewerSubagentType: typeof REVIEWER_SUBAGENT_TYPE;
    readonly authority: 'review_obligation_evidence_binding';
    readonly obligationId?: string;
    readonly requiredReviewAttestation?: {
      readonly reviewedBy: typeof REVIEWER_SUBAGENT_TYPE;
      readonly mandateDigest: string;
      readonly criteriaVersion: string;
      readonly toolObligationId: string;
      readonly iteration: number;
      readonly planVersion: number;
    };
  };
  readonly next: string;
}

function platformAction(platform: ReviewHostPlatform): string {
  if (platform === 'claude-code') {
    return `invoke the ${REVIEWER_SUBAGENT_TYPE} native Claude Code agent`;
  }
  if (platform === 'codex') {
    return `invoke the ${REVIEWER_SUBAGENT_TYPE} native Codex subagent`;
  }
  return `invoke the ${REVIEWER_SUBAGENT_TYPE} reviewer`;
}

function attestationText(input: PendingReviewInstructionInput): string {
  const obligation = input.obligation;
  if (!obligation) return 'No review obligation is available; FlowGuard remains blocked.';
  return (
    `Required attestation: reviewedBy=${REVIEWER_SUBAGENT_TYPE}, ` +
    `mandateDigest=${obligation.mandateDigest}, criteriaVersion=${obligation.criteriaVersion}, ` +
    `toolObligationId=${obligation.obligationId}, iteration=${input.iteration}, ` +
    `planVersion=${input.planVersion}.`
  );
}

export function buildPendingReviewInstruction(
  input: PendingReviewInstructionInput,
): PendingReviewInstruction {
  const obligation = input.obligation;
  const base = {
    mode: input.mode,
    platform: input.platform,
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
          },
        }
      : {}),
  };

  if (input.mode === 'unsupported_blocked') {
    return {
      reviewInvocation: { ...base, status: 'unsupported_blocked' },
      next:
        'UNSUPPORTED_REVIEW_TRANSPORT: FlowGuard cannot verify a native reviewer transport on this platform. ' +
        'The session remains blocked until a policy-gated manual_attested ReviewFindings path is available. ' +
        'flowguard_decision is not independent review evidence.',
    };
  }

  if (input.mode === 'manual_attested_required') {
    return {
      reviewInvocation: { ...base, status: 'manual_attested_required' },
      next:
        'MANUAL_ATTESTED_REVIEW_REQUIRED: Provide bindable ReviewFindings with the required obligation attestation. ' +
        'A human flowguard_decision may satisfy a user gate but never replaces independent ReviewFindings. ' +
        `${attestationText(input)}`,
    };
  }

  if (input.mode === 'external_instruction_pending') {
    return {
      reviewInvocation: { ...base, status: 'pending_review' },
      next:
        `PENDING_REVIEW: ${platformAction(input.platform)} to review the ${input.subjectLabel}. ` +
        'Native Claude/Codex reviewer agents are transport/isolation artifacts only; review completion still requires validated, obligation-bound ReviewFindings. ' +
        `${attestationText(input)} ` +
        'The reviewer must submit findings via flowguard_review or return complete ReviewFindings for submission. ' +
        'flowguard_decision and copied file presence are not review evidence.',
    };
  }

  return {
    reviewInvocation: { ...base, status: 'pending_review' },
    next:
      `INDEPENDENT_REVIEW_REQUIRED: Before submitting your review verdict, you MUST call the ${REVIEWER_SUBAGENT_TYPE} subagent via the Task tool. ` +
      `Use subagent_type "${REVIEWER_SUBAGENT_TYPE}" with a prompt that includes the ${input.subjectLabel}, ` +
      `iteration=${input.iteration}, and planVersion=${input.planVersion}. ` +
      'Parse the JSON ReviewFindings from the subagent response and submit the exact reviewFindings object.',
  };
}
