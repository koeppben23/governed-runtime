/**
 * @module integration/review/native-task-review
 * @description OpenCode-native visible independent-review transport.
 *
 * One reviewer identity spans one native Task child session:
 *   durable dispatch authorization -> native visible Task -> observation replay
 *   -> json_schema serialization in the SAME child -> canonical evidence bind.
 *
 * The Task's free-form text is never findings authority.
 */

import { readState } from '../../adapters/persistence.js';
import { buildEnforcementError, strictBlockedOutput } from '../plugin-helpers.js';
import type { FlowGuardPluginRuntime } from '../plugin-shared.js';
import type {
  ToolHookAfterInput,
  ToolHookAfterOutput,
  ToolHookBeforeInput,
  ToolHookBeforeOutput,
} from '../types.js';
import { REVIEWER_SUBAGENT_TYPE } from '../../shared/flowguard-identifiers.js';
import { ReviewFindings as ReviewFindingsSchema } from '../../state/evidence.js';
import type { ReviewObligation, ReviewObligationType } from '../../state/evidence.js';
import type { SessionState } from '../../state/schema.js';
import { hashText } from '../../shared/hashing.js';
import {
  ensureReviewAssurance,
  findBindableAttempt,
  hashFindings,
  isCurrentReviewGeneration,
} from './assurance.js';
import {
  hasReleasedDispatch,
  verifyFrozenMaterialForObligation,
} from '../../state/review-continuation.js';
import { renderReviewerTaskPrompt } from './prompt-builders.js';
import { reviewerPromptTypeForTask } from './reviewer-task-type.js';
import { renderArtifactAnchorContract } from './frozen-reviewer-context.js';
import { resolveObservationRevisions } from './observation-access.js';
import { buildReviewChallengeContract } from './challenge-contract.js';
import { buildReviewerProofContext } from './proof-context.js';
import {
  abandonReviewDispatchByHostCall,
  persistAuthorizedReviewDispatch,
} from '../durable-dispatch.js';
import { reconcilePendingAuditOperations } from '../plugin-audit-reconcile.js';
import { replayAndPersistObservations } from './observation-replay-persist.js';
import { captureStructuredFindingsFromVisibleChild } from './structured-followup.js';
import { prepareReviewerFindingsForValidation } from './enforcement/prepare-findings.js';
import { validatePipelineAttestation } from './shared-helpers.js';
import { validateChallengeConsistency } from './enforcement/challenge-consistency.js';
import { collectPreviouslyUsedChallengeIds } from './challenge-history.js';
import { recordEvidenceOrBlockReuse } from './sdk-evidence-recorder.js';
import type { ReviewerSuccessResult } from './orchestrator.js';
import { projectReviewExecution } from './review-execution-projection.js';

const TASK_TOOL = 'task';
const TASK_DESCRIPTION = 'FlowGuard independent review';

export function isNativeReviewerTaskBefore(output: unknown): boolean {
  const args = (output as ToolHookBeforeOutput | undefined)?.args;
  return args?.subagent_type === REVIEWER_SUBAGENT_TYPE;
}

export function isNativeReviewerTaskAfter(input: unknown): boolean {
  const hook = input as ToolHookAfterInput | undefined;
  return hook?.tool === TASK_TOOL && hook.args?.subagent_type === REVIEWER_SUBAGENT_TYPE;
}

function pendingBinding(runtime: FlowGuardPluginRuntime, sessionId: string) {
  const candidates = [...runtime.ws.getEnforcementState(sessionId).pendingReviews.values()].filter(
    (pending) => pending.obligationId !== null && pending.attemptId !== null,
  );
  return candidates.length === 1 ? candidates[0]! : null;
}

function subjectLabel(type: ReviewObligationType): string {
  switch (type) {
    case 'plan':
      return 'the frozen plan and ticket context';
    case 'architecture':
      return 'the frozen architecture decision and ticket context';
    case 'implement':
      return 'the frozen implementation change and approved plan context';
    case 'review':
      return 'the frozen peer-review content';
  }
}

