/**
 * @module integration/plugin-audit
 * @description Audit event emission handler — extracted from plugin.ts.
 *
 * Emits structured audit events for FlowGuard tool invocations.
 * Wrapped in try/catch — solo/team audit failures warn only;
 * regulated audit failures return a blocking result.
 *
 * @version v2 (extracted resolveAuditContext, emitDecisionReceipt, maybeCompleteAndArchive)
 */

import { readState, writeState } from '../adapters/persistence.js';
import { archiveSession } from '../adapters/workspace/index.js';
import { serializeError } from '../logging/error-serialize.js';
import type { SessionState, Phase, Event } from '../state/schema.js';
import {
  buildToolCallBody,
  buildTransitionBody,
  buildErrorBody,
  buildLifecycleBody,
  buildDecisionBody,
  finalizeWithTimestampEvidence,
  summarizeArgs,
  type EventBody,
} from '../audit/types.js';
import { computeCanonicalEventDigest } from '../audit/canonical-digest.js';
import { resolveTimestampEvidence } from '../audit/timestamp-resolution.js';
import type { TimestampAssurancePolicy } from '../config/policy-types.js';
import type { TimestampAuthorityProvider, TimestampVerifier } from '../audit/tsa-provider.js';
import { resolveAuditContext, type AuditContext } from './plugin-audit-context.js';
import { buildLifecycleDetail } from './plugin-audit-lifecycle-reason.js';

/** Closure dependencies injected from plugin.ts. */
export interface AuditDeps {
  resolveFingerprint(): Promise<string | null>;
  getSessionDir(sessionId: string): string | null;
  resolveSessionPolicy(sessDir: string): Promise<{
    policy: {
      audit: {
        emitToolCalls: boolean;
        emitTransitions: boolean;
        enableChainHash: boolean;
        timestampAssurance?: TimestampAssurancePolicy;
      };
      actorClassification: Record<string, string>;
      mode: string;
      requireHumanGates: boolean;
    };
    state: SessionState | null;
  }>;
  initChain(sessDir: string | null, sessionId: string): Promise<string>;
  invalidateChainState(sessionId: string): void;
  appendAndTrack(
    event: { chainHash?: string },
    sessDir: string,
    enableChainHash: boolean,
    sessionId: string,
  ): Promise<void>;
  nextDecisionSequence(sessDir: string, sessionId: string): Promise<number>;
  log: {
    debug(service: string, message: string, extra?: Record<string, unknown>): void;
    info(service: string, message: string, extra?: Record<string, unknown>): void;
    warn(service: string, message: string, extra?: Record<string, unknown>): void;
  };
  logError(message: string, err: unknown): void;
  cachedFingerprint: string | null;
  mode: string;
  tsaProvider?: TimestampAuthorityProvider;
  timestampVerifier?: TimestampVerifier;
}

const LIFECYCLE_TOOLS: Record<string, string> = {
  flowguard_hydrate: 'session_created',
  flowguard_abort_session: 'session_aborted',
};

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
  if (toolName !== 'flowguard_decision' || !ctx.success || ctx.transitions.length === 0)
    return prevHash;

  const firstTransition = ctx.transitions[0]!;
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
  return (
    (typeof parsedDecision?.rationale === 'string' ? parsedDecision.rationale : undefined) ??
    state?.reviewDecision?.rationale ??
    (typeof (input as { args?: { rationale?: unknown } })?.args?.rationale === 'string'
      ? String((input as { args?: { rationale?: unknown } })?.args?.rationale)
      : '')
  );
}

