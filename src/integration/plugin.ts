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
 * On each FlowGuard tool execution:
 * 1. Reads session state to resolve the governing policy
 * 2. Parses the tool result JSON to extract phase, transitions, and status
 * 3. Creates a tool_call audit event if policy.audit.emitToolCalls
 * 4. Creates transition audit events for each state transition if policy.audit.emitTransitions
 * 5. Creates lifecycle events for session creation, completion, and abortion (always)
 * 6. Hash-chains events for tamper detection if policy.audit.enableChainHash
 * 7. Appends all emitted events to .flowguard/audit.jsonl
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
 * @version v2
 */

import type { Plugin } from "@opencode-ai/plugin";
import {
  readState,
  appendAuditEvent,
  readAuditTrail,
} from "../adapters/persistence";
import {
  createToolCallEvent,
  createTransitionEvent,
  createLifecycleEvent,
  createErrorEvent,
  summarizeArgs,
  GENESIS_HASH,
  type ChainedAuditEvent,
} from "../audit/types";
import { getLastChainHash } from "../audit/integrity";
import { resolvePolicy } from "../config/policy";
import type { FlowGuardPolicy } from "../config/policy";
import type { Phase, Event } from "../state/schema";

/** FlowGuard tool name prefix. Only tools with this prefix are audited. */
const FG_PREFIX = "flowguard_";

/**
 * Map tool names to lifecycle actions.
 * Tools that produce lifecycle events beyond the regular tool_call event.
 */
