/**
 * @module integration/review/pipeline-types
 * @description Shared types, interfaces, and constants for review pipeline orchestration.
 *
 * Extracted from plugin-orchestrator.ts and plugin-workspace.ts so review/ modules
 * do not depend on plugin-* files (FG-QUAL-002).
 *
 * @version v2 — added HostAdapter to OrchestratorDeps (HAI #242)
 */

import type { SessionEnforcementState } from './enforcement/types.js';
import type { OrchestratorClient } from './orchestrator.js';
import { extractReviewContext } from './orchestrator.js';
import type { SessionState } from '../../state/schema.js';
import type { HostAdapter } from '../../adapters/host-adapter.js';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Invocation mode for SDK-driven session prompts (not host-visible). */
export const INVOCATION_MODE_SDK_SESSION = 'sdk_session_prompt' as const;

/** Evidence source tag for host-orchestrated reviews. */
export const EVIDENCE_SOURCE_HOST = 'host-orchestrated' as const;

// ─── Public interfaces ───────────────────────────────────────────────────────

/**
 * Session identity context bundled for review operations.
 * Originally defined in plugin-workspace.ts (moved per FG-QUAL-002).
 */
export interface ReviewSessionContext {
  readonly sessDir: string;
  readonly sessionId: string;
  readonly phase: string;
}

/**
 * Dependency interface for closure-captured values in plugin.ts.
 */
export interface OrchestratorDeps {
  resolveFingerprint(): Promise<string | null>;
  getSessionDir(sessionId: string): string | null;
  updateReviewAssurance(
    sessDir: string,
    update: (state: SessionState, now: string) => SessionState,
  ): Promise<void>;
  blockReviewOutcome(
    ctx: ReviewSessionContext,
    obligationId: string,
    code: string,
    detail: Record<string, string>,
    output: { output: string },
  ): Promise<void>;
  getEnforcementState(sessionId: string): SessionEnforcementState;
  log: {
    info(service: string, message: string, extra?: Record<string, unknown>): void;
    warn(service: string, message: string, extra?: Record<string, unknown>): void;
  };
  client: OrchestratorClient;
  /**
   * Host-agnostic adapter (HAI #242).
   * Pipelines use adapter.spawnReviewer() instead of direct client SDK calls.
   */
  adapter: HostAdapter;
}

/**
 * Tool invocation captured by the plugin hook.
 *
 * Bundles the input and output from tool.execute.after
 * into a single object for cleaner function signatures.
 */
export interface ToolCallEvent {
  readonly toolName: string;
  readonly input: unknown;
  readonly output: { output: string };
  readonly sessionId: string;
  readonly now: string;
}

// ─── Internal types ──────────────────────────────────────────────────────────

/** Shared context passed to pipeline functions after validation. */
export interface PipelineContext {
  deps: OrchestratorDeps;
  sessionState: SessionState;
  sessDir: string;
  reviewCtx: NonNullable<ReturnType<typeof extractReviewContext>>;
  parsedOutput: Record<string, unknown>;
  output: { output: string };
  sessionId: string;
  now: string;
  rawOutput: string;
  strictEnforcement: boolean;
}

/** Result of strict attestation validation. */
export type AttestationResult =
  | { valid: true }
  | { valid: false; code: string; detail: Record<string, string> };

/** Result of evidence recording (reuse detection + fulfillment). */
export type EvidenceRecordResult = 'fulfilled' | 'reused';

// ─── Re-exports for external consumers ───────────────────────────────────────

export type { SessionEnforcementState } from './enforcement/types.js';
export type { OrchestratorClient, ReviewerSuccessResult } from './orchestrator.js';
export type { SessionState } from '../../state/schema.js';
export type { ReviewObligationType } from '../../state/evidence.js';
