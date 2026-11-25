/**
 * @module integration/review/native-review-findings
 * @description Obligation-bound findings contract, capture-gate validation and
 * audit intents for the native same-child reviewer capture.
 *
 * Reviewer text is never findings authority: only the strict same-child JSON
 * payload is validated here before the canonical evidence recorder binds it.
 */

import { REVIEWER_SUBAGENT_TYPE } from '../../../shared/flowguard-identifiers.js';
import { ReviewFindings as ReviewFindingsSchema } from '../../../state/evidence.js';
import type { ReviewObligation } from '../../../state/evidence.js';
import type { SessionState } from '../../../state/schema.js';
import { validatePipelineAttestation } from '../shared-helpers.js';
import { validateChallengeConsistency } from '../enforcement/challenge-consistency.js';
import { collectPreviouslyUsedChallengeIds } from '../obligations/challenge-history.js';
import { projectImplementationChallengeResolutionRequirements } from '../../../state/implementation-review-findings.js';
import type { ObligationFindingsSchemaContract } from '../evidence/findings-schema.js';
import { buildReviewChallengeContract } from '../obligations/challenge-contract.js';
import type { PersistedState } from './native-review-types.js';

/**
 * Semantic audit intents for one bound native review invocation.
 *
 * The settlement event reflects the ACTUAL persisted outcome: a plan/ADR
 * unreviewable verdict closes the obligation as blocked, and the audit trail
 * must not report that as a fulfilled obligation.
 */
export function nativeReviewAuditIntents(input: {
  obligation: ReviewObligation;
  parentSessionId: string;
  childSessionId: string;
  attemptId: string;
  promptHash: string;
  findingsHash: string;
  phase: SessionState['phase'];
}) {
  return (_result: 'fulfilled' | 'reused', state: SessionState, occurredAt: string) => {
    const settled = state.reviewAssurance?.obligations.find(
      (item) => item.obligationId === input.obligation.obligationId,
    );
    return [
      {
        phase: input.phase,
        event: 'review:subagent_invoked',
        occurredAt,
        detail: {
          obligationId: input.obligation.obligationId,
          obligationType: input.obligation.obligationType,
          parentSessionId: input.parentSessionId,
          childSessionId: input.childSessionId,
          agentType: REVIEWER_SUBAGENT_TYPE,
          attemptId: input.attemptId,
          promptHash: input.promptHash,
          findingsHash: input.findingsHash,
          invocationMode: 'native_subagent_message_json',
          hostVisible: true,
          transcriptNavigable: true,
          validationAuthority: 'flowguard',
          reviewAssuranceLevel: 'host_message_validated',
        },
      },
      settled?.status === 'blocked'
        ? {
            phase: input.phase,
            event: 'review:obligation_blocked',
            occurredAt,
            detail: {
              obligationId: input.obligation.obligationId,
              childSessionId: input.childSessionId,
              blockedCode: settled.blockedCode,
            },
          }
        : {
            phase: input.phase,
            event: 'review:obligation_fulfilled',
            occurredAt,
            detail: {
              obligationId: input.obligation.obligationId,
              childSessionId: input.childSessionId,
            },
          },
    ] as const;
  };
}

/**
 * The exact-equality facts of the capture gate, derived ONCE per capture from
 * the same persisted snapshot that `validateCapturedFindings` validates
 * against. The serialization schema and the gate therefore cannot enforce
 * different contracts.
 */
export function obligationCaptureContract(
  state: PersistedState,
  obligation: ReviewObligation,
): ObligationFindingsSchemaContract {
  return {
    obligationId: obligation.obligationId,
    iteration: obligation.iteration,
    planVersion: obligation.planVersion,
    requiredChallengeCount: obligation.requiredChallengeCount,
    requiredChallengeKind: obligation.requiredChallengeKind,
    allowedEvidenceRefs: buildReviewChallengeContract(state, obligation)?.evidenceRefs,
  };
}

/**
 * #747 resolution requirements projected for the capture gate. Derived from
 * persisted state only, mirroring the tool consumption boundary
 * (`implement-review-state.ts`) through the shared state authority.
 */
function implementResolutionRequirements(state: PersistedState) {
  const requirements = projectImplementationChallengeResolutionRequirements({
    findingsHistory: state.implReviewFindings,
    challengeResolutions: state.challengeResolutions,
    implementationDigest: state.implementation?.digest,
  });
  return {
    unresolvedImplementationChallengeIds: requirements.targetedResolutionIds,
    unaddressedPriorFailIds: requirements.unaddressedPriorFailIds,
  };
}

export function validateCapturedFindings(
  state: PersistedState,
  obligation: ReviewObligation,
  prepared: Record<string, unknown>,
) {
  const findings = ReviewFindingsSchema.parse(prepared);
  const attestation = validatePipelineAttestation(
    {
      reviewMode: findings.reviewMode,
      ...(findings.attestation !== undefined ? { attestation: findings.attestation } : {}),
      overallVerdict: findings.overallVerdict,
    },
    {
      obligationId: obligation.obligationId,
      criteriaVersion: obligation.criteriaVersion,
      mandateDigest: obligation.mandateDigest,
      iteration: obligation.iteration,
      planVersion: obligation.planVersion,
      checkReviewedBy: true,
      checkUnableToReview: false,
    },
  );
  if (!attestation.valid) {
    return {
      kind: 'blocked' as const,
      code: attestation.code,
      reason: 'Reviewer attestation mismatch.',
    };
  }
  const { allowedEvidenceRefs } = obligationCaptureContract(state, obligation);
  const resolutionVerdicts = findings.challengeResolutionVerdicts;
  const challenge = validateChallengeConsistency({
    overallVerdict: findings.overallVerdict,
    requiredChallengeCount: obligation.requiredChallengeCount,
    requiredChallengeKind: obligation.requiredChallengeKind ?? 'implementation_challenge',
    challenges: findings.challenges,
    expectedObligationId: obligation.obligationId,
    ...(allowedEvidenceRefs !== undefined ? { allowedEvidenceRefs } : {}),
    ...(resolutionVerdicts !== undefined ? { resolutionVerdicts } : {}),
    previouslyUsedChallengeIds: collectPreviouslyUsedChallengeIds(state),
    // The capture gate must enforce the SAME #747 resolution requirements the
    // tool consumption boundary later enforces. Without these sets the capture
    // would accept an `accept` verdict while a prior failing challenge is
    // unaddressed, or reject the very verdicts consumption requires — the
    // repair loop could not converge. Targets are derived from persisted state
    // only; a resolution recorded after dispatch is NOT in the reviewer prompt
    // and a missing verdict for it therefore fails closed here.
    ...(obligation.obligationType === 'implement' ? implementResolutionRequirements(state) : {}),
  });
  if (!challenge.ok) {
    return {
      kind: 'blocked' as const,
      code: challenge.code,
      reason: JSON.stringify(challenge.details),
      details: challenge.details,
    };
  }
  return { kind: 'valid' as const, findings };
}
