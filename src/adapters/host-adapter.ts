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
 * - Review capabilities are transport-bound. Capabilities from different transports
 *   must never be composed into a synthetic capability that no single transport owns.
 *
 * @see https://github.com/koeppben23/governed-runtime/issues/242
 * @version v2
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

/** Canonical host transport used to execute an independent reviewer. */
export type HostReviewTransportKind = 'sdk_structured_session' | 'native_task_subagent';

/** Assurance produced by one concrete review transport. */
export type HostReviewTransportAssurance = 'structured_high' | 'unstructured';

/**
 * Capabilities of ONE concrete review transport.
 *
 * These facts deliberately live on the transport, not on the host globally.
 * A host may expose a structured SDK child and a visible native Task at the same
 * time; FlowGuard must not combine those facts unless one selected transport
 * actually satisfies the complete requirement set.
 */
export interface HostReviewTransportCapability {
  readonly kind: HostReviewTransportKind;
  readonly structuredOutput: boolean;
  readonly parentVisible: boolean;
  readonly transcriptNavigable: boolean;
  readonly isolatedAgentIdentity: boolean;
  readonly permissionIsolation: boolean;
  readonly assurance: HostReviewTransportAssurance;
}

/** Required properties for the single transport selected for a review. */
export interface ReviewTransportRequirements {
  readonly structuredOutput: boolean;
  readonly parentVisible: boolean;
  readonly transcriptNavigable: boolean;
  readonly isolatedAgentIdentity: boolean;
  readonly permissionIsolation: boolean;
}

/**
 * Product-level independent-review contract.
 *
 * Visibility is a hard requirement: an invisible SDK child is real execution,
 * but it is not a sufficient user-observable independent reviewer. Navigation
 * and host-enforced permission isolation remain explicit capabilities and can be
 * tightened without inventing them before the host contract proves them.
 */
export const REQUIRED_INDEPENDENT_REVIEW_TRANSPORT: ReviewTransportRequirements = {
  structuredOutput: true,
  parentVisible: true,
  transcriptNavigable: false,
  isolatedAgentIdentity: true,
  permissionIsolation: false,
};

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
  /** Concrete, non-composable independent-review transports. */
  readonly reviewTransports: readonly HostReviewTransportCapability[];
  /** Can inject governance context during compaction events. */
  readonly compactionInjection: boolean;
}

/** Return whether one transport satisfies the complete requirement set. */
export function reviewTransportSatisfies(
  capability: HostReviewTransportCapability,
  requirements: ReviewTransportRequirements,
): boolean {
  return (
    (!requirements.structuredOutput || capability.structuredOutput) &&
    (!requirements.parentVisible || capability.parentVisible) &&
    (!requirements.transcriptNavigable || capability.transcriptNavigable) &&
    (!requirements.isolatedAgentIdentity || capability.isolatedAgentIdentity) &&
    (!requirements.permissionIsolation || capability.permissionIsolation)
  );
}

// ─── Host Tool Event ─────────────────────────────────────────────────────────

/** Normalized representation of a host tool invocation. */
export interface HostToolEvent {
  readonly tool: string;
  readonly sessionID: string;
  readonly callID: string;
  readonly args: Record<string, unknown>;
}

// ─── Enforcement Decisions ───────────────────────────────────────────────────

export interface BlockDecision {
  readonly blocked: true;
  readonly reason: string;
  readonly code: string;
}

export interface AllowDecision {
  readonly blocked: false;
  readonly modifiedArgs?: Record<string, unknown>;
}

export type EnforcementDecision = BlockDecision | AllowDecision;

// ─── Tool Result Mutation ────────────────────────────────────────────────────

export interface ToolResultMutation {
  readonly replaceOutput?: string;
  readonly appendContext?: string;
  readonly systemMessage?: string;
}

// ─── Reviewer Types ──────────────────────────────────────────────────────────

