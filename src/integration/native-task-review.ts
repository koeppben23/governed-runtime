/**
 * @module integration/native-task-review
 * @description OpenCode-native visible independent-review transport.
 *
 * One reviewer identity spans one native Task child session:
 *   durable dispatch authorization -> native visible Task -> observation replay
 *   -> json_schema serialization in the SAME child -> canonical evidence bind.
 *
 * The Task's free-form text is never findings authority.
 */

import { readState } from '../adapters/persistence.js';
import { buildEnforcementError, strictBlockedOutput } from './plugin-helpers.js';
import type { FlowGuardPluginRuntime } from './plugin-shared.js';
import type {
  ToolHookAfterInput,
  ToolHookAfterOutput,
  ToolHookBeforeInput,
  ToolHookBeforeOutput,
} from './types.js';
import { REVIEWER_SUBAGENT_TYPE } from '../shared/flowguard-identifiers.js';
import { ReviewFindings as ReviewFindingsSchema } from '../state/evidence.js';
import type { ReviewObligation, ReviewObligationType } from '../state/evidence.js';
import type { SessionState } from '../state/schema.js';
import { hashText } from '../shared/hashing.js';
import {
  ensureReviewAssurance,
  findBindableAttempt,
  hashFindings,
  isCurrentReviewGeneration,
} from './review/assurance.js';
import {
  hasReleasedDispatch,
  verifyFrozenMaterialForObligation,
} from '../state/review-continuation.js';
import { renderReviewerTaskPrompt } from './review/prompt-builders.js';
import { reviewerPromptTypeForTask } from './review/reviewer-task-type.js';
import { renderArtifactAnchorContract } from './review/frozen-reviewer-context.js';
import { resolveObservationRevisions } from './review/observation-access.js';
import { buildReviewChallengeContract } from './review/challenge-contract.js';
import { buildReviewerProofContext } from './review/proof-context.js';
import {
  abandonReviewDispatchByHostCall,
  persistAuthorizedReviewDispatch,
} from './durable-dispatch.js';
import { reconcilePendingAuditOperations } from './plugin-audit-reconcile.js';
import { replayAndPersistObservations } from './review/observation-replay-persist.js';
import { captureStructuredFindingsFromVisibleChild } from './review/structured-followup.js';
import { prepareReviewerFindingsForValidation } from './review/enforcement/prepare-findings.js';
import { validatePipelineAttestation } from './review/shared-helpers.js';
import { validateChallengeConsistency } from './review/enforcement/challenge-consistency.js';
import { collectPreviouslyUsedChallengeIds } from './review/challenge-history.js';
import { recordEvidenceOrBlockReuse } from './review/sdk-evidence-recorder.js';
import type { ReviewerSuccessResult } from './review/orchestrator.js';
import { projectReviewExecution } from './review/review-execution-projection.js';

const TASK_TOOL = 'task';
const TASK_DESCRIPTION = 'FlowGuard independent review';

type PersistedState = NonNullable<Awaited<ReturnType<typeof readState>>>;
type BindableAttempt = NonNullable<ReturnType<typeof findBindableAttempt>>;

interface NativeReviewLineage {
  readonly state: PersistedState;
  readonly obligation: ReviewObligation;
  readonly attempt: BindableAttempt;
  readonly dispatch: NonNullable<PersistedState['reviewAssurance']>['dispatches'][number];
}

interface BlockOutputInput {
  readonly runtime: FlowGuardPluginRuntime;
  readonly sessDir: string;
  readonly callId: string;
  readonly output: ToolHookAfterOutput;
  readonly code: string;
  readonly reason: string;
}

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
  state: PersistedState,
  obligation: ReviewObligation,
  attempt: BindableAttempt,
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
      attempt.repositoryDiscovery.kind === 'repository'
        ? attempt.repositoryDiscovery.snapshot
        : null,
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

async function requireState(
  runtime: FlowGuardPluginRuntime,
  sessionId: string,
): Promise<{ readonly sessDir: string; readonly state: PersistedState }> {
  const sessDir = runtime.ws.getSessionDir(sessionId);
  const state = sessDir ? await readState(sessDir) : null;
  if (!sessDir || !state) {
    throw buildEnforcementError(
      'REVIEW_ASSURANCE_STATE_UNAVAILABLE',
      'Visible independent review requires readable persisted FlowGuard state.',
    );
  }
  return { sessDir, state };
}

function requireCurrentAttempt(
  runtime: FlowGuardPluginRuntime,
  sessionId: string,
  state: PersistedState,
): { readonly obligation: ReviewObligation; readonly attempt: BindableAttempt } {
  const pending = pendingBinding(runtime, sessionId);
  if (!pending) {
    throw buildEnforcementError(
      'SUBAGENT_REVIEW_NOT_INVOKED',
      'No unique pending FlowGuard review obligation is authorized for this native reviewer Task.',
    );
  }
  const assurance = ensureReviewAssurance(state.reviewAssurance);
  const obligation = assurance.obligations.find(
    (item) => item.obligationId === pending.obligationId,
  );
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
  if (hasReleasedDispatch(assurance, attempt.attemptId)) {
    throw buildEnforcementError(
      'REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE',
      'This reviewer attempt has already been released to the host. Re-run the originating FlowGuard command so it can re-arm the frozen obligation with a fresh attempt before invoking Task again.',
    );
  }
  return { obligation, attempt };
}

