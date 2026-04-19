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
 *   Falls back to TEAM_POLICY if state is unavailable.
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
 * @version v4
 */

import type { Plugin } from '@opencode-ai/plugin';
import { readState, appendAuditEvent, readAuditTrail, readConfig } from '../adapters/persistence';
import {
  computeFingerprint,
  sessionDir as resolveSessionDir,
  workspaceDir as resolveWorkspaceDir,
  archiveSession,
} from '../adapters/workspace';
import {
  createToolCallEvent,
  createTransitionEvent,
  createLifecycleEvent,
  createErrorEvent,
  createDecisionEvent,
  summarizeArgs,
  GENESIS_HASH,
  type ChainedAuditEvent,
} from '../audit/types';
import { decisionReceipts } from '../audit/query';
import { getLastChainHash } from '../audit/integrity';
import {
  detectCiContext,
  policyFromSnapshot,
  resolvePolicy,
  resolvePolicyWithContext,
} from '../config/policy';
import type { FlowGuardPolicy } from '../config/policy';
import type { FlowGuardConfig } from '../config/flowguard-config';
import { DEFAULT_CONFIG } from '../config/flowguard-config';
import {
  createLogger,
  createNoopLogger,
  type FlowGuardLogger,
  type LogEntry,
} from '../logging/logger';
import type { Phase, Event } from '../state/schema';
import type { SessionState } from '../state/schema';

/** FlowGuard tool name prefix. Only tools with this prefix are audited. */
const FG_PREFIX = 'flowguard_';

/**
 * Map tool names to lifecycle actions.
 * Tools that produce lifecycle events beyond the regular tool_call event.
 */
const LIFECYCLE_TOOLS: Record<string, string> = {
  flowguard_hydrate: 'session_created',
  flowguard_abort_session: 'session_aborted',
};

