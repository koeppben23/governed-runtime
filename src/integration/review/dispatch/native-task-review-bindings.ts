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
import { hashFindings } from '../findings-hash.js';
import { validatePipelineAttestation } from '../shared-helpers.js';
import { validateChallengeConsistency } from '../enforcement/challenge-consistency.js';
import { collectPreviouslyUsedChallengeIds } from '../obligations/challenge-history.js';
import { projectImplementationChallengeResolutionRequirements } from '../../../state/implementation-review-findings.js';
import { recordEvidenceOrBlockReuse } from '../evidence/reviewer-evidence-recorder.js';
import { replayAndPersistObservations } from '../observations/observation-replay-persist.js';
import {
  captureStructuredFindingsFromVisibleChild,
  readReviewerTaskCompletion,
  type StructuredFollowupTiming,
} from './structured-followup.js';
import { prepareReviewerFindingsForValidation } from '../enforcement/prepare-findings.js';
import {
  buildObligationFindingsJsonSchema,
  type ObligationFindingsSchemaContract,
} from '../evidence/findings-schema.js';
import { buildReviewChallengeContract } from '../obligations/challenge-contract.js';
import type { PendingReviewRetryDiagnostic, ReviewerSuccessResult } from '../types.js';
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
          invocationMode: 'native_task_structured_followup',
          hostVisible: true,
          transcriptNavigable: true,
          structuredOutputUsed: true,
          reviewAssuranceLevel: 'structured_high',
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
      resolveSessionAuthority: (sid) => runtime.orchestratorDeps.resolveSessionAuthority(sid),
      updateReviewAssurance: runtime.orchestratorDeps.updateReviewAssurance,
      log: runtime.log,
      logError: runtime.logError,
    },
    { sessionId, attemptId, childSessionId, now: new Date().toISOString() },
  );
}

/**
 * Diagnostic-only latency line for the structured follow-up host prompt.
 * Allowlisted identifiers and timing fields only; never content. A logging
 * failure never changes reviewer evidence handling.
 */
function logStructuredFollowupTiming(
  runtime: NativeReviewRuntimePort,
  obligationId: string,
  childSessionId: string,
  timing: StructuredFollowupTiming,
): void {
  try {
    runtime.log.info('orchestrator', 'review structured followup timing', {
      obligationId,
      childSessionId,
      ...timing,
    });
  } catch {
    // Diagnostics only.
  }
}
/**
 * The exact-equality facts of the capture gate, derived ONCE per capture from
 * the same persisted snapshot that `validateCapturedFindings` validates
 * against. The structured follow-up schema and the gate therefore cannot
 * enforce different contracts.
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
 * Offered challenge refs only grow after dispatch (validation attempts are
 * append-only and every other ref is frozen with the obligation), so the gate
 * and the schema never reject a ref the reviewer child was offered. A ref that
 * appeared after the dispatch is surfaced as a diagnostic: the child could not
 * have seen it.
 */
export function refsAddedAfterDispatch(
  state: PersistedState,
  allowedEvidenceRefs: readonly Record<string, unknown>[] | undefined,
  dispatchAuthorizedAt: string,
): readonly string[] {
  const authorizedAt = Date.parse(dispatchAuthorizedAt);
  const attemptIds = new Set(
    (allowedEvidenceRefs ?? [])
      .filter((ref) => ref.kind === 'validation_attempt')
      .map((ref) => String(ref.attemptId)),
  );
  return state.validationAttempts
    .filter(
      (attempt) =>
        attemptIds.has(attempt.attemptId) && Date.parse(attempt.result.executedAt) > authorizedAt,
    )
    .map((attempt) => attempt.attemptId);
}

/** Diagnostic only: surface refs the reviewer child could not have been offered. */
export function logContractGrowthAfterDispatch(
  runtime: NativeReviewRuntimePort,
  state: PersistedState,
  input: {
    readonly obligationId: string;
    readonly childSessionId: string;
    readonly contract: ObligationFindingsSchemaContract;
    readonly dispatchAuthorizedAt: string;
  },
): void {
  const lateRefs = refsAddedAfterDispatch(
    state,
    input.contract.allowedEvidenceRefs,
    input.dispatchAuthorizedAt,
  );
  if (lateRefs.length === 0) return;
  try {
    runtime.log.warn('orchestrator', 'reviewer challenge contract grew after dispatch', {
      obligationId: input.obligationId,
      childSessionId: input.childSessionId,
      attemptIds: lateRefs.join(','),
    });
  } catch {
    // Diagnostic only.
  }
}

export async function capturePreparedFindings(
  runtime: NativeReviewRuntimePort,
  obligation: ReviewObligation,
  childSessionId: string,
  contract: ObligationFindingsSchemaContract,
): Promise<
  | {
      readonly kind: 'blocked';
      readonly code: string;
      readonly reason: string;
      readonly diagnostics?: readonly PendingReviewRetryDiagnostic[];
    }
  | {
      readonly kind: 'captured';
      readonly prepared: Record<string, unknown>;
      readonly fulfilledAt: string;
    }
> {
  // Completion gate for EVERY obligation type (plan, architecture, implement,
  // review): the serialization prompt may only run after the host-recorded
  // messages prove the reviewer finished its task normally. A truncated,
  // aborted, step-limited or unprovable task is never serialized; the caller
  // routes the code through the bounded re-arm (retryable) or blocks (terminal).
  const completion = await readReviewerTaskCompletion(
    runtime.orchestratorDeps.client,
    childSessionId,
  );
  if (completion.kind === 'incomplete') {
    try {
      runtime.log.warn('orchestrator', 'reviewer task not completed; serialization refused', {
        obligationId: obligation.obligationId,
        childSessionId,
        code: completion.code,
        detail: completion.detail,
      });
    } catch {
      // Logging is diagnostic only; the fail-closed decision below stands.
    }
    return {
      kind: 'blocked',
      code: completion.code,
      reason: `Reviewer task not completed (${completion.detail}); its output is never serialized or accepted.`,
    };
  }

  const structured = await captureStructuredFindingsFromVisibleChild(
    runtime.orchestratorDeps.client,
    {
      childSessionId,
      obligationId: obligation.obligationId,
      schema: buildObligationFindingsJsonSchema(contract),
    },
    (timing) =>
      logStructuredFollowupTiming(runtime, obligation.obligationId, childSessionId, timing),
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

export async function bindNativeReviewEvidence(input: {
  runtime: NativeReviewRuntimePort;
  sessDir: string;
  sessionId: string;
  callId: string;
  childSessionId: string;
  lineage: NativeReviewLineage;
  prepared: Record<string, unknown>;
  fulfilledAt: string;
  executionDeadlineAt: string;
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
    deadlineAt: input.executionDeadlineAt,
    reviewerResult,
    semanticIntents: nativeReviewAuditIntents({
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
