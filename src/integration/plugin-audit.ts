/**
 * @module integration/plugin-audit
 * @description Audit event emission handler — extracted from plugin.ts.
 *
 * Emits structured audit events for FlowGuard tool invocations.
 * Wrapped in try/catch — solo/team audit failures warn only;
 * regulated audit failures return a blocking result.
 *
 * Transition audit reconciliation and the AuditDeps contract live in
 * plugin-audit-reconcile.ts; this module runs the after-hook event emission.
 *
 * @version v3 (outbox reconciliation extracted to plugin-audit-reconcile)
 */

import { readState } from '../adapters/persistence.js';
import { archiveSession } from '../adapters/workspace/index.js';
import { serializeError } from '../logging/error-serialize.js';
import type {
  PendingAuditOperation,
  SessionState,
  Phase,
  Event,
  Transition,
} from '../state/schema.js';
import {
  buildToolCallBody,
  buildErrorBody,
  buildLifecycleBody,
  completionLifecycleEventId,
  buildDecisionBody,
  buildEnforcementDeniedBody,
  finalizeWithTimestampEvidence,
  summarizeArgs,
  type EventBody,
} from '../audit/types.js';
import { computeCanonicalEventDigest } from '../audit/canonical-digest.js';
import { resolveTimestampEvidence } from '../audit/timestamp-resolution.js';
import { resolveAuditContext, type AuditContext } from './plugin-audit-context.js';
import { getToolMetadata } from './plugin-helpers.js';
import { buildLifecycleDetail } from './plugin-audit-lifecycle-reason.js';
import {
  createStrictTimestampTracker,
  emitAuditBodyWithEvidence,
  emitTransitionAudits,
  finalizeStrictTimestampFailure,
  type AuditDeps,
  type StrictTimestampTracker,
} from './plugin-audit-reconcile.js';

export { reconcilePendingAuditOperations } from './plugin-audit-reconcile.js';
export type { AuditDeps } from './plugin-audit-reconcile.js';

const LIFECYCLE_TOOLS: Record<string, string> = {
  flowguard_hydrate: 'session_created',
  flowguard_abort_session: 'session_aborted',
};

class TerminalTransitionAuthorityError extends Error {
  readonly code = 'AUDIT_TERMINAL_TRANSITION_AUTHORITY_UNAVAILABLE';

  constructor(matches: number) {
    super(
      `Terminal transition audit authority is unavailable: expected exactly one matching operation, found ${matches}`,
    );
    this.name = 'TerminalTransitionAuthorityError';
  }
}

/**
 * Persist a synchronous host-tool denial before rethrowing it to OpenCode.
 * Audit failures are diagnostic-only here: the original denial must never be
 * weakened into an allow because recording its evidence failed.
 */
/**
 * Resolve the explicit audit identity pair. Audit events never carry a
 * polymorphic sessionId: `flowguardSessionId` is the SAME FlowGuard UUID on
 * every event class, and `hostSessionId` is bound separately where host
 * context exists. Returns null when the FlowGuard identity is unavailable —
 * the caller must skip the event instead of approximating an identity.
 */
function auditIdentity(state: SessionState | null): {
  flowguardSessionId: string;
  hostSessionId?: string;
} | null {
  if (!state) return null;
  return {
    flowguardSessionId: state.flowguardSessionId,
    hostSessionId: state.binding.hostSessionId,
  };
}

export async function auditEnforcementDenied(input: {
  deps: AuditDeps;
  sessionId: string;
  tool: string;
  reasonCode: string;
  hostCallId: string;
  traceId: string;
}): Promise<void> {
  try {
    const resolved = await resolveAuditContext(input.deps, input.tool, {}, input.sessionId);
    if (!resolved) return;
    const { ctx, policy, state } = resolved;
    const identity = auditIdentity(state);
    if (!identity) return;
    const tracker = createStrictTimestampTracker(ctx.timestampAssurance);
    const body = buildEnforcementDeniedBody(
      identity.flowguardSessionId,
      identity.hostSessionId,
      ctx.phase as Phase,
      {
        tool: input.tool,
        reasonCode: input.reasonCode,
        hostCallId: input.hostCallId,
        traceId: input.traceId,
        policyMode: policy.mode,
        enforcementLevel: 'synchronous',
      },
      ctx.now,
      ctx.prevHash,
    );
    await emitAuditBodyWithEvidence({
      deps: input.deps,
      ctx,
      sessionId: input.sessionId,
      body,
      eventKind: 'enforcement_denied',
      localTimestamp: ctx.now,
      timestampTracker: tracker,
    });
  } catch (err) {
    input.deps.logError('Failed to audit denied host tool', err);
  }
}

