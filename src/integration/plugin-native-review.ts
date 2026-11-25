/** V2 hook composition consumes canonical dispatch, initial-run and capture owners. */
import { randomUUID } from 'node:crypto';
import type { Plugin } from '@opencode/plugin';
import type { SessionPrompt, SessionModelRequest } from '@opencode/plugin/promise/session';
import { evaluateProofGraphGate } from '../audit/proofgraph/gate.js';
import { renderPlanClaimDeclarations } from '../presentation/plan-claim-declarations.js';
import { hashText } from '../shared/hashing.js';
import { REVIEWER_SUBAGENT_TYPE } from '../shared/flowguard-identifiers.js';
import type { GovernanceDelegationDispatch } from '../state/governance-activation.js';
import type { FlowGuardPluginRuntime } from './plugin-shared.js';
import { buildEnforcementError } from './blocked-result.js';
import { encodeHostCallId } from '../state/host-identity.js';
import { projectFulfilledReview } from './review/dispatch/native-review-execution.js';
import {
  guardPreBindReview,
  reconcileExpiredAuthorizedDispatchesOrThrow,
} from './review/dispatch/native-review-execution.js';
import {
  NativeReviewCaptureFence,
  executeNativeReviewCapture,
  type NativeCaptureHost,
} from './review/dispatch/native-review-capture.js';
import {
  blockedCaptureOutput,
  closeNativeReviewerCapture,
  closeUnknownOutcomeCapture,
} from './review/dispatch/native-review-capture-failure.js';
import {
  NativeReviewInitialController,
  type InitialToolBoundary,
  type InitialToolCompletion,
  toolResultMismatch,
  isInitialReviewerTool,
} from './review/dispatch/native-review-initial.js';
import { awaitReviewerInitialRun } from './plugin-native-events.js';
import { replayAndPersistObservations } from './review/observations/observation-replay-persist.js';
import type { ActiveGovernanceScope, NativeBefore } from './opencode-governance.js';
import {
  assertLaterUserTurn,
  proveChildSettled,
  reopenAuditIntents,
  reopenUnknownOutcome,
  unknownOutcomeTarget,
} from './review/dispatch/native-review-settlement.js';
import {
  obligationTypeForTool,
  resolveReviewObligationTool,
} from './review/obligations/obligation-tools.js';
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

function isUnknownOutcomeError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as Error & { code?: unknown }).code === 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN'
  );
}

