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
} from '../adapters/workspace/index.js';
import { GENESIS_HASH, type ChainedAuditEvent } from '../audit/types.js';
import { decisionReceipts } from '../audit/query.js';
import { getLastChainHash } from '../audit/integrity.js';
import { resolvePluginSessionPolicy } from './plugin-policy.js';
import { createPluginLogger } from './plugin-logging.js';
import { strictBlockedOutput, getToolArgs } from './plugin-helpers.js';
import { trackFlowGuardEnforcement, trackTaskEnforcement } from './plugin-enforcement-tracking.js';
import { appendReviewAuditEvent } from './plugin-review-audit.js';
import { blockObligation } from './plugin-review-state.js';
import {
  runReviewOrchestration as runOrchestrator,
  type OrchestratorDeps,
} from './plugin-orchestrator.js';
import { runAudit as runAuditModule, type AuditDeps } from './plugin-audit.js';
import type { FlowGuardPolicy } from '../config/policy.js';
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
import {} from './review-orchestrator.js';
import {} from './review-assurance.js';
import { TOOL_FLOWGUARD_PLAN, TOOL_FLOWGUARD_IMPLEMENT } from './tool-names.js';

/** FlowGuard tool name prefix. Only tools with this prefix are audited. */
const FG_PREFIX = 'flowguard_';

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

  // Hash chain state — per-session, not global.
  // Each session maintains an independent audit chain. The previous global
  // lastHash/chainInitialized caused cross-session chain contamination.
  type MutableChainState = {
    initialized: boolean;
    lastHash: string | null;
  };

  const chainStates = new Map<string, MutableChainState>();

  function getChainState(sessionId: string): MutableChainState {
    let state = chainStates.get(sessionId);
    if (!state) {
      state = { initialized: false, lastHash: null };
      chainStates.set(sessionId, state);
    }
    return state;
  }

  function invalidateChainState(sessionId: string): void {
    chainStates.delete(sessionId);
  }

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

  // ── Audit dependencies (injected into plugin-audit module) ──
  const auditDeps: AuditDeps = {
    resolveFingerprint,
    getSessionDir,
    resolveSessionPolicy,
    initChain,
    invalidateChainState,
    appendAndTrack,
    nextDecisionSequence,
    log,
    logError,
    cachedFingerprint,
    mode: config.policy.defaultMode ?? 'solo',
  };

  /**
   * Initialize the chain hash for a session by reading the existing trail.
   * Chain state is per-session — each session maintains an independent audit chain.
   */
  async function initChain(sessDir: string | null, sessionId: string): Promise<string> {
    const cs = getChainState(sessionId);
    if (cs.initialized && cs.lastHash !== null) return cs.lastHash;

    try {
      if (!sessDir) {
        cs.lastHash = GENESIS_HASH;
        cs.initialized = true;
        return cs.lastHash;
      }

      const { events } = await readAuditTrail(sessDir);
      cs.lastHash = getLastChainHash(events as unknown as Array<Record<string, unknown>>);
      cs.initialized = true;
      return cs.lastHash;
    } catch {
      cs.lastHash = GENESIS_HASH;
      cs.initialized = true;
      return cs.lastHash;
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
    sessionId: string,
  ): Promise<void> {
    await appendAuditEvent(sessDir, event);
    if (trackChain) {
      getChainState(sessionId).lastHash = event.chainHash;
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
  /**
   * Emit audit events — delegates to plugin-audit module.
   */
  async function runAudit(
    toolName: string,
    input: unknown,
    output: unknown,
    sessionId: string,
  ): Promise<{ auditOk: boolean; block?: boolean; code?: string; reason?: string } | undefined> {
    return runAuditModule(auditDeps, toolName, input, output, sessionId);
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
          // Read strict enforcement from session policy (P35)
          let strictEnforcement = false;
          try {
            await resolveFingerprint();
            const sessDir = getSessionDir(sessionId);
            if (sessDir) {
              const sessionState = await readState(sessDir);
              strictEnforcement =
                sessionState?.policySnapshot?.selfReview?.strictEnforcement === true;
            }
          } catch {
            // Policy unreadable — treat as non-strict
          }
          const result = enforceBeforeSubagentCall(eState, args, strictEnforcement);

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
      // Read session state for enforcement recovery (P35)
      let sessionStateForEnforcement: SessionState | null = null;
      let strictEnforcementForVerdict = true; // P35: fail-closed default
      try {
        const sessDir = getSessionDir(sessionId);
        if (sessDir) {
          sessionStateForEnforcement = await readState(sessDir);
          if (sessionStateForEnforcement) {
            strictEnforcementForVerdict =
              sessionStateForEnforcement.policySnapshot?.selfReview?.strictEnforcement === true;
          }
        }
      } catch {
        // State unreadable — strictEnforcementForVerdict stays true (fail-closed)
      }
      const result = enforceBeforeVerdict(
        eState,
        toolName,
        args,
        sessionStateForEnforcement,
        strictEnforcementForVerdict,
      );

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

      await runSerializedForSession(sessionId, async () => {
        const auditResult = await runAudit(toolName, input, output, sessionId);
        if (auditResult?.block) {
          output.output = strictBlockedOutput(auditResult.code!, {
            reason: auditResult.reason ?? 'audit persistence failed',
          });
        }
      });
    },
  };
};
