/**
 * @module integration/review/pipeline-types
 * @description Shared runtime types for review authority wiring.
 *
 * Extracted from plugin-orchestrator.ts and plugin-workspace.ts so review/ modules
 * do not depend on plugin-* files (FG-QUAL-002).
 *
 * @version v3 — removed the deleted SDK pipeline context types
 */

import type { SessionEnforcementState } from './enforcement/types.js';
import type { OrchestratorClient } from './types.js';
import type { SessionState } from '../../state/schema.js';
import type { SemanticAuditIntent } from '../tools/audit-outbox.js';

// ─── Constants ───────────────────────────────────────────────────────────────

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
    semanticIntents?: (state: SessionState, now: string) => readonly SemanticAuditIntent[],
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
}

// ─── Internal types ──────────────────────────────────────────────────────────

/** Result of attestation validation. */
export type AttestationResult =
  { valid: true } | { valid: false; code: string; detail: Record<string, string> };

/** Result of evidence recording (reuse detection + fulfillment + missing obligation). */
export type EvidenceRecordResult = 'fulfilled' | 'reused' | 'missing' | 'lineage_unavailable';