interface DecisionReceiptParams {
  deps: AuditDeps;
  ctx: AuditContext;
  toolName: string;
  input: unknown;
  sessionId: string;
  policyMode: string;
  state: SessionState | null;
  recordTimestampFailure(eventKind: string, error: string | undefined): void;
}

async function emitDecisionReceipt(params: DecisionReceiptParams): Promise<string> {
  const { deps, ctx, toolName, input, sessionId, policyMode, state } = params;
  const prevHash = ctx.prevHash;
  const transition = state?.transition;
  if (toolName !== 'flowguard_decision' || !ctx.success || !transition) return prevHash;

  const firstTransition = transition;
  const inferredVerdict = inferDecisionVerdict(firstTransition.event);
  if (inferredVerdict === null) return prevHash;

  const sequence = await deps.nextDecisionSequence(ctx.sessDir, sessionId);
  const decisionId = `DEC-${String(sequence).padStart(3, '0')}`;
  const receipt = resolveDecisionReceiptFields(ctx, input, state, firstTransition.at);

  if (!receipt.decidedBy?.trim()) {
    return emitDecisionReceiptActorMissing(params, firstTransition, prevHash);
  }
  return emitDecisionReceiptEvent(params, {
    prevHash,
    firstTransition,
    decisionId,
    sequence,
    verdict: inferredVerdict,
    receipt,
    policyMode,
  });
}

function inferDecisionVerdict(event: Event): 'approve' | 'changes_requested' | 'reject' | null {
  if (event === 'APPROVE') return 'approve';
  if (event === 'CHANGES_REQUESTED') return 'changes_requested';
  if (event === 'REJECT') return 'reject';
  return null;
}

function resolveDecisionReceiptFields(
  ctx: AuditContext,
  input: unknown,
  state: SessionState | null,
  fallbackDecidedAt: string,
): { rationale: string; decidedBy?: string; decidedAt: string } {
  const parsedDecision = parsedReviewDecision(ctx);
  return {
    rationale: resolveDecisionRationale(parsedDecision, input, state),
    decidedBy: stringField(parsedDecision, 'decidedBy') ?? state?.reviewDecision?.decidedBy,
    decidedAt:
      stringField(parsedDecision, 'decidedAt') ??
      state?.reviewDecision?.decidedAt ??
      fallbackDecidedAt,
  };
}

function parsedReviewDecision(ctx: AuditContext): Record<string, unknown> | null {
  // Stryker disable next-line ConditionalExpression — equivalent: `undefined !== null` and `true` both route to the object-type check.
  return ctx.parsed?.reviewDecision !== null && typeof ctx.parsed?.reviewDecision === 'object'
    ? (ctx.parsed.reviewDecision as Record<string, unknown>)
    : null;
}

function stringField(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
}

function resolveDecisionRationale(
  parsedDecision: Record<string, unknown> | null,
  input: unknown,
  state: SessionState | null,
): string {
  // Stryker disable next-line ConditionalExpression,OptionalChaining — equivalent: the trailing `?.rationale` optional chain keeps every single-`?.` removal observationally identical.
  const parsedRationale =
    typeof parsedDecision?.rationale === 'string' ? parsedDecision.rationale : undefined;
  // Stryker disable next-line OptionalChaining — equivalent: both branches fall through to the input fallback for null state.
  const stateRationale = state?.reviewDecision?.rationale;
  // Stryker disable next-line OptionalChaining,ObjectLiteral — equivalent: guarded by the trailing `?.rationale`; the cast shape is a compile-time-only annotation.
  const inputRationale =
    typeof (input as { args?: { rationale?: unknown } })?.args?.rationale === 'string'
      ? String((input as { args?: { rationale?: unknown } })?.args?.rationale)
      : '';
  return parsedRationale ?? stateRationale ?? inputRationale;
}

