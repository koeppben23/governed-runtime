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
import type { PendingAuditOperation, SessionState, Phase } from '../state/schema.js';
import {
  buildToolCallBody,
  buildErrorBody,
  buildLifecycleBody,
  completionLifecycleEventId,
  buildEnforcementDeniedBody,
  finalizeWithTimestampEvidence,
  summarizeArgs,
} from '../audit/types.js';
import { computeCanonicalEventDigest } from '../audit/canonical-digest.js';
import { resolveTimestampEvidence } from '../audit/timestamp-resolution.js';
import { resolveAuditContext, type AuditContext } from './plugin-audit-context.js';
import { auditIdentity, emitDecisionReceipt } from './plugin-audit-decisions.js';
import { getToolMetadata } from './plugin-helpers.js';
import { buildLifecycleDetail } from './plugin-audit-lifecycle-reason.js';
import { TOOL_FLOWGUARD_ABORT, TOOL_FLOWGUARD_HYDRATE } from './tool-names.js';
import {
  createStrictTimestampTracker,
  emitAuditBodyWithEvidence,
  emitTransitionAudits,
  finalizeStrictTimestampFailure,
  resolveBootstrapStateExistence,
  type AuditDeps,
  type AuditRunOutcome,
  type StrictTimestampTracker,
} from './plugin-audit-reconcile.js';

export { reconcilePendingAuditOperations } from './plugin-audit-reconcile.js';
export type { AuditDeps } from './plugin-audit-reconcile.js';

const LIFECYCLE_TOOLS: Record<string, string> = {
  [TOOL_FLOWGUARD_HYDRATE]: 'session_created',
  [TOOL_FLOWGUARD_ABORT]: 'session_aborted',
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
    if (!resolved) {
      // This path has no channel to block — the tool call is already denied —
      // so the audit record cannot be made mandatory here. It must still not
      // vanish without trace: a missing mapping for a session that exists (or
      // whose existence cannot be established) is an audit gap, not a
      // non-event. Only positively proven absence is silent.
      const existence = await resolveBootstrapStateExistence(input.deps, input.sessionId);
      if (existence !== 'absent') {
        input.deps.logError(
          'Enforcement denial could not be audited: no authoritative audit session mapping',
          { sessionId: input.sessionId, tool: input.tool, existence },
        );
      }
      return;
    }
    const { ctx, policy, state } = resolved;
    const identity = auditIdentity(state);
    if (!identity) return;
    const tracker = createStrictTimestampTracker(ctx.timestampAssurance);
    const body = buildEnforcementDeniedBody({
      flowguardSessionId: identity.flowguardSessionId,
      hostSessionId: identity.hostSessionId,
      phase: ctx.phase as Phase,
      detail: {
        tool: input.tool,
        reasonCode: input.reasonCode,
        hostCallId: input.hostCallId,
        traceId: input.traceId,
        policyMode: policy.mode,
        enforcementLevel: 'synchronous',
      },
      occurredAt: ctx.now,
      prevHash: ctx.prevHash,
    });
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
  const toolLayerHandled = !!freshState?.regulatedArchiveStatus;

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
      regulatedArchiveStatus: freshState.regulatedArchiveStatus,
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
    ...(identity.hostSessionId !== undefined ? { hostSessionId: identity.hostSessionId } : {}),
    detail: { action: 'session_completed', finalPhase: 'COMPLETE' },
    occurredAt: terminalOperation.transition.at,
    actor: 'machine',
    prevHash: ctx.prevHash,
    ...(state.actorInfo !== undefined ? { actorInfo: state.actorInfo } : {}),
  });
  const digest = computeCanonicalEventDigest(body);
  const resolution = ctx.timestampAssurance.enabled
    ? await resolveTimestampEvidence({
        policy: ctx.timestampAssurance,
        canonicalEventDigest: digest,
        eventKind: 'lifecycle',
        localTimestamp: ctx.now,
        ...(ctx.ntpResult !== undefined ? { ntpResult: ctx.ntpResult } : {}),
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
  const [match] = matches;
  if (match === undefined) throw new TerminalTransitionAuthorityError(matches.length);
  return match;
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
      regulatedArchiveStatus: freshState?.regulatedArchiveStatus,
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
    ...(identity.hostSessionId !== undefined ? { hostSessionId: identity.hostSessionId } : {}),
    phase: ctx.phase,
    detail: {
      tool: toolName,
      argsSummary: summarizeArgs((input.input as Record<string, unknown>) ?? {}),
      success: ctx.success,
      ...(ctx.errorCode !== undefined ? { errorCode: ctx.errorCode } : {}),
      ...(ctx.errorMessage !== undefined ? { errorMessage: ctx.errorMessage } : {}),
      transitionCount: transitionCountFromToolOutput(input.output),
    },
    occurredAt: ctx.now,
    actor: ctx.actor,
    prevHash: ctx.prevHash,
    ...(state?.actorInfo !== undefined ? { actorInfo: state.actorInfo } : {}),
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
    ...(identity.hostSessionId !== undefined ? { hostSessionId: identity.hostSessionId } : {}),
    detail: buildLifecycleDetail(ctx, lifecycleAction, state, policy),
    occurredAt: ctx.now,
    actor: ctx.actor,
    prevHash: ctx.prevHash,
    ...(state?.actorInfo !== undefined ? { actorInfo: state.actorInfo } : {}),
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
): Promise<AuditRunOutcome> {
  let policyResolved = false;
  let effectiveMode: string = deps.mode;
  try {
    const resolved = await resolveAuditContext(deps, toolName, output, sessionId);
    if (!resolved) {
      // Authority symmetry with reconcilePendingAuditOperations: a missing
      // session mapping is NOT proof that the session is absent. The mapping
      // resolves through the cached fingerprint, so a cold process or a
      // transient fingerprint failure yields null for a fully governed
      // session. Returning silently there skips the audit for a governed tool
      // call while reporting success. Only positively proven absence — a tool
      // call outside any session, or a resolved but unhydrated one — may pass.
      const existence = await resolveBootstrapStateExistence(deps, sessionId);
      if (existence === 'absent') return undefined;
      return {
        auditOk: false,
        block: true,
        code: 'AUDIT_SESSION_AUTHORITY_UNAVAILABLE',
        reason:
          'FlowGuard cannot audit this tool call because no authoritative ' +
          'audit session mapping exists. Re-run /hydrate or restore the ' +
          'session workspace before continuing.',
      };
    }
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
