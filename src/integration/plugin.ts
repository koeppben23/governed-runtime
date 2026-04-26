/**
 * @module integration/plugin
 * @description OpenCode Plugin that creates structured, hash-chained audit events
 * for all FlowGuard tool calls and state transitions.
 *
 * Policy-aware emission:
 * - Actor classification via policy.actorClassification (not hardcoded)
 * - Conditional tool_call emission via policy.audit.emitToolCalls
 * - Conditional transition emission via policy.audit.emitTransitions
 * - Conditional hash chaining via policy.audit.enableChainHash
 * - Lifecycle and error events are always emitted (structural, not operational)
 *
 * Workspace-aware:
 * - Resolves workspace fingerprint from worktree at plugin init
 * - Reads config from workspace directory (workspace registry)
 * - All audit files live under session directory in workspace registry
 *
 * Logging:
 * - Plugin is the ONLY OpenCode logger writer (via client.app.log)
 * - Logger is created at plugin init from config + client sink
 * - Tools and rails do NOT log — plugin logs around them
 *
 * On each FlowGuard tool execution:
 * 1. Reads session state to resolve the governing policy
 * 2. Parses the tool result JSON to extract phase, transitions, and status
 * 3. Creates a tool_call audit event if policy.audit.emitToolCalls
 * 4. Creates transition audit events for each state transition if policy.audit.emitTransitions
 * 5. Creates lifecycle events for session creation, completion, and abortion (always)
 * 6. Hash-chains events for tamper detection if policy.audit.enableChainHash
 * 7. Appends all emitted events to {sessionDir}/audit.jsonl
 *
 * Design:
 * - Fire-and-forget: audit failures are logged but never block the workflow.
 *   FlowGuard correctness does not depend on audit success.
 * - The plugin closure captures `worktree` and caches `lastHash` for chaining.
 * - Only FlowGuard tools (name starting with "flowguard_") are audited.
 * - Hash chain is initialized by reading the last event from the trail on first call.
 * - Policy is resolved from session state (read from persistence after tool executes).
 *   Falls back to config.policy.defaultMode > solo if state is unavailable (P32).
 *
 * Auto-archive:
 * - On session completion (COMPLETE phase transition), automatically archives the session
 *   as a tar.gz file. Fire-and-forget — archive failure never blocks.
 *
 * Installation:
 * This module lives inside @flowguard/core. The thin wrapper in
 * ~/.config/opencode/plugins/flowguard-audit.ts (or .opencode/plugins/)
 * re-exports FlowGuardAuditPlugin for OpenCode to discover.
 *
 * Plugin API (verified against OpenCode docs Apr 14, 2026):
 * - Plugin is an async function receiving { project, client, $, directory, worktree }
 * - Returns an object with event hook implementations
 * - Type: Plugin from "@opencode-ai/plugin"
 *
 * Deterministic review orchestration (v7):
 * When a FlowGuard tool response signals INDEPENDENT_REVIEW_REQUIRED and
 * policy.selfReview.subagentEnabled is true, the plugin programmatically
 * invokes the flowguard-reviewer subagent via the SDK client:
 * 1. Detects INDEPENDENT_REVIEW_REQUIRED in tool.execute.after
 * 2. Reads session state for ticket/plan context
 * 3. Creates a child session via client.session.create()
 * 4. Sends structured prompt to flowguard-reviewer via client.session.prompt()
 * 5. Parses ReviewFindings from the response
 * 6. Mutates output.output to inject findings (INDEPENDENT_REVIEW_COMPLETED)
 * 7. Updates enforcement state to satisfy L1/L2/L4 checks
 *
 * On failure: graceful degradation — original output preserved, LLM follows
 * the probabilistic path via Task tool. Unparseable reviewer responses are
 * treated as failure (fail-closed) — only structured ReviewFindings trigger
 * the COMPLETED path.
 *
 * @version v7
 */

