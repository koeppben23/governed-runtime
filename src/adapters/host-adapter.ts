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
 * @version v3
 */

export type EnforcementLevel = 'synchronous' | 'hook_gated' | 'advisory';

// ─── Host Capabilities ───────────────────────────────────────────────────────

/** Canonical host transport used to execute an independent reviewer. */
export type HostReviewTransportKind =
  | 'sdk_structured_session'
  | 'native_task_subagent'
  | 'native_task_structured_followup';

/** Assurance produced by one concrete review transport. */
export type HostReviewTransportAssurance = 'structured_high' | 'unstructured';

/**
 * Capabilities of ONE concrete review transport.
 *
 * `native_task_structured_followup` is one concrete transport even though it
 * has two host operations: both operate on the SAME Task child session and only
 * their composition can mint review evidence. No capability from an unrelated
 * SDK child is combined with the native Task.
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
 * A reviewer is only authoritative when the SAME transport is structured,
 * parent-visible, transcript-navigable, identity-isolated, and permission-
 * isolated. This is the hard product contract, not an advisory preference.
 */
export const REQUIRED_INDEPENDENT_REVIEW_TRANSPORT: ReviewTransportRequirements = {
  structuredOutput: true,
  parentVisible: true,
  transcriptNavigable: true,
  isolatedAgentIdentity: true,
  permissionIsolation: true,
};

export interface HostCapabilities {
  readonly preToolBlock: boolean;
  readonly argMutation: boolean;
  readonly outputReplacement: boolean;
  readonly contextInjection: boolean;
  readonly reviewTransports: readonly HostReviewTransportCapability[];
  readonly compactionInjection: boolean;
}

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

export interface ReviewerSpawnConfig {
  readonly prompt: string;
  readonly parentSessionId: string;
  readonly transportRequirements?: ReviewTransportRequirements;
  readonly authorizeDispatch: (info: {
    readonly childSessionId: string;
    readonly invokedAt: string;
  }) => Promise<void>;
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
  readonly reviewTransport: HostReviewTransportKind;
  readonly hostVisible: boolean;
  readonly transcriptNavigable: boolean;
}

export type HostReviewerResult = HostReviewerSuccessResult | HostReviewerBlockedResult;

// ─── Governance State Projection ──────────────────────────────────────────────

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
   * review requirement set. Native host-Task transports are dispatched at the
   * hook boundary and therefore reject direct adapter spawning fail-closed.
   */
  spawnReviewer(config: ReviewerSpawnConfig): Promise<HostReviewerResult | null>;

  isReviewerSupported(): boolean;

  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown): void;

  injectCompactionContext?(context: string): void;
}
