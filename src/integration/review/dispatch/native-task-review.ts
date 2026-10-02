/**
 * @module integration/review/native-task-review
 * @description OpenCode-native visible independent-review transport.
 *
 * One reviewer identity spans one native Task child session:
 *   durable dispatch authorization -> native visible Task -> observation replay
 *   -> json_schema serialization in the SAME child -> canonical evidence bind.
 *
 * The Task's free-form text is never findings authority. Observation replay,
 * findings validation, and evidence binding live in
 * native-task-review-bindings.ts.
 */

import { readState } from '../../../adapters/persistence.js';
import { buildEnforcementError, strictBlockedOutput } from '../../blocked-result.js';

import type { SessionEnforcementState, PendingReviewRetryDiagnostic } from '../types.js';
import type { OrchestratorDeps } from '../pipeline-types.js';
import type {
  ToolHookAfterInput,
  ToolHookAfterOutput,
  ToolHookBeforeInput,
  ToolHookBeforeOutput,
} from '../../types.js';
import { REVIEWER_SUBAGENT_TYPE } from '../../../shared/flowguard-identifiers.js';
import type { ReviewObligation, ReviewObligationType } from '../../../state/evidence.js';
import { hashText } from '../../../shared/hashing.js';
import { ensureReviewAssurance, hasReleasedDispatch } from '../../../state/review-dispatch.js';
import { findBindableAttempt } from '../../../state/review-continuation.js';
import { isCurrentReviewGeneration } from '../obligations/assurance.js';
import type { ReviewerProofGraphAuthorities } from '../context/proof-context.js';
import { canonicalTaskPrompt } from './native-task-review-prompt.js';
import {
  abandonAndRearmByHostCall,
  abandonReviewDispatchByHostCall,
  persistAuthorizedReviewDispatch,
} from './durable-dispatch.js';
import {
  buildCaptureFailureDiagnostics,
  buildCodeOnlyRetryDiagnostic,
  buildReviewerCaptureRetryOutput,
  classifyReviewerCaptureFailure,
} from './capture-retry.js';
import { registerPendingReviewForAttempt } from '../enforcement/enforcement.js';
import { reviewableToolForObligationType } from '../obligations/obligation-tools.js';
import { projectReviewExecution } from './review-execution-projection.js';
import type { PersistedState, NativeReviewLineage } from './native-task-review-types.js';
import {
  bindNativeReviewEvidence,
  capturePreparedFindings,
  persistReviewerObservations,
  resolveNativeReviewLineage,
  validateCapturedFindings,
} from './native-task-review-bindings.js';

const TASK_TOOL = 'task';
const TASK_DESCRIPTION = 'FlowGuard independent review';

/**
 * Structural host-runtime port for the native reviewer Task transport.
 *
 * review/ must not import plugin-* (FG-QUAL-002); the host caller passes its
 * full runtime, which satisfies this subset structurally.
 */
export interface NativeReviewTransportRuntime {
  readonly ws: {
    getEnforcementState(sessionId: string): SessionEnforcementState;
    getSessionDir(sessionId: string): string | null;
  };
  readonly orchestratorDeps: OrchestratorDeps;
  readonly log: {
    info(service: string, message: string, extra?: Record<string, unknown>): void;
    warn(service: string, message: string, extra?: Record<string, unknown>): void;
  };
  readonly logError: (message: string, err: unknown) => void;
}

/**
 * Injected plugin-lifecycle audit reconciliation. The host composition layer
 * owns the plugin-* dependency; review/ only consumes the outcome.
 */
export type NativeReviewAuditReconciler = (
  sessionId: string,
  toolName: string,
) => Promise<
  { readonly block?: boolean; readonly code?: string; readonly reason?: string } | undefined
>;

type BindableAttempt = NonNullable<ReturnType<typeof findBindableAttempt>>;