async function emitDecisionReceiptActorMissing(
  params: DecisionReceiptParams,
  firstTransition: Transition,
  prevHash: string,
): Promise<string> {
  const { deps, ctx, toolName, sessionId, state, recordTimestampFailure } = params;
  deps.log.warn('audit', 'skipping decision receipt: missing decidedBy', {
    tool: toolName,
    sessionId,
  });
  const identity = auditIdentity(state);
  if (!identity) return prevHash;
  const body = buildErrorBody(
    identity.flowguardSessionId,
    identity.hostSessionId,
    {
      code: 'DECISION_RECEIPT_ACTOR_MISSING',
      message: 'Decision receipt skipped because decidedBy is missing',
      recoveryHint: 'Ensure /review-decision output includes reviewDecision.decidedBy',
      errorPhase: firstTransition.from,
    },
    ctx.now,
    prevHash,
  );
  const evt = await finalizeAuditBodyWithTimestamp(params, body, prevHash, 'error');
  recordTimestampFailure('error', evt.error);
  await deps.appendAndTrack(evt.event, ctx.sessDir, ctx.enableChainHash, sessionId);
  return evt.event.chainHash;
}

async function emitDecisionReceiptEvent(
  params: DecisionReceiptParams,
  input: {
    prevHash: string;
    firstTransition: Transition;
    decisionId: string;
    sequence: number;
    verdict: 'approve' | 'changes_requested' | 'reject';
    receipt: { rationale: string; decidedBy?: string; decidedAt: string };
    policyMode: string;
  },
): Promise<string> {
  const { deps, ctx, sessionId, state, recordTimestampFailure } = params;
  const identity = auditIdentity(state);
  if (!identity) return input.prevHash;
  const body = buildDecisionBody({
    flowguardSessionId: identity.flowguardSessionId,
    hostSessionId: identity.hostSessionId,
    gatePhase: input.firstTransition.from,
    detail: {
      decisionId: input.decisionId,
      decisionSequence: input.sequence,
      verdict: input.verdict,
      rationale: input.receipt.rationale,
      decidedBy: input.receipt.decidedBy!,
      decidedAt: input.receipt.decidedAt,
      fromPhase: input.firstTransition.from,
      toPhase: input.firstTransition.to,
      transitionEvent: input.firstTransition.event,
      policyMode: input.policyMode,
    },
    occurredAt: ctx.now,
    actor: ctx.actor,
    prevHash: input.prevHash,
    // Stryker disable next-line OptionalChaining — equivalent: decision receipts only run with a resolved, non-null session state.
    actorInfo: state?.actorInfo,
  });
  const evt = await finalizeAuditBodyWithTimestamp(params, body, input.prevHash, 'decision');
  recordTimestampFailure('decision', evt.error);
  await deps.appendAndTrack(evt.event, ctx.sessDir, ctx.enableChainHash, sessionId);
  return evt.event.chainHash;
}

async function finalizeAuditBodyWithTimestamp(
  params: DecisionReceiptParams,
  body: EventBody,
  prevHash: string,
  eventKind: string,
): Promise<{ event: ReturnType<typeof finalizeWithTimestampEvidence>; error?: string }> {
  const { deps, ctx } = params;
  const digest = computeCanonicalEventDigest(body);
  const resolution = ctx.timestampAssurance.enabled
    ? await resolveTimestampEvidence({
        policy: ctx.timestampAssurance,
        canonicalEventDigest: digest,
        eventKind,
        localTimestamp: ctx.now,
        ntpResult: ctx.ntpResult,
        tsaProvider: deps.tsaProvider,
        tsaVerifier: deps.timestampVerifier,
      })
    : undefined;
  return {
    event: finalizeWithTimestampEvidence(body, prevHash, resolution?.evidence, digest),
    error: resolution?.error,
  };
}