import type { Plugin } from '@opencode-ai/plugin';
import {
  readState,
  writeState,
  appendAuditEvent,
  readAuditTrail,
} from '../adapters/persistence.js';
import {
  computeFingerprint,
  sessionDir as resolveSessionDir,
  workspaceDir as resolveWorkspaceDir,
  archiveSession,
} from '../adapters/workspace/index.js';
import {
  createToolCallEvent,
  createTransitionEvent,
  createLifecycleEvent,
  createErrorEvent,
  createDecisionEvent,
  summarizeArgs,
  GENESIS_HASH,
  type ChainedAuditEvent,
} from '../audit/types.js';
import { decisionReceipts } from '../audit/query.js';
import { getLastChainHash } from '../audit/integrity.js';
import { resolvePluginSessionPolicy } from './plugin-policy.js';
import { createPluginLogger } from './plugin-logging.js';
import {
  parseToolResult,
  strictBlockedOutput,
  getToolArgs,
} from './plugin-helpers.js';
import { trackFlowGuardEnforcement, trackTaskEnforcement } from './plugin-enforcement-tracking.js';
import { appendReviewAuditEvent } from './plugin-review-audit.js';
import { blockObligation } from './plugin-review-state.js';
import {
  runReviewOrchestration as runOrchestrator,
  type OrchestratorDeps,
} from './plugin-orchestrator.js';
import type { FlowGuardPolicy } from '../config/policy.js';
import type { Phase, Event } from '../state/schema.js';
import type { SessionState } from '../state/schema.js';

// Review enforcement — runtime gate for subagent invocation
import {
  createSessionState as createEnforcementState,
  enforceBeforeVerdict,
  enforceBeforeSubagentCall,
  REVIEWER_SUBAGENT_TYPE,
  type SessionEnforcementState,
} from './review-enforcement.js';

// Review orchestrator — deterministic subagent invocation via SDK
import {
} from './review-orchestrator.js';
import {
} from './review-assurance.js';
import {
  TOOL_FLOWGUARD_PLAN,
  TOOL_FLOWGUARD_IMPLEMENT,
  TOOL_FLOWGUARD_DECISION,
  TOOL_FLOWGUARD_HYDRATE,
  TOOL_FLOWGUARD_ABORT,
} from './tool-names.js';

/** FlowGuard tool name prefix. Only tools with this prefix are audited. */
const FG_PREFIX = 'flowguard_';

/**
 * Map tool names to lifecycle actions.
 * Tools that produce lifecycle events beyond the regular tool_call event.
 */
const LIFECYCLE_TOOLS: Record<string, string> = {
  [TOOL_FLOWGUARD_HYDRATE]: 'session_created',
  [TOOL_FLOWGUARD_ABORT]: 'session_aborted',
};

/**
 * FlowGuard Audit Plugin.
 *
 * Captures worktree from plugin context at initialization time.
 * Maintains a hash chain cache for efficient chaining without re-reading the trail.
 * Hooks tool.execute.after to append structured audit events for FlowGuard tools.
 * Hooks tool.execute.before to enforce subagent invocation for independent review.
 *
 * Policy-aware: reads session state to resolve audit emission controls and
 * actor classification per tool invocation.
 */