function canonicalTaskPrompt(
  state: NonNullable<Awaited<ReturnType<typeof readState>>>,
  obligation: ReviewObligation,
  attempt: NonNullable<ReturnType<typeof findBindableAttempt>>,
): string {
  const material = verifyFrozenMaterialForObligation(obligation, obligation.reviewMaterial);
  if (material.kind === 'blocked') {
    throw buildEnforcementError(material.code, material.reason);
  }
  const frozenReviewerContext =
    material.context ??
    (obligation.reviewMaterial ? { reviewMaterial: obligation.reviewMaterial } : undefined);
  const artifactScope =
    obligation.reviewSubjectScope?.kind === 'artifact' ? obligation.reviewSubjectScope : undefined;
  const observationRevisions = resolveObservationRevisions(obligation);
  return renderReviewerTaskPrompt({
    iteration: obligation.iteration,
    planVersion: obligation.planVersion,
    obligationId: obligation.obligationId,
    mandateDigest: obligation.mandateDigest,
    criteriaVersion: obligation.criteriaVersion,
    subjectLabel: subjectLabel(obligation.obligationType),
    reviewType: reviewerPromptTypeForTask(obligation.obligationType),
    repositoryReview: observationRevisions.length > 0,
    challengeContract: buildReviewChallengeContract(state, obligation) ?? undefined,
    proofContext: buildReviewerProofContext(state),
    frozenReviewerContext,
    artifactAnchorContract: artifactScope ? renderArtifactAnchorContract(artifactScope) : undefined,
    repositoryDiscoverySnapshot:
      attempt.repositoryDiscovery.kind === 'repository' ? attempt.repositoryDiscovery.snapshot : null,
    observationCapability: attempt.observationCapability,
    observationRevisions,
  });
}

async function reconcileBeforeReviewerDispatch(
  runtime: FlowGuardPluginRuntime,
  sessionId: string,
): Promise<void> {
  const result = await reconcilePendingAuditOperations(runtime.auditDeps, sessionId, TASK_TOOL);
  if (result?.block) {
    throw buildEnforcementError(result.code ?? 'AUDIT_PERSISTENCE_FAILED', result.reason ?? '');
  }
}

/** Host boundary before native Task execution: inject canonical frozen authority and persist release. */
export async function nativeReviewTaskBefore(
  runtime: FlowGuardPluginRuntime,
  input: unknown,
  output: unknown,
): Promise<void> {
  const hookInput = input as ToolHookBeforeInput;
  const hookOutput = output as ToolHookBeforeOutput;
  if (hookInput.tool !== TASK_TOOL || hookOutput.args.subagent_type !== REVIEWER_SUBAGENT_TYPE)
    return;
  const sessionId = hookInput.sessionID;
  const callId = hookInput.callID;
  if (!callId) {
    throw buildEnforcementError(
      'PLUGIN_ENFORCEMENT_UNAVAILABLE',
      'Visible independent review requires a host Task callID for durable dispatch binding.',
    );
  }

  await reconcileBeforeReviewerDispatch(runtime, sessionId);
  const sessDir = runtime.ws.getSessionDir(sessionId);
  const state = sessDir ? await readState(sessDir) : null;
  if (!sessDir || !state) {
    throw buildEnforcementError(
      'REVIEW_ASSURANCE_STATE_UNAVAILABLE',
      'Visible independent review requires readable persisted FlowGuard state.',
    );
  }

  const pending = pendingBinding(runtime, sessionId);
  if (!pending) {
    throw buildEnforcementError(
      'SUBAGENT_REVIEW_NOT_INVOKED',
      'No unique pending FlowGuard review obligation is authorized for this native reviewer Task.',
    );
  }
  const assurance = ensureReviewAssurance(state.reviewAssurance);
  const obligation = assurance.obligations.find((item) => item.obligationId === pending.obligationId);
  const attempt = obligation ? findBindableAttempt(assurance, obligation.obligationId) : null;
  if (
    !obligation ||
    obligation.status !== 'pending' ||
    !attempt ||
    attempt.attemptId !== pending.attemptId ||
    !isCurrentReviewGeneration(obligation)
  ) {
    throw buildEnforcementError(
      'REVIEW_ATTEMPT_UNAVAILABLE',
      'The native reviewer Task is not bound to the exact current pending review attempt.',
    );
  }
  // A bare second Task call must never reset a spent attempt. The originating
  // FlowGuard command owns the durable re-arm and mints a fresh append-only
  // attempt. This keeps retry authority out of the host transport surface.
  if (hasReleasedDispatch(assurance, attempt.attemptId)) {
    throw buildEnforcementError(
      'REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE',
      'This reviewer attempt has already been released to the host. Re-run the originating FlowGuard command so it can re-arm the frozen obligation with a fresh attempt before invoking Task again.',
    );
  }

  const prompt = canonicalTaskPrompt(state, obligation, attempt);
  const authorizedAt = new Date().toISOString();
  await persistAuthorizedReviewDispatch(runtime.orchestratorDeps, sessDir, {
    attemptId: attempt.attemptId,
    obligationId: obligation.obligationId,
    hostCallId: callId,
    canonicalPromptDigest: hashText(prompt),
    authorizedAt,
  });

  // The model-authored Task prompt is never authority. The host replaces it
  // with the exact frozen prompt after the durable-before-release write.
  hookOutput.args.subagent_type = REVIEWER_SUBAGENT_TYPE;
  hookOutput.args.description = TASK_DESCRIPTION;
  hookOutput.args.prompt = prompt;
  hookOutput.args.background = false;
  delete hookOutput.args.task_id;
  runtime.log.info('orchestrator', 'native reviewer Task authorized', {
    sessionId,
    callId,
    obligationId: obligation.obligationId,
    attemptId: attempt.attemptId,
  });
}