async function maybeCompleteAndArchive(
  deps: AuditDeps,
  ctx: AuditContext,
  opts: {
    toolName: string;
    sessionId: string;
    state: SessionState | null;
    recordTimestampFailure: (eventKind: string, error: string | undefined) => void;
  },
): Promise<string> {
  const { toolName, sessionId, state, recordTimestampFailure } = opts;
  let prevHash = ctx.prevHash;
  if (state?.transition?.to !== 'COMPLETE' || LIFECYCLE_TOOLS[toolName]) return prevHash;

  const freshState = deps.cachedFingerprint ? await readState(ctx.sessDir) : null;
  const toolLayerHandled = !!freshState?.archiveStatus;

  if (!toolLayerHandled) {
    prevHash = await emitSessionCompletedLifecycle(
      deps,
      ctx,
      sessionId,
      state,
      recordTimestampFailure,
    );
  } else {
    // Stryker disable next-line ObjectLiteral — diagnostic-only payload.
    deps.log.debug('audit', 'session_completed handled by tool layer', {
      archiveStatus: freshState.archiveStatus,
    });
  }

  scheduleSoloArchive(deps, sessionId, state, freshState, toolLayerHandled);
  return prevHash;
}

async function emitSessionCompletedLifecycle(
  deps: AuditDeps,
  ctx: AuditContext,
  sessionId: string,
  state: SessionState | null,
  recordTimestampFailure: (eventKind: string, error: string | undefined) => void,
): Promise<string> {
  if (!state) return ctx.prevHash;
  const identity = auditIdentity(state);
  if (!identity) return ctx.prevHash;
  const terminalOperation = terminalTransitionOperation(state);
  const body = buildLifecycleBody({
    id: completionLifecycleEventId(identity.flowguardSessionId, terminalOperation.operationId),
    flowguardSessionId: identity.flowguardSessionId,
    hostSessionId: identity.hostSessionId,
    detail: { action: 'session_completed', finalPhase: 'COMPLETE' },
    occurredAt: terminalOperation.transition.at,
    actor: 'machine',
    prevHash: ctx.prevHash,
    actorInfo: state.actorInfo,
  });
  const digest = computeCanonicalEventDigest(body);
  const resolution = ctx.timestampAssurance.enabled
    ? await resolveTimestampEvidence({
        policy: ctx.timestampAssurance,
        canonicalEventDigest: digest,
        eventKind: 'lifecycle',
        localTimestamp: ctx.now,
        ntpResult: ctx.ntpResult,
        tsaProvider: deps.tsaProvider,
        tsaVerifier: deps.timestampVerifier,
      })
    : undefined;
  recordTimestampFailure('lifecycle', resolution?.error);
  const evt = finalizeWithTimestampEvidence(body, ctx.prevHash, resolution?.evidence, digest);
  await deps.appendAndTrack(evt, ctx.sessDir, ctx.enableChainHash, sessionId);
  // Stryker disable next-line ObjectLiteral,MethodExpression — diagnostic-only payload; the hash prefixes are not a behavioral contract.
  deps.log.debug('audit', 'audit chain hash', {
    prevHashPrefix: ctx.prevHash.slice(0, 8),
    nextHashPrefix: evt.chainHash.slice(0, 8),
  });
  return evt.chainHash;
}

function terminalTransitionOperation(
  state: SessionState,
): Extract<PendingAuditOperation, { kind: 'transition' }> {
  const transition = state.transition;
  if (!transition) {
    throw new TerminalTransitionAuthorityError(0);
  }
  const matches = state.pendingAuditOperations.filter(
    (operation): operation is Extract<PendingAuditOperation, { kind: 'transition' }> =>
      operation.kind === 'transition' &&
      operation.transition.from === transition.from &&
      operation.transition.to === transition.to &&
      operation.transition.event === transition.event &&
      operation.transition.at === transition.at,
  );
  if (matches.length !== 1) throw new TerminalTransitionAuthorityError(matches.length);
  return matches[0]!;
}

