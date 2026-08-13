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
import { renderReviewContext, renderReviewerTaskPrompt } from './prompt-builders.js';

export interface PendingReviewInstructionInput {
  readonly mode: ReviewOrchestrationMode;
  readonly platform: ReviewHostPlatform;
  readonly reviewKind: 'plan' | 'implementation' | 'architecture' | 'review';
  readonly obligation: ReviewObligation | null;
  readonly iteration: number;
  readonly planVersion: number;
  readonly subjectLabel: string;
  /**
   * Persisted, advisory ProofGraph context lines (#762) from
   * {@link buildReviewerProofContext}. Threaded from the calling tool so the
   * copy-ready Task prompt carries the same claim context as the SDK path.
   */
  readonly proofContext?: readonly string[];
  /**
   * Opaque host-minted observation capability of the attempt the reviewer Task
   * will bind to. Renders the Repository Observation Contract into the
   * copy-ready prompt and the attestation. Absent → repository evidence is
   * unavailable for this attempt.
   */
  readonly observationCapability?: string;
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
      /** Opaque host-minted observation capability of the bound attempt. */
      readonly observationCapability?: string;
    };
  };
  readonly next: string;
  /**
   * Canonical, verbatim copy-ready reviewer Task prompt (F10). Present only when
   * an obligation is available. The agent should paste this as the Task tool
   * "prompt" argument so the required review context is present on the first
   * attempt instead of being free-composed and omitted.
   */
  readonly reviewerTaskPrompt?: string;
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

function buildHostTaskPrompt(
  input: PendingReviewInstructionInput,
  obligation: ReviewObligation,
): string {
  return renderReviewerTaskPrompt({
    iteration: input.iteration,
    planVersion: input.planVersion,
    obligationId: obligation.obligationId,
    mandateDigest: obligation.mandateDigest,
    criteriaVersion: obligation.criteriaVersion,
    subjectLabel: input.subjectLabel,
    observationCapability: input.observationCapability,
    challengeContract:
      obligation.requiredChallengeCount === undefined
        ? undefined
        : {
            requiredChallengeCount: obligation.requiredChallengeCount,
            requiredChallengeKind: obligation.requiredChallengeKind,
          },
    proofContext: input.proofContext,
  });
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
            ...(input.observationCapability
              ? { observationCapability: input.observationCapability }
              : {}),
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

  // Default = host_task_sync (host-orchestrated): the plugin captures the
  // reviewer's findings as invocation evidence and resolves them automatically.
  // The agent must submit ONLY the verdict; submitting, copying, or altering
  // reviewFindings here causes a session/hash mismatch rejection. The review
  // verdict is the independent reviewer's result, NEVER a user approval.
  //
  // F10: when an obligation is available, hand the agent a canonical, verbatim
  // copy-ready reviewer prompt (built by the same renderReviewContext serializer
  // the enforcement matcher validates against) so the required context is present
  // on the first Task attempt instead of being free-composed and omitted.
  const reviewerTaskPrompt = obligation ? buildHostTaskPrompt(input, obligation) : undefined;
  return {
    reviewInvocation: { ...base, status: 'pending_review' },
    next:
      `INDEPENDENT_REVIEW_REQUIRED: Before submitting your review verdict, you MUST call the ${REVIEWER_SUBAGENT_TYPE} subagent via the Task tool. ` +
      `Use subagent_type "${REVIEWER_SUBAGENT_TYPE}" with a prompt that includes the ${input.subjectLabel}, ` +
      `${renderReviewContext({ iteration: input.iteration, planVersion: input.planVersion })}. ` +
      (reviewerTaskPrompt
        ? 'A ready-to-use reviewer prompt is provided in the reviewerTaskPrompt field — pass it VERBATIM as the Task tool "prompt" argument (append the artifact content), so the required review context is present on the first attempt. '
        : '') +
      'After the reviewer returns, submit ONLY the verdict via reviewVerdict; the plugin resolves the reviewer findings from captured evidence automatically. ' +
      'Do NOT submit, copy, or alter reviewFindings in host-task mode — hand-edited or mismatched findings are rejected (SUBAGENT_SESSION_MISMATCH / findings hash mismatch). ' +
      'reviewVerdict records the independent reviewer result; it is NOT user approval and only advances to the human review gate. ' +
      'Only the user approves the presented artifact via flowguard_decision (/review-decision).',
    ...(reviewerTaskPrompt ? { reviewerTaskPrompt } : {}),
  };
}