/**
 * FlowGuard Audit Plugin.
 *
 * Captures worktree from plugin context at initialization time.
 * Maintains a hash chain cache for efficient chaining without re-reading the trail.
 * Hooks tool.execute.after to append structured audit events for FlowGuard tools.
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
  // Read config once at plugin init. Failures fall back to defaults — never block.
  let config: FlowGuardConfig;
  try {
    // Resolve workspace to read config from workspace dir
    const fp = await resolveFingerprint();
    if (fp && cachedWsDir) {
      config = await readConfig(cachedWsDir);
    } else {
      config = DEFAULT_CONFIG;
    }
  } catch {
    config = DEFAULT_CONFIG;
  }

  // Create logger: delegates to client.app.log if available, filtered by config level.
  // The sink maps LogEntry fields 1:1 to the OpenCode SDK's client.app.log() body shape:
  //   { body: { service, level, message, extra? } }
  // This ensures the correct log level reaches OpenCode (not always "info").
  let log: FlowGuardLogger;
  if (client?.app?.log) {
    const clientLog = client.app.log.bind(client.app);
    log = createLogger(config.logging.level, (entry: LogEntry) => {
      // Fire-and-forget — logger errors must never block the plugin
      clientLog({
        body: {
          service: entry.service,
          level: entry.level,
          message: entry.message,
          ...(entry.extra ? { extra: entry.extra } : {}),
        },
      }).catch(() => {});
    });
  } else {
    log = createNoopLogger();
  }

  log.info('plugin', 'initialized', {
    worktree: auditWorktree ?? 'none',
    logLevel: config.logging.level,
    hasConfigFile: config !== DEFAULT_CONFIG,
    fingerprint: cachedFingerprint ?? 'unknown',
  });

  // Hash chain state — cached in closure, initialized on first audit call.
  // Only updated when policy.audit.enableChainHash is true.
  let lastHash: string | null = null;
  let chainInitialized = false;
  const sessionQueues = new Map<string, Promise<void>>();
  const decisionSequenceCache = new Map<string, number>();

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

  /**
   * Parse tool output JSON with fallback for NextAction footer lines.
   */
  function parseToolResult(rawOutput: unknown): Record<string, unknown> | null {
    try {
      const resultStr = typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput);
      return JSON.parse(resultStr);
    } catch {
      try {
        const resultStr = typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput);
        const firstLine = resultStr.split('\n')[0] ?? '';
        if (!firstLine.trim()) return null;
        return JSON.parse(firstLine);
      } catch {
        return null;
      }
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
   * Resolve the FlowGuard policy for the current session.
   *
   * Resolution chain:
   * 1. Session state policySnapshot.mode (if session exists)
   * 2. Config policy.defaultMode (per-workspace config file)
   * 3. resolvePolicy(undefined) -> TEAM_POLICY (built-in default)
   *
   * Falls back to TEAM_POLICY on any failure — TEAM is the safe default
   * (human gates on, full audit, hash chain enabled).
   */
  async function resolveSessionPolicy(
    sessDir: string | null,
  ): Promise<{ policy: FlowGuardPolicy; state: SessionState | null }> {
    try {
      if (!sessDir) {
        return { policy: resolvePolicy(config.policy.defaultMode), state: null };
      }
      const state = await readState(sessDir);
      if (state?.policySnapshot) {
        const policy = policyFromSnapshot(state.policySnapshot);
        log.debug('policy', 'resolved session policy', {
          requestedMode: state.policySnapshot.requestedMode,
          effectiveMode: state.policySnapshot.mode,
        });
        return { policy, state };
      }

      const resolution = resolvePolicyWithContext(config.policy.defaultMode, detectCiContext());
      log.debug('policy', 'resolved default policy', {
        requestedMode: resolution.requestedMode,
        effectiveMode: resolution.effectiveMode,
      });
      return { policy: resolution.policy, state };
    } catch {
      log.warn('policy', 'failed to resolve session policy, using default');
      return { policy: resolvePolicy(config.policy.defaultMode), state: null };
    }
  }

  return {
    'tool.execute.after': async (input, output) => {
      // Only audit FlowGuard tools
      const toolName: string = input?.tool ?? '';
      if (!toolName.startsWith(FG_PREFIX)) return;

      const sessionId: string = input?.sessionID ?? 'unknown';
      await runSerializedForSession(sessionId, async () => {
        try {
          // Resolve session directory from tool context
          await resolveFingerprint();
          const sessDir = getSessionDir(sessionId);
          if (!sessDir) return;

          // ── Resolve policy for emission controls + actor classification ──
          const { policy, state } = await resolveSessionPolicy(sessDir);
          const { emitToolCalls, emitTransitions, enableChainHash } = policy.audit;

          log.debug('audit', 'processing tool call', {
            tool: toolName,
            emitToolCalls,
            emitTransitions,
            enableChainHash,
          });

          // Actor classification from policy — not hardcoded.
          // E.g., REGULATED classifies flowguard_decision as "human",
          // SOLO classifies it as "system" (auto-approved, no human in loop).
          const actor = policy.actorClassification[toolName] ?? 'system';

          const now = new Date().toISOString();

          // Initialize prevHash: proper chain if enabled, genesis otherwise.
          // When chaining is disabled, each event gets an independent hash
          // (prevHash is always GENESIS_HASH, no chain continuity).
          let prevHash: string;
          if (enableChainHash) {
            prevHash = await initChain(sessDir);
          } else {
            prevHash = GENESIS_HASH;
          }

          // ── Parse tool result ───────────────────────────────────────────
          let phase = 'unknown';
          let transitions: Array<{
            from: Phase;
            to: Phase;
            event: Event;
            at: string;
          }> = [];
          let success = true;
          let errorMessage: string | undefined;
          const parsed = parseToolResult(output?.output);
          if (parsed) {
            phase = typeof parsed.phase === 'string' ? parsed.phase : 'unknown';
            success = parsed.error !== true;
            errorMessage =
              typeof parsed.errorMessage === 'string' ? parsed.errorMessage : undefined;

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

          // ── 1. Emit tool_call event (conditional on policy) ─────────────
          if (emitToolCalls) {
            const argsSummary = summarizeArgs((input as Record<string, unknown>) ?? {});
            const toolCallEvt = createToolCallEvent(
              sessionId,
              phase,
              {
                tool: toolName,
                argsSummary,
                success,
                errorMessage,
                transitionCount: transitions.length,
              },
              now,
              actor,
              prevHash,
            );
            await appendAndTrack(toolCallEvt, sessDir, enableChainHash);
            if (enableChainHash) prevHash = toolCallEvt.chainHash;
            log.debug('audit', 'emitted tool_call event', { tool: toolName, phase });
          }

          // ── 2. Emit transition events (conditional on policy) ───────────
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

          // ── 3. Emit decision receipt (successful /review-decision only) ──
          if (toolName === 'flowguard_decision' && success && transitions.length > 0) {
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
                (typeof (input?.args as { rationale?: unknown } | undefined)?.rationale === 'string'
                  ? String((input?.args as { rationale?: unknown } | undefined)?.rationale)
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
                    recoveryHint:
                      'Ensure /review-decision output includes reviewDecision.decidedBy',
                    errorPhase: firstTransition.from,
                  },
                  now,
                  prevHash,
                );
                await appendAndTrack(missingActorEvt, sessDir, enableChainHash);
                if (enableChainHash) prevHash = missingActorEvt.chainHash;
              } else {
                const decisionEvt = createDecisionEvent(
                  sessionId,
                  firstTransition.from,
                  {
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
                  now,
                  actor,
                  prevHash,
                );
                await appendAndTrack(decisionEvt, sessDir, enableChainHash);
                if (enableChainHash) prevHash = decisionEvt.chainHash;
              }
            }
          }

          // ── 4. Emit lifecycle events (always — structural) ──────────────
          // Lifecycle events (session_created, session_aborted) are always
          // emitted regardless of policy. They provide session-level
          // traceability that's needed even in solo/minimal-audit modes.
          const lifecycleAction = LIFECYCLE_TOOLS[toolName];
          if (lifecycleAction) {
            log.info('audit', 'lifecycle event', { action: lifecycleAction, tool: toolName });
            // Determine final phase from transitions or parsed result
            const finalPhase =
              transitions.length > 0 ? transitions[transitions.length - 1]!.to : (phase as Phase);

            const lifecycleReason =
              lifecycleAction === 'session_created'
                ? `${
                    typeof parsed?.policyResolution === 'object'
                      ? `requested_mode:${String((parsed.policyResolution as Record<string, unknown>).requestedMode ?? 'unknown')};effective_mode:${String((parsed.policyResolution as Record<string, unknown>).effectiveMode ?? state?.policySnapshot.mode ?? policy.mode)};effective_gate_behavior:${String((parsed.policyResolution as Record<string, unknown>).effectiveGateBehavior ?? state?.policySnapshot.effectiveGateBehavior ?? (policy.requireHumanGates ? 'human_gated' : 'auto_approve'))};reason:${String((parsed.policyResolution as Record<string, unknown>).reason ?? state?.policySnapshot.degradedReason ?? 'none')}`
                      : `requested_mode:${state?.policySnapshot.requestedMode ?? policy.mode};effective_mode:${state?.policySnapshot.mode ?? policy.mode};effective_gate_behavior:${state?.policySnapshot.effectiveGateBehavior ?? (policy.requireHumanGates ? 'human_gated' : 'auto_approve')};reason:${state?.policySnapshot.degradedReason ?? 'none'}`
                  }`
                : undefined;

            const lifecycleEvt = createLifecycleEvent(
              sessionId,
              {
                action: lifecycleAction as
                  | 'session_created'
                  | 'session_completed'
                  | 'session_aborted',
                finalPhase,
                ...(lifecycleReason ? { reason: lifecycleReason } : {}),
              },
              now,
              actor, // Actor from policy (e.g., REGULATED: abort is "human")
              prevHash,
            );
            await appendAndTrack(lifecycleEvt, sessDir, enableChainHash);
            if (enableChainHash) prevHash = lifecycleEvt.chainHash;
          }

          // ── 5. Detect session completion (always — structural) ──────────
          // Session completion is a machine-driven event (topology transition
          // to COMPLETE). Always emitted, always attributed to "machine".
          const completionTransition = transitions.find((t) => t.to === 'COMPLETE');
          if (completionTransition && !LIFECYCLE_TOOLS[toolName]) {
            const completionEvt = createLifecycleEvent(
              sessionId,
              {
                action: 'session_completed',
                finalPhase: 'COMPLETE' as Phase,
              },
              now,
              'machine',
              prevHash,
            );
            await appendAndTrack(completionEvt, sessDir, enableChainHash);
            if (enableChainHash) prevHash = completionEvt.chainHash;

            // Auto-archive completed session (fire-and-forget)
            if (cachedFingerprint) {
              archiveSession(cachedFingerprint, sessionId).catch((err) => {
                log.warn('audit', 'auto-archive failed', {
                  error: err instanceof Error ? err.message : String(err),
                });
              });
            }
          }

          // ── 6. Emit error event (always — structural) ───────────────────
          // Error events are always emitted. Suppressing errors from the
          // audit trail would be a compliance gap in any mode.
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
          // Fire-and-forget: log but never block the workflow
          logError(`Failed to write audit events for ${toolName}`, err);
        }
      });
    },
  };
};