/** Configuration for spawning a reviewer subagent. */
export interface ReviewerSpawnConfig {
  readonly prompt: string;
  readonly parentSessionId: string;
  /**
   * Optional stricter call-site requirements. When omitted the canonical
   * product requirement above is used; callers can tighten, never silently
   * weaken, the transport contract.
   */
  readonly transportRequirements?: ReviewTransportRequirements;
  /** Persist dispatch before the host may release the prompt. */
  readonly authorizeDispatch: (info: {
    readonly childSessionId: string;
    readonly invokedAt: string;
  }) => Promise<void>;
  /** Resolve a host call that concluded without bindable evidence. */
  readonly abandonDispatch: (info: { readonly childSessionId: string }) => Promise<void>;
  readonly maxTransportRetries?: number;
  readonly baseDelayMs?: number;
  readonly onAttemptFailed?: (info: {
    attempt: number;
    step: string;
    error?: unknown;
    details?: Record<string, unknown>;
  }) => void;
  readonly onAttemptSucceeded?: (info: {
    attempt: number;
    step: 'session_create' | 'session_prompt';
    parentSessionId: string;
    childSessionId: string;
    durationMs: number;
  }) => void;
}

export interface HostReviewerBlockedResult {
  readonly blocked: true;
  readonly code: string;
  readonly reason: string;
  readonly reviewInvocation?: Record<string, unknown>;
}

export interface HostReviewerSuccessResult {
  readonly blocked?: false;
  readonly sessionId: string;
  readonly rawResponse: string;
  readonly findings: Record<string, unknown> | null;
  readonly reviewOutputMode: 'structured_output';
  readonly structuredOutputUsed: boolean;
  readonly reviewAssuranceLevel: 'structured_high';
  /** Exact host transport that produced this result. */
  readonly reviewTransport: HostReviewTransportKind;
  readonly hostVisible: boolean;
  readonly transcriptNavigable: boolean;
}

export type HostReviewerResult = HostReviewerSuccessResult | HostReviewerBlockedResult;

// ─── Governance State Projection ─────────────────────────────────────────────

export interface GovernanceStateProjection {
  readonly sessionId: string;
  readonly phase: string;
  readonly haltReason: string | null;
  readonly enforcementActive: boolean;
  readonly resumable: boolean;
  readonly riskGate: { readonly status: 'clear' | 'blocked'; readonly code?: string } | null;
}

// ─── Capability Validation ───────────────────────────────────────────────────

export interface CapabilityValidationResult {
  readonly valid: boolean;
  readonly mismatches: ReadonlyArray<{
    readonly capability: string;
    readonly expected: boolean;
    readonly actual: boolean;
  }>;
  readonly runtimeVerified: ReadonlyArray<string>;
  readonly contractAttested: ReadonlyArray<string>;
}

// ─── Host Adapter Interface ──────────────────────────────────────────────────

export interface HostAdapter {
  readonly platform: 'opencode' | 'claude-code' | 'codex';
  readonly capabilities: HostCapabilities;
  readonly enforcementLevel: EnforcementLevel;

  getWorkingDirectory(): string;
  getWorktree(): string;

  initialize(): Promise<void>;
  validateCapabilities(): Promise<CapabilityValidationResult>;
  shutdown(): Promise<void>;

  deliverBlockDecision(event: HostToolEvent, decision: BlockDecision): void;
  deliverArgMutation(event: HostToolEvent, args: Record<string, unknown>): void;
  mutateToolResult(event: HostToolEvent, mutation: ToolResultMutation): void;

  /**
   * Spawn a reviewer through one concrete transport that satisfies the complete
   * review requirement set. A host with no such transport must return a typed
   * blocked result before any child session is released.
   */
  spawnReviewer(config: ReviewerSpawnConfig): Promise<HostReviewerResult | null>;

  isReviewerSupported(): boolean;

  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown): void;

  injectCompactionContext?(context: string): void;
}
