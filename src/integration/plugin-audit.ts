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

import { readState } from '../adapters/persistence.js';
import { archiveSession } from '../adapters/workspace/index.js';
import type { SessionState, Phase, Event } from '../state/schema.js';
import {
  buildToolCallBody,
  buildTransitionBody,
  buildErrorBody,
  buildLifecycleBody,
  buildDecisionBody,
  finalizeWithTimestampEvidence,
  summarizeArgs,
  GENESIS_HASH,
  type EventBody,
} from '../audit/types.js';
import { computeCanonicalEventDigest } from '../audit/canonical-digest.js';
import { resolveTimestampEvidence } from '../audit/timestamp-resolution.js';
import { checkNtpClock } from '../audit/ntp-check.js';
import type { NtpCheckResult } from '../audit/ntp-check.js';
import type { TimestampAssurancePolicy } from '../config/policy-types.js';
import { parseToolResult } from './plugin-helpers.js';

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
}

const LIFECYCLE_TOOLS: Record<string, string> = {
  flowguard_hydrate: 'session_created',
  flowguard_abort_session: 'session_aborted',
};

// ─── Internal types ───────────────────────────────────────────────────────────

interface AuditContext {
  sessDir: string;
  emitToolCalls: boolean;
  emitTransitions: boolean;
  enableChainHash: boolean;
  actor: string;
  now: string;
  prevHash: string;
  phase: string;
  transitions: Array<{ from: Phase; to: Phase; event: Event; at: string }>;
  success: boolean;
  errorMessage: string | undefined;
  parsed: ReturnType<typeof parseToolResult>;
  timestampAssurance: TimestampAssurancePolicy;
  ntpResult?: NtpCheckResult;
}

// ─── Extracted helpers ────────────────────────────────────────────────────────

async function resolveAuditContext(
  deps: AuditDeps,
  toolName: string,
  output: unknown,
  sessionId: string,
): Promise<{
  ctx: AuditContext;
  policy: {
    audit: { emitToolCalls: boolean; emitTransitions: boolean; enableChainHash: boolean };
    actorClassification: Record<string, string>;
    mode: string;
    requireHumanGates: boolean;
  };
  state: SessionState | null;
  policyResolved: boolean;
  effectiveMode: string;
} | null> {
  await deps.resolveFingerprint();
  const sessDir = deps.getSessionDir(sessionId);
  if (!sessDir) return null;

  const { policy, state } = await deps.resolveSessionPolicy(sessDir);
  const { emitToolCalls, emitTransitions, enableChainHash } = policy.audit;
  const effectiveMode = policy.mode;

  deps.log.debug('audit', 'processing tool call', {
    tool: toolName,
    emitToolCalls,
    emitTransitions,
    enableChainHash,
  });

  const actor = policy.actorClassification[toolName] ?? 'system';
  const now = new Date().toISOString();

  let prevHash: string;
  if (enableChainHash) {
    if (state?.archiveStatus) deps.invalidateChainState(sessionId);
    prevHash = await deps.initChain(sessDir, sessionId);
  } else {
    prevHash = GENESIS_HASH;
  }

  let phase = 'unknown';
  let transitions: AuditContext['transitions'] = [];
  let success = true;
  let errorMessage: string | undefined;

  // FG-267: Read transitions from metadata channel first (new),
  // then fall back to _audit.transitions from the parsed JSON (legacy).
  const metaTransitions =
    typeof output === 'object' && output !== null
      ? ((output as Record<string, unknown>).metadata as Record<string, unknown> | undefined)
          ?.transitions
      : undefined;
  if (Array.isArray(metaTransitions)) {
    transitions = metaTransitions as AuditContext['transitions'];
  }

  const parsed = parseToolResult(
    typeof output === 'object' && output !== null && 'output' in output ? output.output : output,
  );
  if (parsed) {
    phase = typeof parsed.phase === 'string' ? parsed.phase : 'unknown';
    success = parsed.error !== true;
    errorMessage = typeof parsed.errorMessage === 'string' ? parsed.errorMessage : undefined;
    // Metadata-first: only fall back to _audit if metadata didn't provide transitions
    if (transitions.length === 0) {
      const rawTransitions = (parsed._audit as { transitions?: unknown } | undefined)?.transitions;
      if (Array.isArray(rawTransitions)) {
        transitions = rawTransitions as AuditContext['transitions'];
      }
    }
  }

  const resolvedTsa: TimestampAssurancePolicy = policy.audit.timestampAssurance ?? {
    enabled: false,
    mode: 'local_only' as const,
    strict: false,
    criticalEvents: [],
    ntpDriftThresholdMs: 30000,
    tsaTimeoutMs: 10000,
  };

  let ntpResult: NtpCheckResult | undefined;
  if (resolvedTsa.enabled && resolvedTsa.mode !== 'local_only') {
    ntpResult = await checkNtpClock(
      resolvedTsa.ntpServers,
      resolvedTsa.tsaTimeoutMs,
      resolvedTsa.ntpDriftThresholdMs,
    );
  }

  return {
    ctx: {
      sessDir,
      emitToolCalls,
      emitTransitions,
      enableChainHash,
      actor,
      now,
      prevHash,
      phase,
      transitions,
      success,
      errorMessage,
      parsed,
      timestampAssurance: resolvedTsa,
      ntpResult,
    },
    policy,
    state,
    policyResolved: true,
    effectiveMode,
  };
}

