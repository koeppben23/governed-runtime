/**
 * @module integration/plugin-audit
 * @description Audit event emission handler — extracted from plugin.ts.
 *
 * Emits structured audit events for FlowGuard tool invocations:
 * - tool_call events (policy-conditional)
 * - transition events (policy-conditional)
 * - decision receipt events
 * - lifecycle events (always emitted)
 * - session completion detection + auto-archive
 * - error events (always emitted)
 *
 * Wrapped in try/catch — audit failures never block the workflow.
 *
 * @version v1
 */

import { readState } from '../adapters/persistence.js';
import { archiveSession } from '../adapters/workspace/index.js';
import type { SessionState, Phase, Event } from '../state/schema.js';
import {
  createToolCallEvent,
  createTransitionEvent,
  createLifecycleEvent,
  createErrorEvent,
  createDecisionEvent,
  summarizeArgs,
  GENESIS_HASH,
} from '../audit/types.js';
import { parseToolResult } from './plugin-helpers.js';

/** Closure dependencies injected from plugin.ts. */
export interface AuditDeps {
  resolveFingerprint(): Promise<string | null>;
  getSessionDir(sessionId: string): string | null;
  resolveSessionPolicy(sessDir: string): Promise<{
    policy: {
      audit: { emitToolCalls: boolean; emitTransitions: boolean; enableChainHash: boolean };
      actorClassification: Record<string, string>;
      mode: string;
      requireHumanGates: boolean;
    };
    state: SessionState | null;
  }>;
  initChain(sessDir: string | null, sessionId: string): Promise<string>;
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
  /** Policy mode — 'regulated' audit failures are blocking. */
  mode: string;
}