function mutateNativeTask(output: ToolHookBeforeOutput, prompt: string): void {
  output.args.subagent_type = REVIEWER_SUBAGENT_TYPE;
  output.args.description = TASK_DESCRIPTION;
  output.args.prompt = prompt;
  output.args.background = false;
  delete output.args.task_id;
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
  const { sessDir, state } = await requireState(runtime, sessionId);
  const { obligation, attempt } = requireCurrentAttempt(runtime, sessionId, state);
  const prompt = canonicalTaskPrompt(state, obligation, attempt);
  const authorizedAt = new Date().toISOString();
  await persistAuthorizedReviewDispatch(runtime.orchestratorDeps, sessDir, {
    attemptId: attempt.attemptId,
    obligationId: obligation.obligationId,
    hostCallId: callId,
    canonicalPromptDigest: hashText(prompt),
    authorizedAt,
  });

  mutateNativeTask(hookOutput, prompt);
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

async function abandonAndBlock(input: BlockOutputInput): Promise<void> {
  await abandonReviewDispatchByHostCall(
    input.runtime.orchestratorDeps,
    input.sessDir,
    input.callId,
  );
  input.output.output = strictBlockedOutput(input.code, { reason: input.reason });
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

async function resolveNativeReviewLineage(
  runtime: FlowGuardPluginRuntime,
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

async function persistReviewerObservations(
  runtime: FlowGuardPluginRuntime,
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

async function capturePreparedFindings(
  runtime: FlowGuardPluginRuntime,
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

function validateCapturedFindings(
  state: PersistedState,
  obligation: ReviewObligation,
  prepared: Record<string, unknown>,
) {
  const findings = ReviewFindingsSchema.parse(prepared);
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
    return {
      kind: 'blocked' as const,
      code: attestation.code,
      reason: 'Reviewer attestation mismatch.',
    };
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
    return {
      kind: 'blocked' as const,
      code: challenge.code,
      reason: JSON.stringify(challenge.details),
    };
  }
  return { kind: 'valid' as const, findings };
}

async function bindNativeReviewEvidence(input: {
  runtime: FlowGuardPluginRuntime;
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

async function writeBindingFailure(
  input: BlockOutputInput,
  result: Exclude<Awaited<ReturnType<typeof bindNativeReviewEvidence>>, 'fulfilled'>,
): Promise<void> {
  if (typeof result === 'object') {
    await abandonAndBlock({
      ...input,
      code: result.code,
      reason: JSON.stringify(result.details),
    });
    return;
  }
  input.output.output = strictBlockedOutput(
    result === 'reused'
      ? 'SUBAGENT_EVIDENCE_REUSED'
      : result === 'lineage_unavailable'
        ? 'REVIEW_ATTEMPT_UNAVAILABLE'
        : 'REVIEW_MATERIAL_INTEGRITY_FAILED',
    { reason: `Native reviewer evidence binding returned ${result}.` },
  );
}

async function projectFulfilledReview(input: {
  readonly runtime: FlowGuardPluginRuntime;
  readonly sessDir: string;
  readonly sessionId: string;
  readonly childSessionId: string;
  readonly attemptId: string;
  readonly obligationId: string;
  readonly verdict: string;
  readonly output: ToolHookAfterOutput;
}): Promise<void> {
  const boundState = await readState(input.sessDir);
  const invocation = boundState?.reviewAssurance?.invocations.find(
    (item) => item.attemptId === input.attemptId && item.childSessionId === input.childSessionId,
  );
  input.output.output = JSON.stringify({
    status: 'Independent reviewer completed in a visible native child session.',
    reviewDispatch: { required: true, completed: true, verdict: input.verdict },
    ...(invocation ? { reviewExecution: projectReviewExecution(invocation) } : {}),
  });
  if (invocation)
    input.output.metadata.flowguardReviewExecution = projectReviewExecution(invocation);
  input.runtime.log.info('orchestrator', 'native reviewer Task fulfilled review obligation', {
    sessionId: input.sessionId,
    childSessionId: input.childSessionId,
    obligationId: input.obligationId,
    attemptId: input.attemptId,
    verdict: input.verdict,
  });
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

  const lineage = await resolveNativeReviewLineage(runtime, sessDir, callId);
  if (!lineage) {
    hookOutput.output = strictBlockedOutput('REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE', {
      reason: 'The completed native Task has no exact durable review dispatch lineage.',
    });
    return;
  }

  const childSessionId = taskChildSessionId(hookOutput);
  if (!childSessionId) {
    await abandonAndBlock({
      runtime,
      sessDir,
      callId,
      output: hookOutput,
      code: 'REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE',
      reason: 'OpenCode Task metadata did not expose the authoritative child session ID.',
    });
    return;
  }

  await persistReviewerObservations(runtime, sessionId, lineage.attempt.attemptId, childSessionId);
  const refreshedState = await readState(sessDir);
  if (!refreshedState) return;

  const captured = await capturePreparedFindings(runtime, lineage.obligation, childSessionId);
  if (captured.kind === 'blocked') {
    await abandonAndBlock({ runtime, sessDir, callId, output: hookOutput, ...captured });
    return;
  }
  const validation = validateCapturedFindings(
    refreshedState,
    lineage.obligation,
    captured.prepared,
  );
  if (validation.kind === 'blocked') {
    await abandonAndBlock({ runtime, sessDir, callId, output: hookOutput, ...validation });
    return;
  }

  const result = await bindNativeReviewEvidence({
    runtime,
    sessDir,
    sessionId,
    callId,
    childSessionId,
    lineage,
    prepared: captured.prepared,
    fulfilledAt: captured.fulfilledAt,
    phase: refreshedState.phase,
  });
  if (result !== 'fulfilled') {
    await writeBindingFailure(
      { runtime, sessDir, callId, output: hookOutput, code: '', reason: '' },
      result,
    );
    return;
  }

  await projectFulfilledReview({
    runtime,
    sessDir,
    sessionId,
    childSessionId,
    attemptId: lineage.attempt.attemptId,
    obligationId: lineage.obligation.obligationId,
    verdict: validation.findings.overallVerdict,
    output: hookOutput,
  });
}