function taskChildSessionId(output: ToolHookAfterOutput): string | null {
  return typeof output.metadata?.sessionId === 'string' && output.metadata.sessionId.length > 0
    ? output.metadata.sessionId
    : null;
}

async function abandonAndBlock(
  runtime: FlowGuardPluginRuntime,
  sessDir: string,
  callId: string,
  output: ToolHookAfterOutput,
  code: string,
  reason: string,
): Promise<void> {
  await abandonReviewDispatchByHostCall(runtime.orchestratorDeps, sessDir, callId);
  output.output = strictBlockedOutput(code, { reason });
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
  return (
    _result: 'fulfilled' | 'reused',
    _state: SessionState,
    occurredAt: string,
  ) => [
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

/** Host boundary after native Task: bind same-child structured findings and replace free-form text. */
export async function nativeReviewTaskAfter(
  runtime: FlowGuardPluginRuntime,
  input: unknown,
  output: unknown,
): Promise<void> {
  const hookInput = input as ToolHookAfterInput;
  const hookOutput = output as ToolHookAfterOutput;
  if (!isNativeReviewerTaskAfter(hookInput)) return;
  const sessionId = hookInput.sessionID;
  const callId = hookInput.callID;
  const sessDir = runtime.ws.getSessionDir(sessionId);
  if (!sessDir || !callId) return;

  let state = await readState(sessDir);
  const dispatch = state?.reviewAssurance?.dispatches.find(
    (item) => item.hostCallId === callId && item.dispatchStatus === 'authorized',
  );
  const attempt = dispatch
    ? state?.reviewAssurance?.attempts.find((item) => item.attemptId === dispatch.attemptId)
    : undefined;
  const obligation = dispatch
    ? state?.reviewAssurance?.obligations.find((item) => item.obligationId === dispatch.obligationId)
    : undefined;
  if (!state || !dispatch || !attempt || !obligation) {
    hookOutput.output = strictBlockedOutput('REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE', {
      reason: 'The completed native Task has no exact durable review dispatch lineage.',
    });
    return;
  }

  const childSessionId = taskChildSessionId(hookOutput);
  if (!childSessionId) {
    await abandonAndBlock(
      runtime,
      sessDir,
      callId,
      hookOutput,
      'REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE',
      'OpenCode Task metadata did not expose the authoritative child session ID.',
    );
    return;
  }

  await replayAndPersistObservations(
    {
      getSessionDir: runtime.orchestratorDeps.getSessionDir,
      updateReviewAssurance: runtime.orchestratorDeps.updateReviewAssurance,
      log: runtime.log,
      logError: runtime.logError,
    },
    readState,
    {
      sessionId,
      attemptId: attempt.attemptId,
      childSessionId,
      now: new Date().toISOString(),
    },
  );
  state = await readState(sessDir);
  if (!state) return;

  const structured = await captureStructuredFindingsFromVisibleChild(
    runtime.orchestratorDeps.client,
    {
      childSessionId,
      obligationId: obligation.obligationId,
    },
  );
  if (structured.kind === 'blocked') {
    await abandonAndBlock(
      runtime,
      sessDir,
      callId,
      hookOutput,
      structured.code,
      structured.reason,
    );
    return;
  }

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
    await abandonAndBlock(
      runtime,
      sessDir,
      callId,
      hookOutput,
      'HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION',
      prepared.issues.join('; '),
    );
    return;
  }

  const findings = ReviewFindingsSchema.parse(prepared.findings);
  const attestation = validatePipelineAttestation(findings, {
    obligationId: obligation.obligationId,
    criteriaVersion: obligation.criteriaVersion,
    mandateDigest: obligation.mandateDigest,
    iteration: obligation.iteration,
    planVersion: obligation.planVersion,
    checkReviewedBy: true,
    checkUnableToReview: false,
  });
  if (!attestation.valid) {
    await abandonAndBlock(
      runtime,
      sessDir,
      callId,
      hookOutput,
      attestation.code,
      'Reviewer attestation mismatch.',
    );
    return;
  }
  const challenge = validateChallengeConsistency({
    overallVerdict: findings.overallVerdict,
    requiredChallengeCount: obligation.requiredChallengeCount,
    requiredChallengeKind: obligation.requiredChallengeKind ?? 'implementation_challenge',
    challenges: findings.challenges,
    expectedObligationId: obligation.obligationId,
    allowedEvidenceRefs: buildReviewChallengeContract(state, obligation)?.evidenceRefs,
    resolutionVerdicts: findings.challengeResolutionVerdicts,
    previouslyUsedChallengeIds: collectPreviouslyUsedChallengeIds(state),
  });
  if (!challenge.ok) {
    await abandonAndBlock(
      runtime,
      sessDir,
      callId,
      hookOutput,
      challenge.code,
      JSON.stringify(challenge.details),
    );
    return;
  }

  const promptHash = dispatch.canonicalPromptDigest;
  const findingsHash = hashFindings(prepared.findings);
  const reviewerResult: ReviewerSuccessResult & { findings: Record<string, unknown> } = {
    sessionId: childSessionId,
    rawResponse: JSON.stringify(structured.findings),
    findings: prepared.findings,
    reviewOutputMode: 'structured_output',
    structuredOutputUsed: true,
    reviewAssuranceLevel: 'structured_high',
    invokedAt: dispatch.dispatchAuthorizedAt,
    fulfilledAt: structured.fulfilledAt,
  };
  const result = await recordEvidenceOrBlockReuse(runtime.orchestratorDeps, sessDir, {
    obligationId: obligation.obligationId,
    obligationType: obligation.obligationType,
    sessionId,
    childSessionId,
    hostCallId: callId,
    attemptId: attempt.attemptId,
    promptHash,
    findingsHash,
    invokedAt: dispatch.dispatchAuthorizedAt,
    fulfilledAt: structured.fulfilledAt,
    execution: {
      invocationMode: 'native_task_structured_followup',
      hostVisible: true,
      transcriptNavigable: true,
    },
    reviewerResult,
    semanticIntents: nativeAuditIntents({
      obligation,
      parentSessionId: sessionId,
      childSessionId,
      attemptId: attempt.attemptId,
      promptHash,
      findingsHash,
      phase: state.phase,
    }),
  });

  if (result !== 'fulfilled') {
    if (typeof result === 'object') {
      await abandonAndBlock(
        runtime,
        sessDir,
        callId,
        hookOutput,
        result.code,
        JSON.stringify(result.details),
      );
      return;
    }
    hookOutput.output = strictBlockedOutput(
      result === 'reused'
        ? 'SUBAGENT_EVIDENCE_REUSED'
        : result === 'lineage_unavailable'
          ? 'REVIEW_ATTEMPT_UNAVAILABLE'
          : 'REVIEW_MATERIAL_INTEGRITY_FAILED',
      { reason: `Native reviewer evidence binding returned ${result}.` },
    );
    return;
  }

  const boundState = await readState(sessDir);
  const invocation = boundState?.reviewAssurance?.invocations.find(
    (item) => item.attemptId === attempt.attemptId && item.childSessionId === childSessionId,
  );
  hookOutput.output = JSON.stringify({
    status: 'Independent reviewer completed in a visible native child session.',
    reviewDispatch: {
      required: true,
      completed: true,
      verdict: findings.overallVerdict,
    },
    ...(invocation ? { reviewExecution: projectReviewExecution(invocation) } : {}),
  });
  if (invocation)
    hookOutput.metadata.flowguardReviewExecution = projectReviewExecution(invocation);
  runtime.log.info('orchestrator', 'native reviewer Task fulfilled review obligation', {
    sessionId,
    childSessionId,
    obligationId: obligation.obligationId,
    attemptId: attempt.attemptId,
    verdict: findings.overallVerdict,
  });
}
