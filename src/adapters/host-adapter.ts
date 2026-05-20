/**
 * @module adapters/host-adapter
 * @description Host-Agnostic Adapter Interface (HAI) — the single contract between
 * FlowGuard's governance engine and any host AI coding platform.
 *
 * This interface abstracts the platform-specific mechanism (how) while FlowGuard
 * core retains domain authority (what). Future adapters (Claude Code, Codex) implement
 * this same interface with their own platform mechanisms.
 *
 * Layer: adapters (may be imported by integration, not the reverse)
 *
 * Design decisions:
 * - Self-contained types: no imports from integration/ or other outer layers
 * - Structural typing: result interfaces are structurally compatible with
 *   existing internal types without circular dependencies
 * - Fail-closed: adapter failures must propagate as explicit errors, never silent fallback
 *
 * @see https://github.com/koeppben23/governed-runtime/issues/242
 * @version v1
 */

// ─── Enforcement Types ───────────────────────────────────────────────────────

/**
 * Enforcement capability level advertised by the host adapter.
 *
 * - synchronous: guaranteed block (in-process throw or exit-code-2)
 * - hook_gated: hook can block but model may have theoretical workaround paths
 * - advisory: best-effort instruction following, no hard block mechanism
 */
export type EnforcementLevel = 'synchronous' | 'hook_gated' | 'advisory';

// ─── Host Capabilities ───────────────────────────────────────────────────────

/**
 * Capabilities advertised by the host platform at initialization.
 * Used to derive enforcement level and determine available operations.
 */
export interface HostCapabilities {
  /** Can block tool execution before it runs (pre-tool gate). */
  readonly preToolBlock: boolean;
  /** Can modify tool arguments before execution. */
  readonly argMutation: boolean;
  /** Can replace tool output entirely (post-tool). */
  readonly outputReplacement: boolean;
  /** Can inject system context during session (compaction, status). */
  readonly contextInjection: boolean;
  /** Can spawn a subagent for independent review. */
  readonly reviewerSpawn: boolean;
  /** Can inject governance context during compaction events. */
  readonly compactionInjection: boolean;
}

// ─── Host Tool Event ─────────────────────────────────────────────────────────

/**
 * Normalized representation of a host tool invocation.
 * Platform-agnostic shape passed to adapter methods.
 */
export interface HostToolEvent {
  readonly tool: string;
  readonly sessionID: string;
  readonly callID: string;
  readonly args: Record<string, unknown>;
}

// ─── Enforcement Decisions ───────────────────────────────────────────────────

/** Decision to block a tool invocation. */
export interface BlockDecision {
  readonly blocked: true;
  readonly reason: string;
  readonly code: string;
}

/** Decision to allow a tool invocation, optionally with modified arguments. */
export interface AllowDecision {
  readonly blocked: false;
  readonly modifiedArgs?: Record<string, unknown>;
}

/** Discriminated union of enforcement decisions (pre-tool). */
export type EnforcementDecision = BlockDecision | AllowDecision;

// ─── Tool Result Mutation ────────────────────────────────────────────────────

/**
 * Post-tool result mutation options.
 * Platforms vary in what they support:
 * - OpenCode: full output replacement
 * - Claude Code: systemMessage + additionalContext only (no replacement)
 * - Codex: decision: "block" replaces output
 */
export interface ToolResultMutation {
  /** Replace the tool output string entirely (OpenCode, Codex). */
  readonly replaceOutput?: string;
  /** Append governance context to the tool result (Claude Code). */
  readonly appendContext?: string;
  /** Inject a system message alongside the tool result (Claude Code). */
  readonly systemMessage?: string;
}

// ─── Reviewer Types ──────────────────────────────────────────────────────────

/**
 * Configuration for spawning a reviewer subagent.
 * Contains everything the adapter needs to invoke the reviewer via
 * the platform-specific mechanism.
 */
export interface ReviewerSpawnConfig {
  readonly prompt: string;
  readonly parentSessionId: string;
  readonly reviewOutputPolicy?: 'structured_required' | 'text_compat_allowed';
  readonly reviewInvocationPolicy?: 'host_task_required' | 'host_task_preferred' | 'sdk_allowed';
  readonly maxRetries?: number;
  readonly baseDelayMs?: number;
  /** Test hook: callback on retry attempt failure. */
  readonly onAttemptFailed?: (info: {
    attempt: number;
    step: string;
    error?: unknown;
    details?: Record<string, unknown>;
  }) => void;
}

/**
 * Result of a reviewer invocation that was blocked by policy.
 * The reviewer was never actually spawned.
 */
export interface HostReviewerBlockedResult {
  readonly blocked: true;
  readonly code: string;
  readonly reason: string;
  readonly reviewInvocation?: Record<string, unknown>;
}

/**
 * Result of a reviewer invocation that reached the review transport.
 * Contains raw response, parsed findings, and assurance metadata.
 */
export interface HostReviewerSuccessResult {
  readonly blocked?: false;
  readonly sessionId: string;
  readonly rawResponse: string;
  readonly findings: Record<string, unknown> | null;
  readonly reviewOutputMode: 'structured_output' | 'text_compat';
  readonly structuredOutputUsed: boolean;
  readonly reviewAssuranceLevel: 'structured_high' | 'text_compat_lower';
  readonly extractionMethod?: 'direct_json' | 'json_fence' | 'outermost_braces';
  readonly modelCapabilityError?: string;
}