async function emitDecisionReceiptActorMissing(
  params: DecisionReceiptParams,
  firstTransition: AuditContext['transitions'][number],
  prevHash: string,
): Promise<string> {
  const { deps, ctx, toolName, sessionId, recordTimestampFailure } = params;
  deps.log.warn('audit', 'skipping decision receipt: missing decidedBy', {
    tool: toolName,
    sessionId,
  });
  const body = buildErrorBody(
    sessionId,
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
    firstTransition: AuditContext['transitions'][number];
    decisionId: string;
    sequence: number;
    verdict: 'approve' | 'changes_requested' | 'reject';
    receipt: { rationale: string; decidedBy?: string; decidedAt: string };
    policyMode: string;
  },
): Promise<string> {
  const { deps, ctx, sessionId, state, recordTimestampFailure } = params;
  const body = buildDecisionBody({
    sessionId,
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
    timestamp: ctx.now,
    actor: ctx.actor,
    prevHash: input.prevHash,
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
  if (!ctx.transitions.some((t) => t.to === 'COMPLETE') || LIFECYCLE_TOOLS[toolName])
    return prevHash;

  const freshState = deps.cachedFingerprint ? await readState(ctx.sessDir) : null;
  const toolLayerHandled = !!freshState?.archiveStatus;

  if (!toolLayerHandled) {
    const body = buildLifecycleBody({
      sessionId,
      detail: { action: 'session_completed', finalPhase: 'COMPLETE' },
      timestamp: ctx.now,
      actor: 'machine',
      prevHash,
      actorInfo: state?.actorInfo,
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
    const evidence = resolution?.evidence;
    const evt = finalizeWithTimestampEvidence(body, prevHash, evidence, digest);
    await deps.appendAndTrack(evt, ctx.sessDir, ctx.enableChainHash, sessionId);
    prevHash = evt.chainHash!;
    deps.log.debug('audit', 'audit chain hash', {
      prevHashPrefix: ctx.prevHash.slice(0, 8),
      nextHashPrefix: prevHash.slice(0, 8),
    });
  } else {
    deps.log.debug('audit', 'session_completed handled by tool layer', {
      archiveStatus: freshState.archiveStatus,
    });
  }

  if (deps.cachedFingerprint) {
    if (toolLayerHandled) {
      deps.log.debug('audit', 'archive handled by tool layer', {
        archiveStatus: freshState.archiveStatus,
      });
    } else {
      archiveSession(deps.cachedFingerprint, sessionId).catch((err) => {
        deps.log.warn('audit', 'auto-archive failed', {
          error: serializeError(err),
        });
      });
    }
  }
  return prevHash;
}

interface StrictTimestampTracker {
  readonly record: (eventKind: string, error: string | undefined) => void;
  readonly failure: () => { eventKind: string; reason: string } | undefined;
}

function createStrictTimestampTracker(policy: TimestampAssurancePolicy): StrictTimestampTracker {
  let failure: { eventKind: string; reason: string } | undefined;
  return {
    record(eventKind, error) {
      if (!failure && policy.strict && error && policy.criticalEvents.includes(eventKind)) {
        failure = { eventKind, reason: error };
      }
    },
    failure: () => failure,
  };
}

async function emitAuditBodyWithEvidence(input: {
  deps: AuditDeps;
  ctx: AuditContext;
  sessionId: string;
  body: EventBody;
  eventKind: string;
  localTimestamp: string;
  timestampTracker: StrictTimestampTracker;
}): Promise<void> {
  const { deps, ctx, sessionId, body, eventKind, localTimestamp, timestampTracker } = input;
  const digest = computeCanonicalEventDigest(body);
  const resolution = ctx.timestampAssurance.enabled
    ? await resolveTimestampEvidence({
        policy: ctx.timestampAssurance,
        canonicalEventDigest: digest,
        eventKind,
        localTimestamp,
        ntpResult: ctx.ntpResult,
        tsaProvider: deps.tsaProvider,
        tsaVerifier: deps.timestampVerifier,
      })
    : undefined;
  timestampTracker.record(eventKind, resolution?.error);
  const evt = finalizeWithTimestampEvidence(body, ctx.prevHash, resolution?.evidence, digest);
  ctx.prevHash = evt.chainHash!;
  await deps.appendAndTrack(evt, ctx.sessDir, ctx.enableChainHash, sessionId);
}

async function emitToolCallAudit(input: {
  deps: AuditDeps;
  ctx: AuditContext;
  toolName: string;
  input: unknown;
  sessionId: string;
  state: SessionState | null;
  timestampTracker: StrictTimestampTracker;
}): Promise<void> {
  const { deps, ctx, toolName, sessionId, state, timestampTracker } = input;
  if (!ctx.emitToolCalls) return;
  const body = buildToolCallBody({
    sessionId,
    phase: ctx.phase,
    detail: {
      tool: toolName,
      argsSummary: summarizeArgs((input.input as Record<string, unknown>) ?? {}),
      success: ctx.success,
      errorMessage: ctx.errorMessage,
      transitionCount: ctx.transitions.length,
    },
    timestamp: ctx.now,
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
  deps.log.debug('audit', 'emitted tool_call event', { tool: toolName, phase: ctx.phase });
}

async function emitTransitionAudits(input: {
  deps: AuditDeps;
  ctx: AuditContext;
  sessionId: string;
  timestampTracker: StrictTimestampTracker;
}): Promise<void> {
  const { deps, ctx, sessionId, timestampTracker } = input;
  if (!ctx.emitTransitions || ctx.transitions.length === 0) return;
  deps.log.debug('audit', 'emitting transition events', { count: ctx.transitions.length });
  for (let i = 0; i < ctx.transitions.length; i++) {
    const t = ctx.transitions[i]!;
    const body = buildTransitionBody(
      sessionId,
      t.to,
      { from: t.from, to: t.to, event: t.event, autoAdvanced: i > 0, chainIndex: i },
      t.at,
      ctx.prevHash,
    );
    await emitAuditBodyWithEvidence({
      deps,
      ctx,
      sessionId,
      body,
      eventKind: 'transition',
      localTimestamp: t.at,
      timestampTracker,
    });
  }
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
  deps.log.info('audit', 'lifecycle event', { action: lifecycleAction, tool: toolName });
  const body = buildLifecycleBody({
    sessionId,
    detail: buildLifecycleDetail(ctx, lifecycleAction, state, policy),
    timestamp: ctx.now,
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
  timestampTracker: StrictTimestampTracker;
}): Promise<void> {
  const { deps, ctx, toolName, sessionId, timestampTracker } = input;
  if (ctx.success || !ctx.errorMessage) return;
  deps.log.warn('audit', 'tool reported error', { tool: toolName, errorMessage: ctx.errorMessage });
  const body = buildErrorBody(
    sessionId,
    {
      code: 'TOOL_ERROR',
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

async function finalizeStrictTimestampFailure(
  ctx: AuditContext,
  getFailure: StrictTimestampTracker['failure'],
): Promise<{ auditOk: boolean; block?: boolean; code?: string; reason?: string } | undefined> {
  const failure = getFailure();
  if (!failure) return undefined;
  const currentState = await readState(ctx.sessDir);
  if (currentState) {
    await writeState(ctx.sessDir, {
      ...currentState,
      error: {
        code: 'TSA_TIMESTAMP_ASSURANCE_FAILED',
        message: `Strict timestamp assurance failed for ${failure.eventKind}: ${failure.reason}`,
        recoveryHint:
          'Fix TSA connectivity, trust anchors, or timestamp token validity; or disable audit.timestampAssurance.strict to recover to Slice 1 behavior.',
        occurredAt: ctx.now,
      },
    });
  }
  return {
    auditOk: false,
    block: true,
    code: 'TSA_TIMESTAMP_ASSURANCE_FAILED',
    reason: failure.reason,
  };
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
    if (!resolved) return;
    policyResolved = resolved.policyResolved;
    effectiveMode = resolved.effectiveMode;
    const { ctx, policy, state } = resolved;
    const timestampTracker = createStrictTimestampTracker(ctx.timestampAssurance);

    // ── 1. Emit tool_call event ──────────────────────────────────────────
    await emitToolCallAudit({ deps, ctx, toolName, input, sessionId, state, timestampTracker });

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

    // ── 5. Detect session completion + auto-archive ──────────────────────
    ctx.prevHash = await maybeCompleteAndArchive(deps, ctx, {
      toolName,
      sessionId,
      state,
      recordTimestampFailure: timestampTracker.record,
    });

    // ── 6. Emit error event ─────────────────────────────────────────────
    await emitToolErrorAudit({ deps, ctx, toolName, sessionId, timestampTracker });

    return await finalizeStrictTimestampFailure(ctx, timestampTracker.failure);
  } catch (err) {
    deps.logError(`Failed to write audit events for ${toolName}`, err);
    if (effectiveMode === 'regulated' || !policyResolved) {
      return {
        auditOk: false,
        block: true,
        code: 'AUDIT_PERSISTENCE_FAILED',
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }
  return undefined;
}