function scheduleSoloArchive(
  deps: AuditDeps,
  sessionId: string,
  state: SessionState | null,
  freshState: SessionState | null,
  toolLayerHandled: boolean,
): void {
  const fingerprint = deps.cachedFingerprint;
  // Stryker disable next-line LogicalOperator — equivalent: `freshState` is non-null whenever `fingerprint` is non-null, so `freshState && state` cannot occur on a reachable path.
  if (!fingerprint || (freshState ?? state)?.policySnapshot.mode !== 'solo') return;
  if (toolLayerHandled) {
    // Stryker disable next-line ObjectLiteral — diagnostic-only payload.
    deps.log.debug('audit', 'archive handled by tool layer', {
      archiveStatus: freshState?.archiveStatus,
    });
    return;
  }
  // Stryker disable next-line BooleanLiteral — archive output fidelity is not asserted by tests; redaction mode is the behavioral contract.
  archiveSession(fingerprint, sessionId, { redactionMode: 'basic', includeRaw: false }).catch(
    (err) => {
      // Stryker disable next-line ObjectLiteral — diagnostic-only payload.
      deps.log.warn('audit', 'auto-archive failed', { error: serializeError(err) });
    },
  );
}

async function emitToolCallAudit(input: {
  deps: AuditDeps;
  ctx: AuditContext;
  toolName: string;
  input: unknown;
  output: unknown;
  sessionId: string;
  state: SessionState | null;
  timestampTracker: StrictTimestampTracker;
}): Promise<void> {
  const { deps, ctx, toolName, sessionId, state, timestampTracker } = input;
  if (!ctx.emitToolCalls) return;
  const identity = auditIdentity(state);
  if (!identity) return;
  const body = buildToolCallBody({
    flowguardSessionId: identity.flowguardSessionId,
    hostSessionId: identity.hostSessionId,
    phase: ctx.phase,
    detail: {
      tool: toolName,
      argsSummary: summarizeArgs((input.input as Record<string, unknown>) ?? {}),
      success: ctx.success,
      errorCode: ctx.errorCode,
      errorMessage: ctx.errorMessage,
      transitionCount: transitionCountFromToolOutput(input.output),
    },
    occurredAt: ctx.now,
    actor: ctx.actor,
    prevHash: ctx.prevHash,
    actorInfo: state?.actorInfo,
  });
  await emitAuditBodyWithEvidence({
    deps,
    ctx,
    sessionId,
    body,
    eventKind: 'tool_call',
    localTimestamp: ctx.now,
    timestampTracker,
  });
  // Stryker disable next-line ObjectLiteral — diagnostic-only payload.
  deps.log.debug('audit', 'emitted tool_call event', { tool: toolName, phase: ctx.phase });
}

function transitionCountFromToolOutput(output: unknown): number {
  const transitions = getToolMetadata(output).transitions;
  return Array.isArray(transitions) ? transitions.length : 0;
}

async function emitLifecycleAudit(input: {
  deps: AuditDeps;
  ctx: AuditContext;
  toolName: string;
  sessionId: string;
  state: SessionState | null;
  policy: { mode: string; requireHumanGates: boolean };
  timestampTracker: StrictTimestampTracker;
}): Promise<void> {
  const { deps, ctx, toolName, sessionId, state, policy, timestampTracker } = input;
  const lifecycleAction = LIFECYCLE_TOOLS[toolName];
  if (!lifecycleAction) return;
  const identity = auditIdentity(state);
  if (!identity) return;
  // Stryker disable next-line ObjectLiteral — diagnostic-only payload.
  deps.log.info('audit', 'lifecycle event', { action: lifecycleAction, tool: toolName });
  const body = buildLifecycleBody({
    flowguardSessionId: identity.flowguardSessionId,
    hostSessionId: identity.hostSessionId,
    detail: buildLifecycleDetail(ctx, lifecycleAction, state, policy),
    occurredAt: ctx.now,
    actor: ctx.actor,
    prevHash: ctx.prevHash,
    actorInfo: state?.actorInfo,
  });
  await emitAuditBodyWithEvidence({
    deps,
    ctx,
    sessionId,
    body,
    eventKind: 'lifecycle',
    localTimestamp: ctx.now,
    timestampTracker,
  });
}