const LIFECYCLE_TOOLS: Record<string, string> = {
  flowguard_hydrate: 'session_created',
  flowguard_abort_session: 'session_aborted',
};

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
  try {
    await deps.resolveFingerprint();
    const sessDir = deps.getSessionDir(sessionId);
    if (!sessDir) return;

    const { policy, state } = await deps.resolveSessionPolicy(sessDir);
    const { emitToolCalls, emitTransitions, enableChainHash } = policy.audit;

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
      prevHash = await deps.initChain(sessDir, sessionId);
    } else {
      prevHash = GENESIS_HASH;
    }

    let phase = 'unknown';
    let transitions: Array<{
      from: Phase;
      to: Phase;
      event: Event;
      at: string;
    }> = [];
    let success = true;
    let errorMessage: string | undefined;
    const parsed = parseToolResult(
      typeof output === 'object' && output !== null && 'output' in output
        ? (output as { output: unknown }).output
        : output,
    );
    if (parsed) {
      phase = typeof parsed.phase === 'string' ? parsed.phase : 'unknown';
      success = parsed.error !== true;
      errorMessage = typeof parsed.errorMessage === 'string' ? parsed.errorMessage : undefined;

      const rawTransitions = (parsed._audit as { transitions?: unknown } | undefined)?.transitions;
      if (Array.isArray(rawTransitions)) {
        transitions = rawTransitions as Array<{
          from: Phase;
          to: Phase;
          event: Event;
          at: string;
        }>;
      }
    }

    // ── 1. Emit tool_call event ──────────────────────────────────────────
    if (emitToolCalls) {
      const argsSummary = summarizeArgs((input as Record<string, unknown>) ?? {});
      const toolCallEvt = createToolCallEvent({
        sessionId,
        phase,
        detail: {
          tool: toolName,
          argsSummary,
          success,
          errorMessage,
          transitionCount: transitions.length,
        },
        timestamp: now,
        actor,
        prevHash,
        actorInfo: state?.actorInfo,
      });
      await deps.appendAndTrack(toolCallEvt, sessDir, enableChainHash, sessionId);
      if (enableChainHash) prevHash = toolCallEvt.chainHash!;
      deps.log.debug('audit', 'emitted tool_call event', { tool: toolName, phase });
    }

    // ── 2. Emit transition events ───────────────────────────────────────
    if (emitTransitions && transitions.length > 0) {
      deps.log.debug('audit', 'emitting transition events', { count: transitions.length });
      for (let i = 0; i < transitions.length; i++) {
        const t = transitions[i]!;
        const transEvt = createTransitionEvent(
          sessionId,
          t.to,
          {
            from: t.from,
            to: t.to,
            event: t.event,
            autoAdvanced: i > 0,
            chainIndex: i,
          },
          t.at,
          prevHash,
        );
        await deps.appendAndTrack(transEvt, sessDir, enableChainHash, sessionId);
        if (enableChainHash) prevHash = transEvt.chainHash!;
      }
    }

    // ── 3. Emit decision receipt ────────────────────────────────────────
    const TOOL_DECISION = 'flowguard_decision';
    if (toolName === TOOL_DECISION && success && transitions.length > 0) {
      const firstTransition = transitions[0]!;
      const inferredVerdict =
        firstTransition.event === 'APPROVE'
          ? 'approve'
          : firstTransition.event === 'CHANGES_REQUESTED'
            ? 'changes_requested'
            : firstTransition.event === 'REJECT'
              ? 'reject'
              : null;

      if (inferredVerdict !== null) {
        const sequence = await deps.nextDecisionSequence(sessDir, sessionId);
        const decisionId = `DEC-${String(sequence).padStart(3, '0')}`;
        const parsedDecision =
          typeof parsed?.reviewDecision === 'object' && parsed.reviewDecision !== null
            ? (parsed.reviewDecision as Record<string, unknown>)
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
          stateDecision?.decidedBy ??
          undefined;
        const decidedAt =
          (typeof parsedDecision?.decidedAt === 'string' ? parsedDecision.decidedAt : undefined) ??
          stateDecision?.decidedAt ??
          firstTransition.at;

        if (!decidedBy || !decidedBy.trim()) {
          deps.log.warn('audit', 'skipping decision receipt: missing decidedBy', {
            tool: toolName,
            sessionId,
          });
          const missingActorEvt = createErrorEvent(
            sessionId,
            {
              code: 'DECISION_RECEIPT_ACTOR_MISSING',
              message: 'Decision receipt skipped because decidedBy is missing',
              recoveryHint: 'Ensure /review-decision output includes reviewDecision.decidedBy',
              errorPhase: firstTransition.from,
            },
            now,
            prevHash,
          );
          await deps.appendAndTrack(missingActorEvt, sessDir, enableChainHash, sessionId);
          if (enableChainHash) prevHash = missingActorEvt.chainHash!;
        } else {
          const decisionEvt = createDecisionEvent({
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
              policyMode: state?.policySnapshot.mode ?? policy.mode,
            },
            timestamp: now,
            actor,
            prevHash,
            actorInfo: state?.actorInfo,
          });
          await deps.appendAndTrack(decisionEvt, sessDir, enableChainHash, sessionId);
          if (enableChainHash) prevHash = decisionEvt.chainHash!;
        }
      }
    }

    // ── 4. Emit lifecycle events ────────────────────────────────────────
    const lifecycleAction = LIFECYCLE_TOOLS[toolName];
    if (lifecycleAction) {
      deps.log.info('audit', 'lifecycle event', { action: lifecycleAction, tool: toolName });
      const finalPhase =
        transitions.length > 0 ? transitions[transitions.length - 1]!.to : (phase as Phase);

      const lifecycleReason =
        lifecycleAction === 'session_created'
          ? `${
              typeof parsed?.policyResolution === 'object'
                ? `requested_mode:${String((parsed.policyResolution as Record<string, unknown>).requestedMode ?? 'unknown')};effective_mode:${String((parsed.policyResolution as Record<string, unknown>).effectiveMode ?? state?.policySnapshot.mode ?? policy.mode)};source:${String((parsed.policyResolution as Record<string, unknown>).source ?? state?.policySnapshot.source ?? 'unknown')};effective_gate_behavior:${String((parsed.policyResolution as Record<string, unknown>).effectiveGateBehavior ?? state?.policySnapshot.effectiveGateBehavior ?? (policy.requireHumanGates ? 'human_gated' : 'auto_approve'))};reason:${String((parsed.policyResolution as Record<string, unknown>).reason ?? state?.policySnapshot.degradedReason ?? 'none')};resolution_reason:${String((parsed.policyResolution as Record<string, unknown>).resolutionReason ?? state?.policySnapshot.resolutionReason ?? 'none')};central_minimum_mode:${String((parsed.policyResolution as Record<string, unknown>).centralMinimumMode ?? state?.policySnapshot.centralMinimumMode ?? 'none')};central_policy_digest:${String((parsed.policyResolution as Record<string, unknown>).centralPolicyDigest ?? state?.policySnapshot.policyDigest ?? 'none')}`
                : `requested_mode:${state?.policySnapshot.requestedMode ?? policy.mode};effective_mode:${state?.policySnapshot.mode ?? policy.mode};source:${state?.policySnapshot.source ?? 'unknown'};effective_gate_behavior:${state?.policySnapshot.effectiveGateBehavior ?? (policy.requireHumanGates ? 'human_gated' : 'auto_approve')};reason:${state?.policySnapshot.degradedReason ?? 'none'};resolution_reason:${state?.policySnapshot.resolutionReason ?? 'none'};central_minimum_mode:${state?.policySnapshot.centralMinimumMode ?? 'none'};central_policy_digest:${state?.policySnapshot.policyDigest ?? 'none'}`
            }`
          : undefined;

      const lifecycleEvt = createLifecycleEvent(
        sessionId,
        {
          action: lifecycleAction as 'session_created' | 'session_completed' | 'session_aborted',
          finalPhase,
          ...(lifecycleReason ? { reason: lifecycleReason } : {}),
        },
        now,
        actor,
        prevHash,
        state?.actorInfo,
      );
      await deps.appendAndTrack(lifecycleEvt, sessDir, enableChainHash, sessionId);
      if (enableChainHash) prevHash = lifecycleEvt.chainHash!;
    }

    // ── 5. Detect session completion + auto-archive ──────────────────────
    const completionTransition = transitions.find((t) => t.to === 'COMPLETE');
    if (completionTransition && !LIFECYCLE_TOOLS[toolName]) {
      const freshState = deps.cachedFingerprint ? await readState(sessDir) : null;
      const toolLayerHandled = !!freshState?.archiveStatus;

      if (!toolLayerHandled) {
        const completionEvt = createLifecycleEvent(
          sessionId,
          {
            action: 'session_completed',
            finalPhase: 'COMPLETE' as Phase,
          },
          now,
          'machine',
          prevHash,
          state?.actorInfo,
        );
        await deps.appendAndTrack(completionEvt, sessDir, enableChainHash, sessionId);
        if (enableChainHash) prevHash = completionEvt.chainHash!;
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
    }

    // ── 6. Emit error event ─────────────────────────────────────────────
    if (!success && errorMessage) {
      deps.log.warn('audit', 'tool reported error', { tool: toolName, errorMessage });
      const errorEvt = createErrorEvent(
        sessionId,
        {
          code: 'TOOL_ERROR',
          message: errorMessage,
          recoveryHint: 'Check tool output for details',
          errorPhase: phase as Phase,
        },
        now,
        prevHash,
      );
      await deps.appendAndTrack(errorEvt, sessDir, enableChainHash, sessionId);
    }
  } catch (err) {
    deps.logError(`Failed to write audit events for ${toolName}`, err);
    // P35: In regulated mode, audit persistence failures are blocking.
    if (deps.mode === 'regulated') {
      return {
        auditOk: false,
        block: true,
        code: 'AUDIT_PERSISTENCE_FAILED',
        reason: err instanceof Error ? err.message : String(err),
      };
    }
    // solo/team: warn only, non-blocking
  }
  return undefined;
}
