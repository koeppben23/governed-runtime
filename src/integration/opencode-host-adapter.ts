/**
 * @module integration/opencode-host-adapter
 * @description OpenCode platform adapter — first concrete implementation of HostAdapter (HAI).
 *
 * Wraps the OpenCode SDK client, providing FlowGuard core access to host-specific
 * mechanisms (reviewer spawning, UI logging, tool blocking) through the HAI contract.
 *
 * Design:
 * - Delegates to existing modules (invokeReviewer, plugin-logging) — zero behavior change
 * - Lives in integration/ because it imports from @opencode-ai/plugin SDK surface
 * - Structural typing ensures HostReviewerResult is satisfied by ReviewerResult
 * - No boot-time host I/O; reviewer capability is verified lazily on invocation
 *
 * @see https://github.com/koeppben23/governed-runtime/issues/242
 * @version v3
 */

import type {
  HostAdapter,
  HostCapabilities,
  HostToolEvent,
  BlockDecision,
  ToolResultMutation,
  ReviewerSpawnConfig,
  HostReviewerResult,
  CapabilityValidationResult,
  EnforcementLevel,
} from '../adapters/host-adapter.js';
import type { OrchestratorClient } from './review/types.js';
import { invokeReviewer } from './review/orchestrator.js';
import { buildEnforcementError } from './plugin-helpers.js';

// ─── Configuration ───────────────────────────────────────────────────────────

/** Configuration for creating an OpenCode host adapter. */
export interface OpenCodeAdapterConfig {
  /** OpenCode SDK client instance. */
  readonly client: OrchestratorClient;
  /** Project working directory. */
  readonly directory: string;
  /** Worktree path. */
  readonly worktree: string;
}

// ─── OpenCode Host Adapter ───────────────────────────────────────────────────

/** Fail-closed boot error: the SDK client cannot guarantee the adapter contract. */
export class HostAdapterInitError extends Error {
  readonly code = 'HOST_ADAPTER_INIT_FAILED' as const;

  constructor(message: string) {
    super(message);
    this.name = 'HostAdapterInitError';
  }
}

/** Fail-closed boot error: probed host capabilities do not match the contract. */
export class HostCapabilityMismatchError extends Error {
  readonly code = 'HOST_CAPABILITY_MISMATCH' as const;

  constructor(mismatches: ReadonlyArray<{ readonly capability: string }>) {
    const names = mismatches.map((mismatch) => mismatch.capability).join(', ');
    super(`[FlowGuard] OpenCode host capability mismatch: ${names || 'unknown'}`);
    this.name = 'HostCapabilityMismatchError';
  }
}

/**
 * OpenCode platform adapter.
 *
 * Enforcement model: synchronous (in-process throw blocks tool execution).
 * All capabilities are supported (full mutation, reviewer spawn, compaction).
 */
export class OpenCodeHostAdapter implements HostAdapter {
  readonly platform = 'opencode' as const;

  readonly capabilities: HostCapabilities = {
    preToolBlock: true,
    argMutation: true,
    outputReplacement: true,
    contextInjection: true,
    reviewerSpawn: true,
    compactionInjection: true,
  };

  readonly enforcementLevel: EnforcementLevel = 'synchronous';

  private readonly client: OrchestratorClient;
  private readonly directoryPath: string;
  private readonly worktreePath: string;

  constructor(config: OpenCodeAdapterConfig) {
    this.client = config.client;
    this.directoryPath = config.directory;
    this.worktreePath = config.worktree;
  }

  // ── Session Context ──────────────────────────────────────────────────────

  getWorkingDirectory(): string {
    return this.directoryPath;
  }

  getWorktree(): string {
    return this.worktreePath;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    // OpenCode SDK client is ready at plugin load time — no async init needed.
    // Verify the client surface is structurally callable (fail-closed on a
    // drifting SDK that exposes truthy non-functions).
    if (
      typeof this.client?.session?.create !== 'function' ||
      typeof this.client?.session?.prompt !== 'function'
    ) {
      throw new HostAdapterInitError(
        '[FlowGuard] OpenCode adapter initialization failed: SDK client missing ' +
          'session.create or session.prompt methods. Cannot guarantee reviewer capability.',
      );
    }
  }

