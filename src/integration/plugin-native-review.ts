/** V2 hook composition consumes canonical dispatch, initial-run and capture owners. */
import type { Plugin } from '@opencode/plugin';
import type { SessionPrompt, SessionModelRequest } from '@opencode/plugin/promise/session';
import { evaluateProofGraphGate } from '../audit/proofgraph/gate.js';
import { renderPlanClaimDeclarations } from '../presentation/plan-claim-declarations.js';
import { hashText } from '../shared/hashing.js';
import { REVIEWER_SUBAGENT_TYPE } from '../shared/flowguard-identifiers.js';
import type { GovernanceDelegationDispatch } from '../state/governance-activation.js';
import type { FlowGuardPluginRuntime } from './plugin-shared.js';
import { buildEnforcementError } from './blocked-result.js';
import { READ_ONLY_HOST_TOOLS } from './phase-tool-gate.js';
import { encodeHostCallId } from '../state/host-identity.js';
import { abandonAndBlockByHostCall } from './review/dispatch/durable-dispatch.js';
import { projectFulfilledReview } from './review/dispatch/native-review-execution.js';
import {
  NativeReviewCaptureFence,
  executeNativeReviewCapture,
  type NativeCaptureOutcome,
} from './review/dispatch/native-review-capture.js';
import {
  blockedCaptureOutput,
  rejectNativeReviewCapture,
} from './review/dispatch/native-review-capture-failure.js';
import {
  NativeReviewInitialController,
  type InitialToolBoundary,
} from './review/dispatch/native-review-initial.js';
import type { ActiveGovernanceScope, NativeBefore } from './opencode-governance.js';
import {
  authorizeNativeReviewDispatch,
  bindNativeReviewChild,
  nativeReviewDispatchLineage,
} from './review/dispatch/native-review-dispatch.js';

const HOST_PREFIX = 'You are a subagent spawned by another session.\n';

type NativeReviewCompletion = {
  readonly status: string;
  readonly sessionID: string;
  readonly messageID: string;
  readonly id: string;
  readonly input: unknown;
  result?: { content?: unknown; metadata?: Record<string, unknown> };
};

function metadataFor(event: NativeReviewCompletion): Record<string, unknown> {
  const metadata = (event as unknown as { result?: { metadata?: unknown } }).result?.metadata;
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : {};
}

function deny(reason: string): never {
  throw buildEnforcementError('REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE', reason);
}

type RuntimeFor = (
  scope: ActiveGovernanceScope,
) => Promise<
  Pick<
    FlowGuardPluginRuntime,
    'ws' | 'orchestratorDeps' | 'log' | 'logError' | 'reviewerExecutionTimeoutMs'
  >
>;

async function stateFor(runtimeFor: RuntimeFor, scope: ActiveGovernanceScope) {
  const runtime = await runtimeFor(scope);
  const resolution = await runtime.ws.resolveSessionAuthority(scope.root.sessionId);
  if (resolution.status !== 'resolved')
    return deny('The ACTIVE review parent state is unavailable.');
  const authority = {
    parentSessionId: scope.root.sessionId,
    policyDigest: scope.root.policyDigest,
    worktreeRoot: scope.root.worktreeRoot,
  };
  return { runtime, ...resolution, authority };
}

async function childLineage(runtimeFor: RuntimeFor, scope: ActiveGovernanceScope) {
  const dispatch = scope.record.parentDispatch;
  if (!dispatch || dispatch.sessionId !== scope.root.sessionId)
    return deny('A reviewer must be the direct child of its authorized review parent.');
  const resolved = await stateFor(runtimeFor, scope);
  const lineage = nativeReviewDispatchLineage(
    resolved.state,
    resolved.authority,
    encodeHostCallId(dispatch.sessionId, dispatch.messageId, dispatch.callId),
    scope.sessionId,
  );
  return { ...resolved, ...lineage };
}

function checkPrompt(text: string, digest: string): void {
  if (!text.startsWith(HOST_PREFIX) || hashText(text.slice(HOST_PREFIX.length)) !== digest)
    deny(
      'Only the exact host-prefixed authorized frozen reviewer prompt may execute. Capture remains blocked.',
    );
}

async function contextFor(
  ctx: Plugin.Context,
  runtimeFor: RuntimeFor,
  scope: ActiveGovernanceScope,
  initial: NativeReviewInitialController,
): Promise<void> {
  await childLineage(runtimeFor, scope);
  const history = await ctx.session.context({ sessionID: scope.sessionId });
  initial.context(scope.sessionId, history);
}