async function resolveCaptureTarget(input: {
  readonly ctx: Plugin.Context;
  readonly runtimeFor: RuntimeFor;
  readonly scope: ActiveGovernanceScope;
  readonly event: NativeReviewCompletion;
}): Promise<Awaited<ReturnType<typeof resolveObservedCaptureTarget>>> {
  try {
    return await resolveObservedCaptureTarget(input.runtimeFor, input.scope, input.event);
  } catch (error) {
    // Preserve the successful-path ordering exactly; the additional identity
    // reads happen only on the failed-child path.
    if (input.event.status === 'completed' || !isUnknownOutcomeError(error)) throw error;
    const metadata = metadataFor(input.event);
    const childSessionId =
      typeof metadata.sessionID === 'string' && metadata.sessionID.length > 0
        ? metadata.sessionID
        : undefined;
    let nativeCallId: string | undefined;
    try {
      nativeCallId = encodeHostCallId(input.event.sessionID, input.event.messageID, input.event.id);
    } catch {
      nativeCallId = undefined;
    }
    if (childSessionId === undefined || nativeCallId === undefined) throw error;
    await closeUnknownOutcomeCapture({
      ctx: input.ctx,
      childSessionId,
      nativeCallId,
      resolveDeps: async () => {
        const resolved = await stateFor(input.runtimeFor, input.scope);
        return { deps: resolved.runtime.orchestratorDeps, sessDir: resolved.sessDir };
      },
    });
    throw error;
  }
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

function setCaptureContent(
  event: NativeReviewCompletion,
  content: unknown,
  metadata: Record<string, unknown>,
): void {
  event.result = { ...(event.result ?? {}), content, metadata: { ...metadata } };
}

async function preBindBlockedCapture(
  runtimeFor: RuntimeFor,
  scope: ActiveGovernanceScope,
  event: NativeReviewCompletion,
): Promise<string | null> {
  let nativeCallId: string;
  try {
    nativeCallId = encodeHostCallId(event.sessionID, event.messageID, event.id);
  } catch {
    return null;
  }
  const resolved = await stateFor(runtimeFor, scope);
  const childSessionId = metadataFor(event).sessionID;
  const matches = (resolved.state.reviewAssurance?.dispatches ?? []).filter(
    (dispatch) => dispatch.hostCallId === nativeCallId,
  );
  const direct = matches[0];
  const candidates = direct
    ? [direct.obligationId]
    : (resolved.state.reviewAssurance?.attempts ?? [])
        .filter(
          (attempt) =>
            typeof childSessionId === 'string' && attempt.childSessionId === childSessionId,
        )
        .map((attempt) => attempt.obligationId);
  const obligationIds = [...new Set(candidates)];
  if (obligationIds.length !== 1) return null;
  const obligationId = obligationIds[0];
  if (obligationId === undefined) return null;
  const output = { title: '', output: '', metadata: {} };
  const blocked = await guardPreBindReview({
    runtime: resolved.runtime,
    sessDir: resolved.sessDir,
    obligationId,
    output,
  });
  return blocked ? output.output : null;
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

async function resolveObservedCaptureTarget(
  runtimeFor: RuntimeFor,
  scope: ActiveGovernanceScope,
  event: NativeReviewCompletion,
) {
  const target = await resolveNativeCaptureTarget(runtimeFor, scope, event);
  if (target.lineage.attempt.observationCapability) {
    await replayAndPersistObservations(
      {
        resolveSessionAuthority: (id) => target.resolved.runtime.ws.resolveSessionAuthority(id),
        updateReviewAssurance: target.resolved.runtime.orchestratorDeps.updateReviewAssurance,
        log: target.resolved.runtime.log,
        logError: target.resolved.runtime.logError,
      },
      {
        sessionId: scope.root.sessionId,
        childSessionId: target.childSessionId,
        attemptId: target.lineage.attempt.attemptId,
        now: new Date().toISOString(),
      },
    );
  }
  // Re-read authority after canonical observation persistence; findings validation
  // must use the bound observations, not the pre-replay state snapshot.
  return resolveNativeCaptureTarget(runtimeFor, scope, event);
}

function captureHost(ctx: Plugin.Context): NativeCaptureHost {
  return {
    context: (sessionID) => ctx.session.context({ sessionID }),
    mintRequestMessageId: () => `msg_${randomUUID().replaceAll('-', '')}`,
    prompt: (prompt) => ctx.session.prompt(prompt),
    wait: (sessionID) => ctx.session.wait({ sessionID }),
  };
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
  const preBind = await preBindBlockedCapture(runtimeFor, scope, event);
  if (preBind !== null) {
    setCaptureContent(event, preBind, metadataFor(event));
    return;
  }
  await awaitReviewerInitialRun({
    ctx,
    initial: input.initial,
    event,
    resolve: () => stateFor(runtimeFor, scope).catch(() => null),
  });
  const { resolved, metadata, childSessionId, nativeCallId, lineage } = await resolveCaptureTarget({
    ctx,
    runtimeFor,
    scope,
    event,
  });
  const blocked = (code: string, reason: string): void =>
    setCaptureContent(event, blockedCaptureOutput(code, reason), metadata);
  const outcome = await executeNativeReviewCapture({
    initial: input.initial,
    host: captureHost(ctx),
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
  const closure = await closeNativeReviewerCapture({
    runtime: resolved.runtime,
    sessDir: resolved.sessDir,
    authority: resolved.authority,
    nativeCallId,
    childSessionId,
    obligationId: lineage.obligation.obligationId,
    attemptId: lineage.attempt.attemptId,
    outcome,
  });
  if (closure.kind === 'retry') {
    event.result = {
      ...(event.result ?? {}),
      content: closure.output,
      metadata: { ...metadata },
    };
    return;
  }
  blocked(closure.code, closure.reason);
}

type Registration = { dispose(): Promise<void> };
/**
 * Per-child tail hooks registered at admission; they run after every
 * setup-time hook so replaced or rewritten tool results invalidate the run.
 */
function createResultIntegrityTails(
  ctx: Plugin.Context,
  captureFence: NativeReviewCaptureFence,
  initial: NativeReviewInitialController,
) {
  const tails = new Map<string, Registration[]>();
  const release = async (child: string) => {
    const registrations = tails.get(child) ?? [];
    tails.delete(child);
    await Promise.all(registrations.map((registration) => registration.dispose()));
  };
  return {
    async attach(child: string) {
      if (tails.has(child)) return;
      const registrations: Registration[] = [];
      tails.set(child, registrations);
      registrations.push(
        await ctx.tool.hook('execute.after', (event) => {
          if (
            event.sessionID === child &&
            event.agent === REVIEWER_SUBAGENT_TYPE &&
            isInitialReviewerTool(event.tool)
          )
            initial.afterToolTail(event);
        }),
      );
      registrations.push(
        await ctx.session.hook('context', async (event) => {
          if (event.sessionID !== child) return;
          const mismatch = toolResultMismatch(
            event.messages,
            await ctx.session.context({ sessionID: child }),
          );
          if (mismatch === null) return;
          if (captureFence.activeLease(child) !== undefined) captureFence.taint(child, mismatch);
          initial.violate(child, mismatch);
        }),
      );
    },
    release,
    async dispose() {
      await Promise.all([...tails.keys()].map(release));
    },
  };
}
function createReviewerObservationHooks(
  ctx: Plugin.Context,
  runtimeFor: RuntimeFor,
  captureFence: NativeReviewCaptureFence,
  initial: NativeReviewInitialController,
  tails: ReturnType<typeof createResultIntegrityTails>,
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
      await tails.attach(scope.sessionId);
    },
    async context(
      scope: ActiveGovernanceScope,
      event: { readonly tools: Record<string, unknown> },
    ) {
      const lease = captureFence.activeLease(scope.sessionId);
      if (lease !== undefined || initial.hasOpenInitialRun(scope.sessionId))
        initial.restrictTools(event.tools);
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
  if (!isInitialReviewerTool(event.tool))
    throw buildEnforcementError(
      'REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE',
      'Reviewer dispatch does not authorize mutations, child delegation or workflow decisions.',
    );
}

type NativeToolBefore = {
  readonly agent: string;
  readonly tool: string;
  readonly sessionID: string;
  readonly input: unknown;
};
/**
 * Reopen an unknown-outcome review only from proven later-user-turn,
 * settled-child and durable-lineage evidence.
 */
async function settleUnknownReviewerOutcome(
  ctx: Plugin.Context,
  runtimeFor: RuntimeFor,
  scope: ActiveGovernanceScope,
  event: NativeToolBefore,
): Promise<void> {
  const input = event.input as Record<string, unknown> | null;
  const owner = resolveReviewObligationTool(event.tool);
  if (
    owner === undefined ||
    input === null ||
    typeof input !== 'object' ||
    input.reviewRecovery !== 'retry_transport' ||
    scope.sessionId !== scope.root.sessionId ||
    event.sessionID !== scope.root.sessionId
  )
    return;
  const resolved = await stateFor(runtimeFor, scope);
  const target = unknownOutcomeTarget(resolved.state, obligationTypeForTool(owner));
  if (!target) return;
  assertLaterUserTurn(
    await ctx.session.context({ sessionID: scope.root.sessionId }),
    target.dispatch,
  );
  await proveChildSettled(
    {
      context: (sessionID) => ctx.session.context({ sessionID }),
      interrupt: (sessionID) => ctx.session.interrupt({ sessionID, resume: false }),
      wait: (sessionID) => ctx.session.wait({ sessionID }),
    },
    target.attempt.childSessionId,
  );
  await resolved.runtime.ws.updateReviewAssurance(
    resolved.sessDir,
    (state) => reopenUnknownOutcome(state, target),
    reopenAuditIntents(target),
  );
}
async function bindReviewChild(
  runtimeFor: RuntimeFor,
  scope: ActiveGovernanceScope,
  dispatch: GovernanceDelegationDispatch,
  childSessionId: string,
): Promise<void> {
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
}
export function createNativeReviewerAuthority(ctx: Plugin.Context, runtimeFor: RuntimeFor) {
  const captureFence = new NativeReviewCaptureFence();
  const initial = new NativeReviewInitialController();
  const tails = createResultIntegrityTails(ctx, captureFence, initial);
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
      await reconcileExpiredAuthorizedDispatchesOrThrow(
        resolved.runtime,
        scope.root.sessionId,
        resolved.sessDir,
        resolved.state,
      );
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
    bind: (scope: ActiveGovernanceScope, dispatch: GovernanceDelegationDispatch, child: string) =>
      bindReviewChild(runtimeFor, scope, dispatch, child),
    async validate(scope: ActiveGovernanceScope) {
      await childLineage(runtimeFor, scope);
    },
    async capture(scope: ActiveGovernanceScope, event: NativeReviewCompletion) {
      try {
        await runNativeReviewerCapture({
          ctx,
          runtimeFor,
          fence: captureFence,
          initial,
          scope,
          event,
        });
      } finally {
        const child = metadataFor(event).sessionID;
        if (typeof child === 'string') await tails.release(child);
      }
    },
    async beforeTool(scope: ActiveGovernanceScope, event: NativeToolBefore) {
      guardReviewerTool(captureFence, scope, event);
      await settleUnknownReviewerOutcome(ctx, runtimeFor, scope, event);
    },
    authorizeTool(event: InitialToolBoundary) {
      initial.beforeTool(event);
    },
    afterTool(event: InitialToolCompletion) {
      initial.afterTool(event);
    },
    dispose: () => tails.dispose(),
  };
  return {
    ...authority,
    ...createReviewerObservationHooks(ctx, runtimeFor, captureFence, initial, tails),
  };
}