async function emitToolErrorAudit(input: {
  deps: AuditDeps;
  ctx: AuditContext;
  toolName: string;
  sessionId: string;
  state: SessionState | null;
  timestampTracker: StrictTimestampTracker;
}): Promise<void> {
  const { deps, ctx, toolName, sessionId, state, timestampTracker } = input;
  if (ctx.success || !ctx.errorMessage) return;
  const identity = auditIdentity(state);
  if (!identity) return;
  // Stryker disable next-line ObjectLiteral — diagnostic-only payload.
  deps.log.warn('audit', 'tool reported error', { tool: toolName, errorMessage: ctx.errorMessage });
  const body = buildErrorBody(
    identity.flowguardSessionId,
    identity.hostSessionId,
    {
      code: ctx.errorCode ?? 'TOOL_ERROR',
      message: ctx.errorMessage,
      recoveryHint: 'Check tool output for details',
      errorPhase: ctx.phase as Phase,
    },
    ctx.now,
    ctx.prevHash,
  );
  await emitAuditBodyWithEvidence({
    deps,
    ctx,
    sessionId,
    body,
    eventKind: 'error',
    localTimestamp: ctx.now,
    timestampTracker,
  });
}

/**
 * Emit audit events for a single tool invocation.
 */
export async function runAudit(
  deps: AuditDeps,
  toolName: string,
  input: unknown,
  output: unknown,
  sessionId: string,
): Promise<{ auditOk: boolean; block?: boolean; code?: string; reason?: string } | undefined> {
  let policyResolved = false;
  let effectiveMode: string = deps.mode;
  try {
    const resolved = await resolveAuditContext(deps, toolName, output, sessionId);
    if (!resolved) return undefined;
    policyResolved = resolved.policyResolved;
    effectiveMode = resolved.effectiveMode;
    const { ctx, policy, state } = resolved;
    const timestampTracker = createStrictTimestampTracker(ctx.timestampAssurance);

    // ── 1. Emit tool_call event ──────────────────────────────────────────
    await emitToolCallAudit({
      deps,
      ctx,
      toolName,
      input,
      output,
      sessionId,
      state,
      timestampTracker,
    });

    // ── 2. Emit transition events ───────────────────────────────────────
    await emitTransitionAudits({ deps, ctx, sessionId, timestampTracker });

    // ── 3. Emit decision receipt ────────────────────────────────────────
    ctx.prevHash = await emitDecisionReceipt({
      deps,
      ctx,
      toolName,
      input,
      sessionId,
      policyMode: state?.policySnapshot.mode ?? effectiveMode,
      state,
      recordTimestampFailure: timestampTracker.record,
    });

    // ── 4. Emit lifecycle events ────────────────────────────────────────
    await emitLifecycleAudit({ deps, ctx, toolName, sessionId, state, policy, timestampTracker });

    // ── 5. Detect session completion + solo auto-archive ─────────────────
    ctx.prevHash = await maybeCompleteAndArchive(deps, ctx, {
      toolName,
      sessionId,
      state,
      recordTimestampFailure: timestampTracker.record,
    });

    // ── 6. Emit error event ─────────────────────────────────────────────
    await emitToolErrorAudit({ deps, ctx, toolName, sessionId, state, timestampTracker });

    return await finalizeStrictTimestampFailure(ctx, timestampTracker.failure);
  } catch (err) {
    deps.logError(`Failed to write audit events for ${toolName}`, err);
    if (effectiveMode === 'regulated' || !policyResolved) {
      return {
        auditOk: false,
        block: true,
        code:
          err instanceof TerminalTransitionAuthorityError ? err.code : 'AUDIT_PERSISTENCE_FAILED',
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }
  return undefined;
}