const LIFECYCLE_TOOLS: Record<string, string> = {
  flowguard_hydrate: "session_created",
  flowguard_abort_session: "session_aborted",
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
export const FlowGuardAuditPlugin: Plugin = async ({
  project,
  client,
  $,
  directory,
  worktree,
}) => {
  // Capture worktree from plugin context (project-level, stable)
  const auditWorktree = worktree || directory;

  // Hash chain state — cached in closure, initialized on first audit call.
  // Only updated when policy.audit.enableChainHash is true.
  let lastHash: string | null = null;
  let chainInitialized = false;

  /**
   * Initialize the chain hash by reading the existing trail.
   * Called once on first audit event, then cached.
   */
  async function initChain(): Promise<string> {
    if (chainInitialized && lastHash !== null) return lastHash;

    try {
      if (!auditWorktree) {
        lastHash = GENESIS_HASH;
        chainInitialized = true;
        return lastHash;
      }

      const { events } = await readAuditTrail(auditWorktree);
      // readAuditTrail returns AuditEvent objects — cast to raw records for getLastChainHash
      lastHash = getLastChainHash(
        events as unknown as Array<Record<string, unknown>>,
      );
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
   * @param trackChain - If true, update the cached lastHash for chain continuity.
   *   Pass false when policy.audit.enableChainHash is disabled — events still
   *   get persisted but the chain is not maintained (each event uses GENESIS_HASH).
   */
  async function appendAndTrack(
    event: ChainedAuditEvent,
    trackChain: boolean,
  ): Promise<void> {
    if (!auditWorktree) return;
    await appendAuditEvent(auditWorktree, event);
    if (trackChain) {
      lastHash = event.chainHash;
    }
  }

  /**
   * Log an audit error without blocking the workflow.
   */
  async function logError(message: string, err: unknown): Promise<void> {
    if (client?.app?.log) {
      await client.app.log({
        body: {
          service: "flowguard-audit",
          level: "error",
          message,
          extra: {
            error: err instanceof Error ? err.message : String(err),
          },
        },
      });
    }
  }

  /**
   * Resolve the FlowGuard policy for the current session.
   *
   * Reads session state from persistence to extract policySnapshot.mode,
   * then resolves the full policy (including actorClassification and audit controls).
   *
   * Falls back to TEAM_POLICY on any failure — TEAM is the safe default
   * (human gates on, full audit, hash chain enabled).
   */
  async function resolveSessionPolicy(): Promise<FlowGuardPolicy> {
    try {
      if (!auditWorktree) return resolvePolicy(undefined);
      const state = await readState(auditWorktree);
      return resolvePolicy(state?.policySnapshot?.mode);
    } catch {
      return resolvePolicy(undefined);
    }
  }

  return {
    "tool.execute.after": async (input, output) => {
      // Only audit FlowGuard tools
      const toolName: string = input?.tool ?? "";
      if (!toolName.startsWith(FG_PREFIX)) return;

      try {
        if (!auditWorktree) return;

        // ── Resolve policy for emission controls + actor classification ──
        const policy = await resolveSessionPolicy();
        const { emitToolCalls, emitTransitions, enableChainHash } =
          policy.audit;

        // Actor classification from policy — not hardcoded.
        // E.g., REGULATED classifies flowguard_decision as "human",
        // SOLO classifies it as "system" (auto-approved, no human in loop).
        const actor = policy.actorClassification[toolName] ?? "system";

        const now = new Date().toISOString();
        const sessionId = input?.sessionID ?? "unknown";

        // Initialize prevHash: proper chain if enabled, genesis otherwise.
        // When chaining is disabled, each event gets an independent hash
        // (prevHash is always GENESIS_HASH, no chain continuity).
        let prevHash: string;
        if (enableChainHash) {
          prevHash = await initChain();
        } else {
          prevHash = GENESIS_HASH;
        }

        // ── Parse tool result ───────────────────────────────────────────
        let phase = "unknown";
        let transitions: Array<{
          from: Phase;
          to: Phase;
          event: Event;
          at: string;
        }> = [];
        let success = true;
        let errorMessage: string | undefined;

        try {
          const resultStr =
            typeof output?.output === "string"
              ? output.output
              : JSON.stringify(output?.output);
          const result = JSON.parse(resultStr);

          phase = result?.phase ?? "unknown";
          success = !result?.error;
          errorMessage = result?.errorMessage;

          // Extract transitions from _audit field (set by FlowGuard tools)
          if (Array.isArray(result?._audit?.transitions)) {
            transitions = result._audit.transitions;
          }
        } catch {
          // Result wasn't JSON — still audit the tool call
        }

        // ── 1. Emit tool_call event (conditional on policy) ─────────────
        if (emitToolCalls) {
          const argsSummary = summarizeArgs(
            (input as Record<string, unknown>) ?? {},
          );
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
          await appendAndTrack(toolCallEvt, enableChainHash);
          if (enableChainHash) prevHash = toolCallEvt.chainHash;
        }

        // ── 2. Emit transition events (conditional on policy) ───────────
        if (emitTransitions) {
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
            await appendAndTrack(transEvt, enableChainHash);
            if (enableChainHash) prevHash = transEvt.chainHash;
          }
        }

        // ── 3. Emit lifecycle events (always — structural) ──────────────
        // Lifecycle events (session_created, session_aborted) are always
        // emitted regardless of policy. They provide session-level
        // traceability that's needed even in solo/minimal-audit modes.
        const lifecycleAction = LIFECYCLE_TOOLS[toolName];
        if (lifecycleAction) {
          // Determine final phase from transitions or parsed result
          const finalPhase =
            transitions.length > 0
              ? transitions[transitions.length - 1]!.to
              : (phase as Phase);

          const lifecycleEvt = createLifecycleEvent(
            sessionId,
            {
              action: lifecycleAction as
                | "session_created"
                | "session_completed"
                | "session_aborted",
              finalPhase,
            },
            now,
            actor, // Actor from policy (e.g., REGULATED: abort is "human")
            prevHash,
          );
          await appendAndTrack(lifecycleEvt, enableChainHash);
          if (enableChainHash) prevHash = lifecycleEvt.chainHash;
        }

        // ── 4. Detect session completion (always — structural) ──────────
        // Session completion is a machine-driven event (topology transition
        // to COMPLETE). Always emitted, always attributed to "machine".
        const completionTransition = transitions.find(
          (t) => t.to === "COMPLETE",
        );
        if (completionTransition && !LIFECYCLE_TOOLS[toolName]) {
          const completionEvt = createLifecycleEvent(
            sessionId,
            {
              action: "session_completed",
              finalPhase: "COMPLETE" as Phase,
            },
            now,
            "machine",
            prevHash,
          );
          await appendAndTrack(completionEvt, enableChainHash);
          if (enableChainHash) prevHash = completionEvt.chainHash;
        }

        // ── 5. Emit error event (always — structural) ───────────────────
        // Error events are always emitted. Suppressing errors from the
        // audit trail would be a compliance gap in any mode.
        if (!success && errorMessage) {
          const errorEvt = createErrorEvent(
            sessionId,
            {
              code: "TOOL_ERROR",
              message: errorMessage,
              recoveryHint: "Check tool output for details",
              errorPhase: phase as Phase,
            },
            now,
            prevHash,
          );
          await appendAndTrack(errorEvt, enableChainHash);
        }
      } catch (err) {
        // Fire-and-forget: log but never block the workflow
        await logError(`Failed to write audit events for ${toolName}`, err);
      }
    },
  };
};