interface BlockOutputInput {
  readonly runtime: NativeReviewTransportRuntime;
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

function pendingBinding(runtime: NativeReviewTransportRuntime, sessionId: string) {
  const candidates = [...runtime.ws.getEnforcementState(sessionId).pendingReviews.values()].filter(
    (pending) => pending.obligationId !== null && pending.attemptId !== null,
  );
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

async function reconcileBeforeReviewerDispatch(
  reconcile: NativeReviewAuditReconciler,
  sessionId: string,
): Promise<void> {
  const result = await reconcile(sessionId, TASK_TOOL);
  if (result?.block) {
    throw buildEnforcementError(result.code ?? 'AUDIT_PERSISTENCE_FAILED', result.reason ?? '');
  }
}

async function requireState(
  runtime: NativeReviewTransportRuntime,
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
  runtime: NativeReviewTransportRuntime,
  sessionId: string,
  state: PersistedState,
): {
  readonly obligation: ReviewObligation;
  readonly attempt: BindableAttempt;
  readonly retryDiagnostics?: readonly PendingReviewRetryDiagnostic[];
} {
  const pending = pendingBinding(runtime, sessionId);
  if (!pending) {
    throw buildEnforcementError(
      'SUBAGENT_REVIEW_NOT_INVOKED',
      'No unique pending FlowGuard review obligation is authorized for this native reviewer Task. ' +
        'If a reviewer Task was already attempted, use the canonical recovery for its obligation ' +
        'type (implementation: flowguard_review_implementation with reviewRecovery "retry_transport"; ' +
        'plan/architecture: re-run the originating command).',
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
      `This reviewer attempt has already been released to the host. ${transportRecoveryInstruction(
        obligation.obligationType,
      )}`,
    );
  }
  return {
    obligation,
    attempt,
    ...(pending.retryDiagnostics !== undefined
      ? { retryDiagnostics: pending.retryDiagnostics }
      : {}),
  };
}

/**
 * Phase-legal recovery for a spent/interrupted reviewer release. Every
 * obligation family has a typed or command-native recovery that re-arms the
 * same frozen obligation with a fresh attempt.
 */
function transportRecoveryInstruction(obligationType: ReviewObligationType): string {
  switch (obligationType) {
    case 'implement':
      return 'Call flowguard_review_implementation with reviewRecovery: "retry_transport" to re-arm the same review obligation with a fresh attempt, then invoke Task again.';
    case 'plan':
      return 'Call flowguard_plan({ reviewRecovery: "retry_transport" }) to re-arm the same review obligation with a fresh attempt, then invoke Task again.';
    case 'architecture':
      return 'Call flowguard_architecture({ reviewRecovery: "retry_transport" }) to re-arm the same review obligation with a fresh attempt, then invoke Task again.';
    case 'review':
      return 'Re-run flowguard_review with reviewObligationId to re-arm the same frozen review obligation with a fresh attempt, then invoke Task again.';
  }
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
  runtime: NativeReviewTransportRuntime,
  input: unknown,
  output: unknown,
  reconcile: NativeReviewAuditReconciler,
  proofGraphAuthorities: ReviewerProofGraphAuthorities,
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

  await reconcileBeforeReviewerDispatch(reconcile, sessionId);
  const { sessDir, state } = await requireState(runtime, sessionId);
  const { obligation, attempt, retryDiagnostics } = requireCurrentAttempt(
    runtime,
    sessionId,
    state,
  );
  const prompt = canonicalTaskPrompt(
    state,
    obligation,
    attempt,
    proofGraphAuthorities,
    retryDiagnostics,
  );
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

interface CaptureFailureContext extends Omit<BlockOutputInput, 'code' | 'reason'> {
  readonly sessionId: string;
  readonly obligationType: ReviewObligationType;
}

type CaptureFailureInput = CaptureFailureContext & {
  readonly code: string;
  readonly reason: string;
  readonly diagnostics: readonly PendingReviewRetryDiagnostic[];
};

interface StructuredReviewInput {
  readonly sessionId: string;
  readonly callId: string;
  readonly sessDir: string;
  readonly lineage: NativeReviewLineage;
  readonly childSessionId: string;
  readonly hookOutput: ToolHookAfterOutput;
  readonly captureFailure: CaptureFailureContext;
}

/**
 * Route one reviewer capture/binding failure: terminal codes fail the review
 * closed unchanged; retryable codes abandon the exact host release and re-arm a
 * fresh attempt on the same frozen obligation (bounded by the obligation
 * budget). A refused re-arm also fails closed with the original capture code.
 */
async function abandonOrRetryCaptureFailure(input: CaptureFailureInput): Promise<void> {
  const decision = classifyReviewerCaptureFailure(input.code);
  if (!decision.retryable) {
    await abandonAndBlock(input);
    return;
  }
  const rearm = await abandonAndRearmByHostCall(
    input.runtime.orchestratorDeps,
    input.sessDir,
    input.callId,
  );
  if (rearm.kind !== 'rearmed') {
    const blockedReason =
      rearm.kind === 'blocked'
        ? `FlowGuard could not re-arm a fresh reviewer attempt: ${rearm.reason}.`
        : 'FlowGuard found no exact abandoned dispatch lineage to re-arm.';
    await abandonAndBlock({ ...input, reason: `${input.reason} ${blockedReason}` });
    return;
  }
  const reviewTool = reviewableToolForObligationType(input.obligationType);
  if (!reviewTool) {
    await abandonAndBlock({
      ...input,
      reason: `${input.reason} No reviewable tool owns obligation type ${input.obligationType}.`,
    });
    return;
  }
  registerPendingReviewForAttempt(
    input.runtime.ws.getEnforcementState(input.sessionId),
    reviewTool,
    {
      attemptId: rearm.attempt.attemptId,
      obligationId: rearm.obligationId,
      retryDiagnostics: input.diagnostics,
    },
    new Date().toISOString(),
  );
  input.output.output = buildReviewerCaptureRetryOutput({
    code: input.code,
    obligationId: rearm.obligationId,
    attemptId: rearm.attempt.attemptId,
    diagnostics: input.diagnostics,
  });
}

async function writeBindingFailure(
  input: CaptureFailureContext,
  result: Exclude<Awaited<ReturnType<typeof bindNativeReviewEvidence>>, 'fulfilled'>,
): Promise<void> {
  if (typeof result === 'object') {
    await abandonOrRetryCaptureFailure({
      ...input,
      code: result.code,
      reason: JSON.stringify(result.details),
      diagnostics: buildCaptureFailureDiagnostics(result.code, result.details),
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
  readonly runtime: NativeReviewTransportRuntime;
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

function projectUnableToReview(output: ToolHookAfterOutput, obligationId: string): void {
  output.output = strictBlockedOutput('SUBAGENT_UNABLE_TO_REVIEW', { obligationId });
}

type NativeTaskContextResolution =
  | {
      readonly kind: 'resolved';
      readonly sessionId: string;
      readonly callId: string;
      readonly sessDir: string;
    }
  | { readonly kind: 'context_unavailable'; readonly reason: string };

/**
 * Governed after-hook context for one native reviewer Task.
 *
 * A reviewer Task is governed by its identity, so context loss is an invariant
 * violation — never a reason to skip enforcement. The only non-governed
 * invocation is rejected by `isNativeReviewerTaskAfter` before this point.
 */
function resolveNativeTaskContext(
  runtime: NativeReviewTransportRuntime,
  hookInput: ToolHookAfterInput,
): NativeTaskContextResolution {
  const sessionId = hookInput.sessionID;
  const callId = hookInput.callID;
  const sessDir = runtime.ws.getSessionDir(sessionId);
  if (!sessDir) {
    return {
      kind: 'context_unavailable',
      reason:
        'The completed native reviewer Task has no resolvable FlowGuard session directory; ' +
        'the governed reviewer invocation cannot be observed or bound.',
    };
  }
  if (!callId) {
    return {
      kind: 'context_unavailable',
      reason:
        'The completed native reviewer Task has no host callID; the governed reviewer invocation ' +
        'cannot be matched to its durable dispatch authorization.',
    };
  }
  return { kind: 'resolved', sessionId, callId, sessDir };
}

/** Host boundary after native Task: bind same-child structured findings and replace free-form text. */
export async function nativeReviewTaskAfter(
  runtime: NativeReviewTransportRuntime,
  input: unknown,
  output: unknown,
): Promise<void> {
  const hookInput = input as ToolHookAfterInput;
  const hookOutput = output as ToolHookAfterOutput;
  if (!isNativeReviewerTaskAfter(hookInput)) return;
  const taskContext = resolveNativeTaskContext(runtime, hookInput);
  if (taskContext.kind === 'context_unavailable') {
    hookOutput.output = strictBlockedOutput('PLUGIN_ENFORCEMENT_UNAVAILABLE', {
      reason: taskContext.reason,
    });
    runtime.log.warn('orchestrator', 'native reviewer Task after-hook context unavailable', {
      reason: taskContext.reason,
    });
    return;
  }
  await fulfillNativeReviewTask(runtime, taskContext, hookOutput);
}

async function fulfillNativeReviewTask(
  runtime: NativeReviewTransportRuntime,
  taskContext: Extract<NativeTaskContextResolution, { kind: 'resolved' }>,
  hookOutput: ToolHookAfterOutput,
): Promise<void> {
  const { sessionId, callId, sessDir } = taskContext;

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

  await completeStructuredReview(runtime, {
    sessionId,
    callId,
    sessDir,
    lineage,
    childSessionId,
    hookOutput,
    captureFailure: {
      runtime,
      sessDir,
      sessionId,
      callId,
      obligationType: lineage.obligation.obligationType,
      output: hookOutput,
    },
  });
}

async function completeStructuredReview(
  runtime: NativeReviewTransportRuntime,
  input: StructuredReviewInput,
): Promise<void> {
  const { sessionId, callId, sessDir, lineage, childSessionId, hookOutput, captureFailure } = input;

  await persistReviewerObservations(runtime, sessionId, lineage.attempt.attemptId, childSessionId);
  const refreshedState = await readState(sessDir);
  if (!refreshedState) {
    await abandonAndBlock({
      runtime,
      sessDir,
      callId,
      output: hookOutput,
      code: 'REVIEW_ASSURANCE_STATE_UNAVAILABLE',
      reason:
        'Persisted FlowGuard state disappeared after reviewer observation replay; ' +
        'the captured findings cannot be validated or bound.',
    });
    return;
  }

  const captured = await capturePreparedFindings(runtime, lineage.obligation, childSessionId);
  if (captured.kind === 'blocked') {
    await abandonOrRetryCaptureFailure({
      ...captureFailure,
      code: captured.code,
      reason: captured.reason,
      diagnostics: [buildCodeOnlyRetryDiagnostic(captured.code)],
    });
    return;
  }
  const validation = validateCapturedFindings(
    refreshedState,
    lineage.obligation,
    captured.prepared,
  );
  if (validation.kind === 'blocked') {
    await abandonOrRetryCaptureFailure({
      ...captureFailure,
      code: validation.code,
      reason: validation.reason,
      diagnostics: [buildCodeOnlyRetryDiagnostic(validation.code)],
    });
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
    await writeBindingFailure(captureFailure, result);
    return;
  }
  if (validation.findings.overallVerdict === 'unable_to_review') {
    projectUnableToReview(hookOutput, lineage.obligation.obligationId);
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