async function resolveNativeCaptureTarget(
  runtimeFor: RuntimeFor,
  scope: ActiveGovernanceScope,
  event: NativeReviewCompletion,
) {
  let nativeCallId: string;
  try {
    nativeCallId = encodeHostCallId(event.sessionID, event.messageID, event.id);
  } catch {
    throw buildEnforcementError(
      'REVIEWER_EXECUTION_OUTCOME_UNKNOWN',
      'The reviewer completion has no exact native call identity.',
    );
  }
  const resolved = await stateFor(runtimeFor, scope);
  const metadata = metadataFor(event);
  const childSessionId =
    typeof metadata.sessionID === 'string' && metadata.sessionID.length > 0
      ? metadata.sessionID
      : undefined;
  if (event.status !== 'completed' || childSessionId === undefined)
    throw buildEnforcementError(
      'REVIEWER_EXECUTION_OUTCOME_UNKNOWN',
      'The native reviewer completion did not expose an exact completed child.',
    );
  try {
    const lineage = nativeReviewDispatchLineage(
      resolved.state,
      resolved.authority,
      nativeCallId,
      childSessionId,
    );
    return { resolved, metadata, childSessionId, nativeCallId, lineage };
  } catch (error) {
    throw buildEnforcementError(
      'REVIEWER_EXECUTION_OUTCOME_UNKNOWN',
      error instanceof Error ? error.message : 'The reviewer completion has no exact lineage.',
    );
  }
}

async function runNativeReviewerCapture(input: {
  readonly ctx: Plugin.Context;
  readonly runtimeFor: RuntimeFor;
  readonly fence: NativeReviewCaptureFence;
  readonly initial: NativeReviewInitialController;
  readonly scope: ActiveGovernanceScope;
  readonly event: NativeReviewCompletion;
}): Promise<void> {
  const { ctx, runtimeFor, fence, scope, event } = input;
  const { resolved, metadata, childSessionId, nativeCallId, lineage } =
    await resolveNativeCaptureTarget(runtimeFor, scope, event);
  const blocked = (code: string, reason: string): void => {
    event.result = {
      ...(event.result ?? {}),
      content: blockedCaptureOutput(code, reason),
      metadata: { ...metadata },
    };
  };
  const outcome = await executeNativeReviewCapture({
    initial: input.initial,
    host: {
      context: (sessionID) => ctx.session.context({ sessionID }),
      prompt: (prompt) => ctx.session.prompt(prompt),
      wait: (sessionID) => ctx.session.wait({ sessionID }),
    },
    fence,
    runtime: resolved.runtime,
    sessDir: resolved.sessDir,
    parentSessionId: scope.root.sessionId,
    childSessionId,
    nativeCallId,
    state: resolved.state,
    obligation: lineage.obligation,
    attempt: lineage.attempt,
  });
  if (outcome.kind === 'fulfilled') {
    const output = { title: '', output: '', metadata: { ...metadata } };
    await projectFulfilledReview({
      runtime: resolved.runtime,
      sessDir: resolved.sessDir,
      sessionId: scope.root.sessionId,
      childSessionId,
      attemptId: lineage.attempt.attemptId,
      obligationId: lineage.obligation.obligationId,
      verdict: outcome.verdict,
      output,
    });
    event.result = {
      ...(event.result ?? {}),
      content: output.output,
      metadata: output.metadata,
    };
    return;
  }
  await closeNativeReviewerCapture({
    resolved,
    lineage,
    nativeCallId,
    childSessionId,
    outcome,
  });
  blocked(outcome.code, outcome.reason);
}

async function closeNativeReviewerCapture(input: {
  readonly resolved: Awaited<ReturnType<typeof stateFor>>;
  readonly lineage: ReturnType<typeof nativeReviewDispatchLineage>;
  readonly nativeCallId: string;
  readonly childSessionId: string;
  readonly outcome: Extract<NativeCaptureOutcome, { readonly kind: 'blocked' }>;
}): Promise<void> {
  const { resolved, lineage, nativeCallId, childSessionId, outcome } = input;
  if (outcome.code === 'REVIEWER_CAPTURE_PROVENANCE_INVALID') {
    await rejectNativeReviewCapture({
      runtime: resolved.runtime,
      sessDir: resolved.sessDir,
      authority: resolved.authority,
      nativeCallId,
      childSessionId,
      code: outcome.code,
      reason: outcome.reason,
    });
    return;
  }
  await abandonAndBlockByHostCall(
    resolved.runtime.orchestratorDeps,
    resolved.sessDir,
    nativeCallId,
    outcome.code,
    {
      childSessionId,
      obligationId: lineage.obligation.obligationId,
      attemptId: lineage.attempt.attemptId,
    },
  );
}

