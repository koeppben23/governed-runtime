/**
 * @module integration/review/native-task-review-bindings
 * @description Observation replay, findings validation, and evidence binding for
 * the native reviewer Task transport.
 *
 * The free-form Task text is never findings authority: only same-child
 * structured output is validated and bound here.
 */

import { readState } from '../../../adapters/persistence.js';
import { REVIEWER_SUBAGENT_TYPE } from '../../../shared/flowguard-identifiers.js';
import { ReviewFindings as ReviewFindingsSchema } from '../../../state/evidence.js';
import type { ReviewObligation } from '../../../state/evidence.js';
import type { SessionState } from '../../../state/schema.js';
import { hashFindings } from '../obligations/assurance.js';
import { validatePipelineAttestation } from '../shared-helpers.js';
import { validateChallengeConsistency } from '../enforcement/challenge-consistency.js';
import { collectPreviouslyUsedChallengeIds } from '../obligations/challenge-history.js';
import { recordEvidenceOrBlockReuse } from '../evidence/reviewer-evidence-recorder.js';
import { replayAndPersistObservations } from '../observations/observation-replay-persist.js';
import { captureStructuredFindingsFromVisibleChild } from '../obligations/structured-followup.js';
import { prepareReviewerFindingsForValidation } from '../enforcement/prepare-findings.js';
import { buildReviewChallengeContract } from '../obligations/challenge-contract.js';
import type { ReviewerSuccessResult } from '../types.js';
import type { OrchestratorDeps } from '../pipeline-types.js';
import type { ReplayPersistDeps } from '../observations/observation-replay-persist.js';
import type { NativeReviewLineage, PersistedState } from './native-task-review-types.js';

/**
 * Structural host-runtime port for the native reviewer Task transport.
 *
 * review/ must not import plugin-* (FG-QUAL-002); the host caller passes its
 * full runtime, which satisfies this subset structurally.
 */
export interface NativeReviewRuntimePort {
  readonly orchestratorDeps: OrchestratorDeps;
  readonly log: ReplayPersistDeps['log'];
  readonly logError: ReplayPersistDeps['logError'];
}

function nativeAuditIntents(input: {
  obligation: ReviewObligation;
  parentSessionId: string;
  childSessionId: string;
  attemptId: string;
  promptHash: string;
  findingsHash: string;
  phase: SessionState['phase'];
}) {
  return (_result: 'fulfilled' | 'reused', _state: SessionState, occurredAt: string) =>
    [
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
          invocationMode: 'native_task_structured_followup',
          hostVisible: true,
          transcriptNavigable: true,
          structuredOutputUsed: true,
          reviewAssuranceLevel: 'structured_high',
        },
      },
      {
        phase: input.phase,
        event: 'review:obligation_fulfilled',
        occurredAt,
        detail: {
          obligationId: input.obligation.obligationId,
          childSessionId: input.childSessionId,
        },
      },
    ] as const;
}

export async function resolveNativeReviewLineage(
  runtime: NativeReviewRuntimePort,
  sessDir: string,
  callId: string,
): Promise<NativeReviewLineage | null> {
  const state = await readState(sessDir);
  const assurance = state?.reviewAssurance;
  if (!state || !assurance) return null;
  const dispatch = assurance.dispatches.find(
    (item) => item.hostCallId === callId && item.dispatchStatus === 'authorized',
  );
  if (!dispatch) return null;
  const attempt = assurance.attempts.find((item) => item.attemptId === dispatch.attemptId);
  if (!attempt) return null;
  const obligation = assurance.obligations.find(
    (item) => item.obligationId === dispatch.obligationId,
  );
  if (!obligation) return null;
  return { state, dispatch, attempt, obligation };
}

export async function persistReviewerObservations(
  runtime: NativeReviewRuntimePort,
  sessionId: string,
  attemptId: string,
  childSessionId: string,
): Promise<void> {
  await replayAndPersistObservations(
    {
      getSessionDir: runtime.orchestratorDeps.getSessionDir,
      updateReviewAssurance: runtime.orchestratorDeps.updateReviewAssurance,
      log: runtime.log,
      logError: runtime.logError,
    },
    readState,
    { sessionId, attemptId, childSessionId, now: new Date().toISOString() },
  );
}

export async function capturePreparedFindings(
  runtime: NativeReviewRuntimePort,
  obligation: ReviewObligation,
  childSessionId: string,
): Promise<
  | { readonly kind: 'blocked'; readonly code: string; readonly reason: string }
  | {
      readonly kind: 'captured';
      readonly prepared: Record<string, unknown>;
      readonly fulfilledAt: string;
    }
> {
  const structured = await captureStructuredFindingsFromVisibleChild(
    runtime.orchestratorDeps.client,
    { childSessionId, obligationId: obligation.obligationId },
  );
  if (structured.kind === 'blocked') return structured;
  const prepared = prepareReviewerFindingsForValidation({
    rawFindings: structured.findings,
    obligationId: obligation.obligationId,
    hostConstants: {
      mandateDigest: obligation.mandateDigest,
      criteriaVersion: obligation.criteriaVersion,
    },
    hostProvenance: { childSessionId, reviewedAt: structured.fulfilledAt },
  });
  if (!prepared.ok) {
    return {
      kind: 'blocked',
      code: 'HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION',
      reason: prepared.issues.join('; '),
    };
  }
  return { kind: 'captured', prepared: prepared.findings, fulfilledAt: structured.fulfilledAt };
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
  const allowedEvidenceRefs = buildReviewChallengeContract(state, obligation)?.evidenceRefs;
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
  });
  if (!challenge.ok) {
    return {
      kind: 'blocked' as const,
      code: challenge.code,
      reason: JSON.stringify(challenge.details),
    };
  }
  return { kind: 'valid' as const, findings };
}

export async function bindNativeReviewEvidence(input: {
  runtime: NativeReviewRuntimePort;
  sessDir: string;
  sessionId: string;
  callId: string;
  childSessionId: string;
  lineage: NativeReviewLineage;
  prepared: Record<string, unknown>;
  fulfilledAt: string;
  phase: SessionState['phase'];
}) {
  const { obligation, attempt, dispatch } = input.lineage;
  const promptHash = dispatch.canonicalPromptDigest;
  const findingsHash = hashFindings(input.prepared);
  const reviewerResult: ReviewerSuccessResult & { findings: Record<string, unknown> } = {
    sessionId: input.childSessionId,
    rawResponse: JSON.stringify(input.prepared),
    findings: input.prepared,
    reviewOutputMode: 'structured_output',
    structuredOutputUsed: true,
    reviewAssuranceLevel: 'structured_high',
    invokedAt: dispatch.dispatchAuthorizedAt,
    fulfilledAt: input.fulfilledAt,
  };
  return recordEvidenceOrBlockReuse(input.runtime.orchestratorDeps, input.sessDir, {
    obligationId: obligation.obligationId,
    obligationType: obligation.obligationType,
    sessionId: input.sessionId,
    childSessionId: input.childSessionId,
    // Authorized under the Task call ID, bound to the exact child session by
    // the evidence mutation.
    hostCallId: input.childSessionId,
    authorizedHostCallId: input.callId,
    attemptId: attempt.attemptId,
    promptHash,
    findingsHash,
    invokedAt: dispatch.dispatchAuthorizedAt,
    fulfilledAt: input.fulfilledAt,
    reviewerResult,
    semanticIntents: nativeAuditIntents({
      obligation,
      parentSessionId: input.sessionId,
      childSessionId: input.childSessionId,
      attemptId: attempt.attemptId,
      promptHash,
      findingsHash,
      phase: input.phase,
    }),
  });
}