interface DecisionReceiptParams {
  deps: AuditDeps;
  ctx: AuditContext;
  toolName: string;
  input: unknown;
  sessionId: string;
  policyMode: string;
  state: SessionState | null;
}

async function emitDecisionReceipt(params: DecisionReceiptParams): Promise<string> {
  const { deps, ctx, toolName, input, sessionId, policyMode, state } = params;
  let prevHash = ctx.prevHash;
  if (toolName !== 'flowguard_decision' || !ctx.success || ctx.transitions.length === 0)
    return prevHash;

  const firstTransition = ctx.transitions[0]!;
  const inferredVerdict =
    firstTransition.event === 'APPROVE'
      ? 'approve'
      : firstTransition.event === 'CHANGES_REQUESTED'
        ? 'changes_requested'
        : firstTransition.event === 'REJECT'
          ? 'reject'
          : null;
  if (inferredVerdict === null) return prevHash;

  const sequence = await deps.nextDecisionSequence(ctx.sessDir, sessionId);
  const decisionId = `DEC-${String(sequence).padStart(3, '0')}`;
  const pd = ctx.parsed;
  const parsedDecision =
    pd?.reviewDecision !== null && typeof pd?.reviewDecision === 'object'
      ? (pd.reviewDecision as Record<string, unknown>)
      : null;
  const stateDecision = state?.reviewDecision;
  const rationale =
    (typeof parsedDecision?.rationale === 'string' ? parsedDecision.rationale : undefined) ??
    stateDecision?.rationale ??
    (typeof (input as { args?: { rationale?: unknown } })?.args?.rationale === 'string'
      ? String((input as { args?: { rationale?: unknown } })?.args?.rationale)
      : '');
  const decidedBy =
    (typeof parsedDecision?.decidedBy === 'string' ? parsedDecision.decidedBy : undefined) ??
    stateDecision?.decidedBy;
  const decidedAt =
    (typeof parsedDecision?.decidedAt === 'string' ? parsedDecision.decidedAt : undefined) ??
    stateDecision?.decidedAt ??
    firstTransition.at;

  if (!decidedBy?.trim()) {
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
    const digest = computeCanonicalEventDigest(body);
    const evidence = ctx.timestampAssurance.enabled
      ? (
          await resolveTimestampEvidence({
            policy: ctx.timestampAssurance,
            canonicalEventDigest: digest,
            eventKind: 'error',
            localTimestamp: ctx.now,
            ntpResult: ctx.ntpResult,
          })
        ).evidence
      : undefined;
    const evt = finalizeWithTimestampEvidence(body, prevHash, evidence, digest);
    await deps.appendAndTrack(evt, ctx.sessDir, ctx.enableChainHash, sessionId);
    if (ctx.enableChainHash) prevHash = evt.chainHash!;
  } else {
    const body = buildDecisionBody({
      sessionId,
      gatePhase: firstTransition.from,
      detail: {
        decisionId,
        decisionSequence: sequence,
        verdict: inferredVerdict,
        rationale,
        decidedBy,
        decidedAt,
        fromPhase: firstTransition.from,
        toPhase: firstTransition.to,
        transitionEvent: firstTransition.event,
        policyMode,
      },
      timestamp: ctx.now,
      actor: ctx.actor,
      prevHash,
      actorInfo: state?.actorInfo,
    });
    const digest = computeCanonicalEventDigest(body);
    const evidence = ctx.timestampAssurance.enabled
      ? (
          await resolveTimestampEvidence({
            policy: ctx.timestampAssurance,
            canonicalEventDigest: digest,
            eventKind: 'decision',
            localTimestamp: ctx.now,
            ntpResult: ctx.ntpResult,
          })
        ).evidence
      : undefined;
    const evt = finalizeWithTimestampEvidence(body, prevHash, evidence, digest);
    await deps.appendAndTrack(evt, ctx.sessDir, ctx.enableChainHash, sessionId);
    if (ctx.enableChainHash) prevHash = evt.chainHash!;
  }
  return prevHash;
}