  /**
   * Report which capabilities are runtime-verified versus contract-attested.
   *
   * Deliberately performs no host call at boot. An `app.agents()` probe during
   * plugin initialization can start a re-entrant host request (deadlock risk),
   * and a successful registry listing would not even prove that the
   * `flowguard-reviewer` agent is resolvable. Reviewer capability is verified
   * lazily on the real invocation path by `resolveReviewerAgent()`, so
   * `reviewerSpawn` stays contract-attested here instead of being reported as
   * runtime-verified.
   */
  async validateCapabilities(): Promise<CapabilityValidationResult> {
    return {
      valid: true,
      mismatches: [],
      runtimeVerified: [],
      contractAttested: Object.keys(this.capabilities),
    };
  }

  async shutdown(): Promise<void> {
    // OpenCode plugin lifecycle is managed by the SDK — no cleanup needed.
  }

  // ── Enforcement (pre-tool) ───────────────────────────────────────────────

  deliverBlockDecision(_event: HostToolEvent, decision: BlockDecision): void {
    // OpenCode enforcement: throw from hook handler to block tool execution.
    throw buildEnforcementError(decision.code, decision.reason);
  }

  deliverArgMutation(_event: HostToolEvent, _args: Record<string, unknown>): void {
    // OpenCode: argument mutation happens directly on the mutable output.args
    // reference provided by the hook system. No adapter action needed — the
    // caller mutates the reference directly before this method would be called.
    // This method exists for platforms (Codex) that need explicit arg delivery.
  }

  // ── Result Mutation (post-tool) ──────────────────────────────────────────

  mutateToolResult(_event: HostToolEvent, _mutation: ToolResultMutation): void {
    // OpenCode: output mutation happens directly on the mutable hookOutput.output
    // reference in the after-hook handler. The caller sets output.output = newString.
    // This method exists for platforms (Claude Code) that use systemMessage injection.
  }

  // ── Subagent / Reviewer ──────────────────────────────────────────────────

  async spawnReviewer(config: ReviewerSpawnConfig): Promise<HostReviewerResult | null> {
    const options: Record<string, unknown> = {};
    if (config.reviewOutputPolicy !== undefined) {
      options.reviewOutputPolicy = config.reviewOutputPolicy;
    }
    if (config.reviewInvocationPolicy !== undefined) {
      options.reviewInvocationPolicy = config.reviewInvocationPolicy;
    }
    if (config.maxRetries !== undefined) {
      options.maxRetries = config.maxRetries;
    }
    if (config.baseDelayMs !== undefined) {
      options.baseDelayMs = config.baseDelayMs;
    }
    if (config.onAttemptFailed !== undefined) {
      options._onAttemptFailed = config.onAttemptFailed;
    }
    if (config.onAttemptSucceeded !== undefined) {
      options._onAttemptSucceeded = config.onAttemptSucceeded;
    }

    const result = await invokeReviewer(
      this.client,
      config.prompt,
      config.parentSessionId,
      options,
    );

    // Preserve null semantics: null means all retries exhausted, no response.
    if (result === null) return null;

    // ReviewerResult is structurally compatible with HostReviewerResult.
    return result;
  }

  isReviewerSupported(): boolean {
    return true;
  }

  // ── Logging ──────────────────────────────────────────────────────────────

  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown): void {
    // Delegate to OpenCode SDK UI log. Non-blocking: errors caught silently.
    if (this.client.tui?.showToast && (level === 'warn' || level === 'error')) {
      this.client.tui
        .showToast({
          body: {
            message: `[FlowGuard] ${message}`,
            variant: level === 'error' ? 'error' : 'info',
          },
        })
        .catch(() => {
          /* non-blocking */
        });
    }
    // Structured log data is handled by the file/console sinks in plugin-logging.
    // The adapter.log() is specifically for host UI feedback.
    void data;
  }

  // ── Compaction Context ───────────────────────────────────────────────────

  injectCompactionContext(_context: string): void {
    // OpenCode: compaction context injection happens directly via
    // output.context.push() in the hook handler. This method exists for
    // platforms that use a different injection mechanism.
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create an OpenCode host adapter from an SDK client.
 * Used by plugin.ts (composition root) and test helpers.
 */
export function createOpenCodeHostAdapter(config: OpenCodeAdapterConfig): HostAdapter {
  return new OpenCodeHostAdapter(config);
}