/** Discriminated union of reviewer invocation outcomes. */
export type HostReviewerResult = HostReviewerSuccessResult | HostReviewerBlockedResult;

// ─── Governance State Projection ─────────────────────────────────────────────

/**
 * Read-only projection of FlowGuard governance state.
 * Exposed to adapters for host-specific UX (status widgets, progress indicators).
 *
 * SSOT remains SessionState in FlowGuard core. This is a derived read-only view.
 * No mutation allowed — adapters may only read.
 */
export interface GovernanceStateProjection {
  readonly sessionId: string;
  readonly phase: string;
  readonly haltReason: string | null;
  readonly enforcementActive: boolean;
  readonly resumable: boolean;
  readonly riskGate: { readonly status: 'clear' | 'blocked'; readonly code?: string } | null;
}

// ─── Capability Validation ───────────────────────────────────────────────────

/** Result of runtime capability validation at adapter startup. */
export interface CapabilityValidationResult {
  readonly valid: boolean;
  readonly mismatches: ReadonlyArray<{
    readonly capability: string;
    readonly expected: boolean;
    readonly actual: boolean;
  }>;
}

// ─── Host Adapter Interface ──────────────────────────────────────────────────

/**
 * Host-Agnostic Adapter Interface (HAI).
 *
 * The single contract between FlowGuard's governance engine and any host platform.
 * Each supported platform (OpenCode, Claude Code, Codex) provides one implementation.
 *
 * Invariants:
 * - Adapter failures must propagate as explicit errors (never silent fallback)
 * - No duplicate runtime authority — HAI is the sole path to the host
 * - Blocking decisions MUST be delivered; if the adapter cannot deliver, it must throw
 *
 * @example
 * ```typescript
 * const adapter: HostAdapter = createOpenCodeHostAdapter(client, { ... });
 * await adapter.initialize();
 * const validation = await adapter.validateCapabilities();
 * if (!validation.valid) throw new Error('Host capability mismatch');
 * ```
 */
export interface HostAdapter {
  // ── Identity ─────────────────────────────────────────────────────────────

  /** Platform identifier for audit and diagnostics. */
  readonly platform: 'opencode' | 'claude-code' | 'codex';

  /** Advertised capabilities of this host platform. */
  readonly capabilities: HostCapabilities;

  /** Derived enforcement level based on host capabilities. */
  readonly enforcementLevel: EnforcementLevel;

  // ── Session Context ──────────────────────────────────────────────────────

  /** Resolve the active session ID from host context. */
  getSessionId(): string;

  /** Resolve the project working directory from host context. */
  getWorkingDirectory(): string;

  /** Resolve the worktree path from host context. */
  getWorktree(): string;

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /** Initialize the adapter and verify host connection. */
  initialize(): Promise<void>;

  /**
   * Validate that actual host capabilities match advertised capabilities.
   * Called at boot time — fail-closed on mismatch.
   */
  validateCapabilities(): Promise<CapabilityValidationResult>;

  /** Graceful shutdown and cleanup. */
  shutdown(): Promise<void>;

  // ── Enforcement (pre-tool) ───────────────────────────────────────────────

  /**
   * Deliver a block decision to the host.
   * For OpenCode: throws (in-process).
   * For Claude Code: returns deny JSON.
   * For Codex: returns deny JSON.
   *
   * MUST throw or return — never silently swallow.
   */
  deliverBlockDecision(event: HostToolEvent, decision: BlockDecision): void;

  /**
   * Deliver argument mutation to the host.
   * For OpenCode: no-op (mutation happens directly on mutable output ref).
   * For Codex: returns { updatedInput }.
   * For Claude Code: not supported (no arg mutation in hooks).
   */
  deliverArgMutation(event: HostToolEvent, args: Record<string, unknown>): void;

  // ── Result Mutation (post-tool) ──────────────────────────────────────────

  /**
   * Mutate a tool result after execution.
   * For OpenCode: replaces output string directly.
   * For Claude Code: injects systemMessage/additionalContext.
   * For Codex: replaces with block decision.
   */
  mutateToolResult(event: HostToolEvent, mutation: ToolResultMutation): void;

  // ── Subagent / Reviewer ──────────────────────────────────────────────────

  /**
   * Spawn a reviewer subagent via the platform-specific mechanism.
   * For OpenCode: SDK session.create + session.prompt.
   * For Claude Code: SubagentStart hook or TaskCreated hook.
   * For Codex: native subagent mechanism.
   *
   * Returns null when all invocation attempts are exhausted (retries failed).
   * Returns HostReviewerBlockedResult when policy prevents invocation.
   * Returns HostReviewerSuccessResult on successful review transport.
   */
  spawnReviewer(config: ReviewerSpawnConfig): Promise<HostReviewerResult | null>;

  /** Whether the host platform supports reviewer subagent spawning. */
  isReviewerSupported(): boolean;

  // ── Logging ──────────────────────────────────────────────────────────────

  /**
   * Send a log entry to the host's UI/logging system.
   * Non-blocking: logging errors must never block governance operations.
   */
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown): void;

  // ── Compaction Context (optional) ────────────────────────────────────────

  /**
   * Inject governance context during a compaction event.
   * Only available on hosts that support compaction hooks.
   */
  injectCompactionContext?(context: string): void;
}