async function maybeCompleteAndArchive(
  deps: AuditDeps,
  ctx: AuditContext,
  toolName: string,
  sessionId: string,
  state: SessionState | null,
): Promise<string> {
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
    const evidence = ctx.timestampAssurance.enabled
      ? (
          await resolveTimestampEvidence({
            policy: ctx.timestampAssurance,
            canonicalEventDigest: digest,
            eventKind: 'lifecycle',
            localTimestamp: ctx.now,
            ntpResult: ctx.ntpResult,
          })
        ).evidence
      : undefined;
    const evt = finalizeWithTimestampEvidence(body, prevHash, evidence, digest);
    await deps.appendAndTrack(evt, ctx.sessDir, ctx.enableChainHash, sessionId);
    if (ctx.enableChainHash) prevHash = evt.chainHash!;
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
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }
  return prevHash;
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

    const taPolicy = ctx.timestampAssurance;
    const ntpResult = ctx.ntpResult;

    async function emitWithEvidence(
      body: EventBody,
      prevHash: string,
      eventKind: string,
      localTimestamp: string,
    ): Promise<{ event: ReturnType<typeof finalizeWithTimestampEvidence>; prevHash: string }> {
      const digest = computeCanonicalEventDigest(body);
      const evidence = taPolicy.enabled
        ? (
            await resolveTimestampEvidence({
              policy: taPolicy,
              canonicalEventDigest: digest,
              eventKind,
              localTimestamp,
              ntpResult,
            })
          ).evidence
        : undefined;
      const evt = finalizeWithTimestampEvidence(body, prevHash, evidence, digest);
      return { event: evt, prevHash: evt.chainHash };
    }

    // ── 1. Emit tool_call event ──────────────────────────────────────────
    if (ctx.emitToolCalls) {
      const argsSummary = summarizeArgs((input as Record<string, unknown>) ?? {});
      const body = buildToolCallBody({
        sessionId,
        phase: ctx.phase,
        detail: {
          tool: toolName,
          argsSummary,
          success: ctx.success,
          errorMessage: ctx.errorMessage,
          transitionCount: ctx.transitions.length,
        },
        timestamp: ctx.now,
        actor: ctx.actor,
        prevHash: ctx.prevHash,
        actorInfo: state?.actorInfo,
      });
      const { event: evt, prevHash: nextHash } = await emitWithEvidence(
        body,
        ctx.prevHash,
        'tool_call',
        ctx.now,
      );
      await deps.appendAndTrack(evt, ctx.sessDir, ctx.enableChainHash, sessionId);
      if (ctx.enableChainHash) ctx.prevHash = nextHash;
      deps.log.debug('audit', 'emitted tool_call event', { tool: toolName, phase: ctx.phase });
    }

    // ── 2. Emit transition events ───────────────────────────────────────
    if (ctx.emitTransitions && ctx.transitions.length > 0) {
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
        const { event: evt, prevHash: nextHash } = await emitWithEvidence(
          body,
          ctx.prevHash,
          'transition',
          t.at,
        );
        await deps.appendAndTrack(evt, ctx.sessDir, ctx.enableChainHash, sessionId);
        if (ctx.enableChainHash) ctx.prevHash = nextHash;
      }
    }

    // ── 3. Emit decision receipt ────────────────────────────────────────
    ctx.prevHash = await emitDecisionReceipt({
      deps,
      ctx,
      toolName,
      input,
      sessionId,
      policyMode: state?.policySnapshot.mode ?? effectiveMode,
      state,
    });

    // ── 4. Emit lifecycle events ────────────────────────────────────────
    const lifecycleAction = LIFECYCLE_TOOLS[toolName];
    if (lifecycleAction) {
      deps.log.info('audit', 'lifecycle event', { action: lifecycleAction, tool: toolName });
      const finalPhase =
        ctx.transitions.length > 0
          ? ctx.transitions[ctx.transitions.length - 1]!.to
          : (ctx.phase as Phase);

      const lifecycleReason =
        lifecycleAction === 'session_created'
          ? `${
              typeof ctx.parsed?.policyResolution === 'object'
                ? `requested_mode:${String((ctx.parsed.policyResolution as Record<string, unknown>).requestedMode ?? 'unknown')};effective_mode:${String((ctx.parsed.policyResolution as Record<string, unknown>).effectiveMode ?? state?.policySnapshot.mode ?? policy.mode)};source:${String((ctx.parsed.policyResolution as Record<string, unknown>).source ?? state?.policySnapshot.source ?? 'unknown')};effective_gate_behavior:${String((ctx.parsed.policyResolution as Record<string, unknown>).effectiveGateBehavior ?? state?.policySnapshot.effectiveGateBehavior ?? (policy.requireHumanGates ? 'human_gated' : 'auto_approve'))};reason:${String((ctx.parsed.policyResolution as Record<string, unknown>).reason ?? state?.policySnapshot.degradedReason ?? 'none')};resolution_reason:${String((ctx.parsed.policyResolution as Record<string, unknown>).resolutionReason ?? state?.policySnapshot.resolutionReason ?? 'none')};central_minimum_mode:${String((ctx.parsed.policyResolution as Record<string, unknown>).centralMinimumMode ?? state?.policySnapshot.centralMinimumMode ?? 'none')};central_policy_digest:${String((ctx.parsed.policyResolution as Record<string, unknown>).centralPolicyDigest ?? state?.policySnapshot.policyDigest ?? 'none')}`
                : `requested_mode:${state?.policySnapshot.requestedMode ?? policy.mode};effective_mode:${state?.policySnapshot.mode ?? policy.mode};source:${state?.policySnapshot.source ?? 'unknown'};effective_gate_behavior:${state?.policySnapshot.effectiveGateBehavior ?? (policy.requireHumanGates ? 'human_gated' : 'auto_approve')};reason:${state?.policySnapshot.degradedReason ?? 'none'};resolution_reason:${state?.policySnapshot.resolutionReason ?? 'none'};central_minimum_mode:${state?.policySnapshot.centralMinimumMode ?? 'none'};central_policy_digest:${state?.policySnapshot.policyDigest ?? 'none'}`
            }`
          : undefined;

      const body = buildLifecycleBody({
        sessionId,
        detail: {
          action: lifecycleAction as 'session_created' | 'session_completed' | 'session_aborted',
          finalPhase,
          ...(lifecycleReason ? { reason: lifecycleReason } : {}),
        },
        timestamp: ctx.now,
        actor: ctx.actor,
        prevHash: ctx.prevHash,
        actorInfo: state?.actorInfo,
      });
      const { event: evt, prevHash: nextHash } = await emitWithEvidence(
        body,
        ctx.prevHash,
        'lifecycle',
        ctx.now,
      );
      await deps.appendAndTrack(evt, ctx.sessDir, ctx.enableChainHash, sessionId);
      if (ctx.enableChainHash) ctx.prevHash = nextHash;
    }

    // ── 5. Detect session completion + auto-archive ──────────────────────
    ctx.prevHash = await maybeCompleteAndArchive(deps, ctx, toolName, sessionId, state);

    // ── 6. Emit error event ─────────────────────────────────────────────
    if (!ctx.success && ctx.errorMessage) {
      deps.log.warn('audit', 'tool reported error', {
        tool: toolName,
        errorMessage: ctx.errorMessage,
      });
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
      const { event: evt, prevHash: nextHash } = await emitWithEvidence(
        body,
        ctx.prevHash,
        'error',
        ctx.now,
      );
      await deps.appendAndTrack(evt, ctx.sessDir, ctx.enableChainHash, sessionId);
      if (ctx.enableChainHash) ctx.prevHash = nextHash;
    }
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