export const FlowGuardAuditPlugin: Plugin = async ({ client, directory, worktree }) => {
  // Capture worktree from plugin context (project-level, stable)
  const auditWorktree = worktree || directory;

  // ── Workspace resolution ────────────────────────────────────────────────
  // Resolve fingerprint + workspace directory at plugin init (once, stable).
  // Session directory varies per tool call (uses sessionID from tool context).
  let cachedFingerprint: string | null = null;
  let cachedWsDir: string | null = null;

  async function resolveFingerprint(): Promise<string | null> {
    if (cachedFingerprint) return cachedFingerprint;
    if (!auditWorktree) return null;
    try {
      const result = await computeFingerprint(auditWorktree);
      cachedFingerprint = result.fingerprint;
      cachedWsDir = resolveWorkspaceDir(result.fingerprint);
      return cachedFingerprint;
    } catch {
      return null;
    }
  }

  function getSessionDir(sessionId: string): string | null {
    if (!cachedFingerprint) return null;
    try {
      return resolveSessionDir(cachedFingerprint, sessionId);
    } catch {
      return null;
    }
  }

  // ── Config + Logger initialization ──────────────────────────────────────
  // Resolved via plugin-logging.ts from workspace config. Falls back to defaults.
  // resolveFingerprint may fail — do not block plugin startup.
  try {
    await resolveFingerprint();
  } catch {
    // logging init fallback only; do not block plugin startup
  }
  const { log, config } = await createPluginLogger(
    client,
    cachedWsDir,
    auditWorktree,
    cachedFingerprint,
  );

  // Hash chain state — cached in closure, initialized on first audit call.
  // Only updated when policy.audit.enableChainHash is true.
  let lastHash: string | null = null;
  let chainInitialized = false;
  const sessionQueues = new Map<string, Promise<void>>();
  const decisionSequenceCache = new Map<string, number>();

  // ── Review enforcement state (per session) ──────────────────────────────
  // Tracks INDEPENDENT_REVIEW_REQUIRED signals and Task calls to
  // flowguard-reviewer. Used by tool.execute.before to block verdicts
  // when no subagent call was made.
  const enforcementStates = new Map<string, SessionEnforcementState>();

  function getEnforcementState(sessionId: string): SessionEnforcementState {
    let state = enforcementStates.get(sessionId);
    if (!state) {
      state = createEnforcementState();
      enforcementStates.set(sessionId, state);
    }
    return state;
  }

  // ── Orchestrator dependencies (injected into plugin-orchestrator module) ──
  const orchestratorDeps: OrchestratorDeps = {
    resolveFingerprint,
    getSessionDir,
    updateReviewAssurance,
    blockReviewOutcome,
    getEnforcementState,
    log,
    client,
  };

  /**
   * Initialize the chain hash by reading the existing trail.
   * Called once on first audit event, then cached.
   */
  async function initChain(sessDir: string | null): Promise<string> {
    if (chainInitialized && lastHash !== null) return lastHash;

    try {
      if (!sessDir) {
        lastHash = GENESIS_HASH;
        chainInitialized = true;
        return lastHash;
      }

      const { events } = await readAuditTrail(sessDir);
      // readAuditTrail returns AuditEvent objects — cast to raw records for getLastChainHash
      lastHash = getLastChainHash(events as unknown as Array<Record<string, unknown>>);
      chainInitialized = true;
      return lastHash;
    } catch {
      // Trail might not exist yet — start fresh
      lastHash = GENESIS_HASH;
      chainInitialized = true;
      return lastHash;
    }
  }

  /**
   * Append an event and optionally update the cached chain hash.
   *
   * @param event - The chained audit event to persist.
   * @param sessDir - Absolute path to the session directory.
   * @param trackChain - If true, update the cached lastHash for chain continuity.
   *   Pass false when policy.audit.enableChainHash is disabled — events still
   *   get persisted but the chain is not maintained (each event uses GENESIS_HASH).
   */
  async function appendAndTrack(
    event: ChainedAuditEvent,
    sessDir: string,
    trackChain: boolean,
  ): Promise<void> {
    await appendAuditEvent(sessDir, event);
    if (trackChain) {
      lastHash = event.chainHash;
    }
  }

  /**
   * Log an audit error without blocking the workflow.
   */
  function logError(message: string, err: unknown): void {
    log.error('audit', message, {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  async function updateReviewAssurance(
    sessDir: string,
    update: (state: SessionState, now: string) => SessionState,
  ): Promise<void> {
    const current = await readState(sessDir);
    if (!current) return;
    const now = new Date().toISOString();
    const next = update(current, now);
    await writeState(sessDir, next);
  }

  /**
   * Block a review outcome — atomic 3-step pattern repeated at 4 call sites.
   *
   * 1. Update review assurance with failed obligation status
   * 2. Emit review:obligation_blocked audit event
   * 3. Set output to strict blocked JSON
   *
   * @param output - Mutable plugin output object (output.output is mutated)
   */
  async function blockReviewOutcome(
    sessDir: string,
    sessionId: string,
    phase: string,
    obligationId: string,
    code: string,
    detail: Record<string, string>,
    output: { output: string },
  ): Promise<void> {
    await updateReviewAssurance(sessDir, (s) => blockObligation(s, obligationId, code));
    await appendReviewAuditEvent(sessDir, sessionId, phase, 'review:obligation_blocked', {
      obligationId,
      code,
    });
    output.output = strictBlockedOutput(code, detail);
  }

  /**
  /**
   * Deterministic review orchestration — delegates to plugin-orchestrator module.
   */
  async function runReviewOrchestration(
    toolName: string,
    input: unknown,
    output: { output: string },
    sessionId: string,
    now: string,
  ): Promise<void> {
    return runOrchestrator(orchestratorDeps, toolName, input, output, sessionId, now);
  }
  async function runAudit(
    toolName: string,
    input: unknown,
    output: unknown,
    sessionId: string,
  ): Promise<void> {
    try {
      await resolveFingerprint();
      const sessDir = getSessionDir(sessionId);
      if (!sessDir) return;

      const { policy, state } = await resolveSessionPolicy(sessDir);
      const { emitToolCalls, emitTransitions, enableChainHash } = policy.audit;

      log.debug('audit', 'processing tool call', {
        tool: toolName,
        emitToolCalls,
        emitTransitions,
        enableChainHash,
      });

      const actor = policy.actorClassification[toolName] ?? 'system';
      const now = new Date().toISOString();

      let prevHash: string;
      if (enableChainHash) {
        if (state?.archiveStatus) {
          chainInitialized = false;
          lastHash = null;
        }
        prevHash = await initChain(sessDir);
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

        const rawTransitions = (parsed._audit as { transitions?: unknown } | undefined)
          ?.transitions;
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
        await appendAndTrack(toolCallEvt, sessDir, enableChainHash);
        if (enableChainHash) prevHash = toolCallEvt.chainHash;
        log.debug('audit', 'emitted tool_call event', { tool: toolName, phase });
      }

      // ── 2. Emit transition events ───────────────────────────────────────
      if (emitTransitions && transitions.length > 0) {
        log.debug('audit', 'emitting transition events', { count: transitions.length });
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
          await appendAndTrack(transEvt, sessDir, enableChainHash);
          if (enableChainHash) prevHash = transEvt.chainHash;
        }
      }

      // ── 3. Emit decision receipt ────────────────────────────────────────
      if (toolName === TOOL_FLOWGUARD_DECISION && success && transitions.length > 0) {
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
          const sequence = await nextDecisionSequence(sessDir, sessionId);
          const decisionId = `DEC-${String(sequence).padStart(3, '0')}`;
          const parsedDecision =
            typeof parsed?.reviewDecision === 'object' && parsed.reviewDecision !== null
              ? (parsed.reviewDecision as Record<string, unknown>)
              : null;
          const stateDecision = state?.reviewDecision;
          const rationale =
            (typeof parsedDecision?.rationale === 'string'
              ? parsedDecision.rationale
              : undefined) ??
            stateDecision?.rationale ??
            (typeof (input as { args?: { rationale?: unknown } })?.args?.rationale === 'string'
              ? String((input as { args?: { rationale?: unknown } })?.args?.rationale)
              : '');
          const decidedBy =
            (typeof parsedDecision?.decidedBy === 'string'
              ? parsedDecision.decidedBy
              : undefined) ??
            stateDecision?.decidedBy ??
            undefined;
          const decidedAt =
            (typeof parsedDecision?.decidedAt === 'string'
              ? parsedDecision.decidedAt
              : undefined) ??
            stateDecision?.decidedAt ??
            firstTransition.at;

          if (!decidedBy || !decidedBy.trim()) {
            log.warn('audit', 'skipping decision receipt: missing decidedBy', {
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
            await appendAndTrack(missingActorEvt, sessDir, enableChainHash);
            if (enableChainHash) prevHash = missingActorEvt.chainHash;
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
            await appendAndTrack(decisionEvt, sessDir, enableChainHash);
            if (enableChainHash) prevHash = decisionEvt.chainHash;
          }
        }
      }

      // ── 4. Emit lifecycle events ────────────────────────────────────────
      const lifecycleAction = LIFECYCLE_TOOLS[toolName];
      if (lifecycleAction) {
        log.info('audit', 'lifecycle event', { action: lifecycleAction, tool: toolName });
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
        await appendAndTrack(lifecycleEvt, sessDir, enableChainHash);
        if (enableChainHash) prevHash = lifecycleEvt.chainHash;
      }

      // ── 5. Detect session completion + auto-archive ──────────────────────
      const completionTransition = transitions.find((t) => t.to === 'COMPLETE');
      if (completionTransition && !LIFECYCLE_TOOLS[toolName]) {
        const freshState = cachedFingerprint ? await readState(sessDir) : null;
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
          await appendAndTrack(completionEvt, sessDir, enableChainHash);
          if (enableChainHash) prevHash = completionEvt.chainHash;
        } else {
          log.debug('audit', 'session_completed handled by tool layer', {
            archiveStatus: freshState.archiveStatus,
          });
        }

        if (cachedFingerprint) {
          if (toolLayerHandled) {
            log.debug('audit', 'archive handled by tool layer', {
              archiveStatus: freshState.archiveStatus,
            });
          } else {
            archiveSession(cachedFingerprint, sessionId).catch((err) => {
              log.warn('audit', 'auto-archive failed', {
                error: err instanceof Error ? err.message : String(err),
              });
            });
          }
        }
      }

      // ── 6. Emit error event ─────────────────────────────────────────────
      if (!success && errorMessage) {
        log.warn('audit', 'tool reported error', { tool: toolName, errorMessage });
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
        await appendAndTrack(errorEvt, sessDir, enableChainHash);
      }
    } catch (err) {
      logError(`Failed to write audit events for ${toolName}`, err);
    }
  }

  async function nextDecisionSequence(sessDir: string, sessionId: string): Promise<number> {
    const cached = decisionSequenceCache.get(sessionId);
    if (cached !== undefined) {
      const next = cached + 1;
      decisionSequenceCache.set(sessionId, next);
      return next;
    }

    const { events } = await readAuditTrail(sessDir);
    const receipts = decisionReceipts(events).filter((r) => r.sessionId === sessionId);
    const maxSequence = receipts.reduce((max, r) => Math.max(max, r.decisionSequence), 0);
    const next = maxSequence + 1;
    decisionSequenceCache.set(sessionId, next);
    return next;
  }

  async function runSerializedForSession(
    sessionId: string,
    task: () => Promise<void>,
  ): Promise<void> {
    const previous = sessionQueues.get(sessionId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(task)
      .finally(() => {
        if (sessionQueues.get(sessionId) === current) {
          sessionQueues.delete(sessionId);
        }
      });
    sessionQueues.set(sessionId, current);
    await current;
  }

  /**
   * P32: Plugin policy resolver.
   * Delegates to resolvePluginSessionPolicy for testable P32 semantics.
   */
  async function resolveSessionPolicy(
    sessDir: string | null,
  ): Promise<{ policy: FlowGuardPolicy; state: SessionState | null }> {
    return resolvePluginSessionPolicy({
      sessDir,
      configDefaultMode: config.policy.defaultMode,
      log,
    });
  }

  return {
    // ── Review enforcement gate (blocks before tool execution) ─────────────
    // Level 1+2+4: Checks that the flowguard-reviewer subagent was actually
    // invoked and findings were not tampered before allowing a self-review
    // verdict when subagent mode is active.
    // Level 3: Validates prompt integrity before subagent calls.
    'tool.execute.before': async (input, _output) => {
      const toolName: string = input?.tool ?? '';
      const sessionId: string = input?.sessionID ?? 'unknown';
      const args = getToolArgs(input);

      // Level 3: Prompt integrity enforcement for Task calls to flowguard-reviewer
      if (toolName === 'task') {
        const subagentType = typeof args.subagent_type === 'string' ? args.subagent_type : '';
        if (subagentType === REVIEWER_SUBAGENT_TYPE) {
          const eState = getEnforcementState(sessionId);
          const result = enforceBeforeSubagentCall(eState, args);

          if (!result.allowed) {
            log.warn('enforcement', 'blocked subagent call with invalid prompt', {
              tool: toolName,
              sessionId,
              code: result.code,
            });
            throw new Error(`[FlowGuard] ${result.code}: ${result.reason}`);
          }
        }
        return;
      }

      // Level 1+2+4: Enforcement for FlowGuard plan/implement verdict calls
      if (toolName !== TOOL_FLOWGUARD_PLAN && toolName !== TOOL_FLOWGUARD_IMPLEMENT) return;

      const eState = getEnforcementState(sessionId);
      const result = enforceBeforeVerdict(eState, toolName, args);

      if (!result.allowed) {
        log.warn('enforcement', 'blocked verdict submission', {
          tool: toolName,
          sessionId,
          code: result.code,
        });
        throw new Error(`[FlowGuard] ${result.code}: ${result.reason}`);
      }
    },

    'tool.execute.after': async (input, output) => {
      const toolName: string = input?.tool ?? '';
      const sessionId: string = input?.sessionID ?? 'unknown';
      const now = new Date().toISOString();

      // ── Review enforcement tracking (all tools) ─────────────────────────
      // Track FlowGuard tool responses for INDEPENDENT_REVIEW_REQUIRED signals
      // and Task calls to flowguard-reviewer subagent.
      if (toolName === TOOL_FLOWGUARD_PLAN || toolName === TOOL_FLOWGUARD_IMPLEMENT) {
        try {
          const eState = getEnforcementState(sessionId);
          trackFlowGuardEnforcement(eState, toolName, input, output, now);
        } catch (err) {
          logError('enforcement tracking failed (non-blocking)', err);
        }
      } else if (toolName === 'task') {
        try {
          const eState = getEnforcementState(sessionId);
          trackTaskEnforcement(eState, input, output, now);
        } catch (err) {
          logError('enforcement tracking failed (non-blocking)', err);
        }
      }

      await runReviewOrchestration(toolName, input, output as { output: string }, sessionId, now);

      // ── Audit event emission (only FlowGuard tools) ─────────────────────
      if (!toolName.startsWith(FG_PREFIX)) return;

      await runSerializedForSession(sessionId, () => runAudit(toolName, input, output, sessionId));
    },
  };
};