function createReviewerObservationHooks(
  ctx: Plugin.Context,
  runtimeFor: RuntimeFor,
  captureFence: NativeReviewCaptureFence,
  initial: NativeReviewInitialController,
) {
  return {
    async prompt(scope: ActiveGovernanceScope, event: SessionPrompt) {
      const lease = captureFence.activeLease(scope.sessionId);
      if (lease !== undefined) {
        captureFence.observePrompt(scope.sessionId, lease, event.messageID, event.prompt.text);
        return;
      }
      const { dispatch } = await childLineage(runtimeFor, scope);
      if (event.prompt.files?.length || event.prompt.agents?.length || event.prompt.skills?.length)
        return deny(
          'Reviewer prompt attachments, agent mentions and skills are not dispatch authority.',
        );
      checkPrompt(event.prompt.text, dispatch.canonicalPromptDigest);
      if ((await ctx.session.context({ sessionID: scope.sessionId })).length !== 0)
        return deny('The original reviewer prompt cannot be replayed or continued.');
      initial.admit(scope.sessionId, event.messageID, event.prompt.text);
    },
    async context(
      scope: ActiveGovernanceScope,
      event: { readonly tools: Record<string, unknown> },
    ) {
      const lease = captureFence.activeLease(scope.sessionId);
      if (lease !== undefined) {
        captureFence.observeContext(scope.sessionId, lease, event.tools);
        return;
      }
      await contextFor(ctx, runtimeFor, scope, initial);
    },
    async request(scope: ActiveGovernanceScope, event: SessionModelRequest) {
      const lease = captureFence.activeLease(scope.sessionId);
      if (lease !== undefined) {
        captureFence.observeModelRequest(scope.sessionId, lease, event.kind, event.model);
        return;
      }
      if ((await ctx.session.get({ sessionID: event.sessionID })).agent !== REVIEWER_SUBAGENT_TYPE)
        return;
      if (event.kind !== 'primary' || event.agent !== REVIEWER_SUBAGENT_TYPE)
        throw buildEnforcementError(
          'REVIEWER_EXECUTION_OUTCOME_UNKNOWN',
          'Auxiliary reviewer requests are not authorized by dispatch.',
        );
      await childLineage(runtimeFor, scope);
      initial.request(
        scope.sessionId,
        await ctx.session.context({ sessionID: scope.sessionId }),
        event.model,
      );
    },
  };
}

function guardReviewerTool(
  fence: NativeReviewCaptureFence,
  scope: ActiveGovernanceScope,
  event: { readonly agent: string; readonly tool: string },
): void {
  if (event.agent !== REVIEWER_SUBAGENT_TYPE) return;
  fence.beforeTool(scope.sessionId);
  if (!READ_ONLY_HOST_TOOLS.has(event.tool))
    throw buildEnforcementError(
      'REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE',
      'Reviewer dispatch does not authorize mutations, child delegation or workflow decisions.',
    );
}

export function createNativeReviewerAuthority(ctx: Plugin.Context, runtimeFor: RuntimeFor) {
  const captureFence = new NativeReviewCaptureFence();
  const initial = new NativeReviewInitialController();
  const authority = {
    async authorize(scope: ActiveGovernanceScope, event: NativeBefore) {
      if (scope.sessionId !== scope.root.sessionId || event.sessionID !== scope.root.sessionId)
        return deny('Delegated children cannot authorize independent review operations.');
      const args = event.input as Record<string, unknown>;
      if (
        args.agent !== REVIEWER_SUBAGENT_TYPE ||
        (args.background !== undefined && args.background !== false) ||
        Object.keys(args).some(
          (key) => !['agent', 'background', 'description', 'prompt'].includes(key),
        )
      )
        return deny(
          'Reviewer release requires a fresh foreground native child without continuation or model overrides.',
        );
      const resolved = await stateFor(runtimeFor, scope);
      const prompt = await authorizeNativeReviewDispatch({
        deps: resolved.runtime.ws,
        sessDir: resolved.sessDir,
        state: resolved.state,
        authority: resolved.authority,
        enforcement: resolved.runtime.ws.getEnforcementState(scope.root.sessionId),
        hostCallId: encodeHostCallId(event.sessionID, event.messageID, event.id),
        proof: { evaluateProofGraphGate, renderPlanClaimDeclarations },
      });
      args.prompt = prompt;
      args.description = 'FlowGuard independent review';
      args.background = false;
    },
    async bind(
      scope: ActiveGovernanceScope,
      dispatch: GovernanceDelegationDispatch,
      childSessionId: string,
    ) {
      if (dispatch.sessionId !== scope.root.sessionId || dispatch.requestedChildSessionId !== null)
        return deny('Reviewer enrollment must originate from a fresh root review dispatch.');
      const resolved = await stateFor(runtimeFor, scope);
      await bindNativeReviewChild({
        deps: resolved.runtime.ws,
        sessDir: resolved.sessDir,
        authority: resolved.authority,
        hostCallId: encodeHostCallId(dispatch.sessionId, dispatch.messageId, dispatch.callId),
        childSessionId,
      });
    },
    async validate(scope: ActiveGovernanceScope) {
      await childLineage(runtimeFor, scope);
    },
    async capture(scope: ActiveGovernanceScope, event: NativeReviewCompletion) {
      await runNativeReviewerCapture({
        ctx,
        runtimeFor,
        fence: captureFence,
        initial,
        scope,
        event,
      });
    },
    async beforeTool(
      scope: ActiveGovernanceScope,
      event: { readonly agent: string; readonly tool: string },
    ) {
      guardReviewerTool(captureFence, scope, event);
    },
    authorizeTool(event: InitialToolBoundary) {
      initial.beforeTool(event);
    },
    afterTool(event: InitialToolBoundary & { readonly status: 'completed' | 'error' }) {
      initial.afterTool(event);
    },
  };
  return {
    ...authority,
    ...createReviewerObservationHooks(ctx, runtimeFor, captureFence, initial),
  };
}
