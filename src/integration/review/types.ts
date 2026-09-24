/**
 * @module integration/review/types
 * @description Shared type definitions for the review bounded context.
 *
 * This leaf module owns the host client surface and the reviewer result DTO
 * used by the visible native Task transport and the evidence recorder. It has
 * no runtime SDK dependency and no SDK child-session creation capability.
 *
 * @version v2 — removed the SDK child-session creation/cancellation surface
 */

import type {
  TOOL_FLOWGUARD_ARCHITECTURE,
  TOOL_FLOWGUARD_IMPLEMENT,
  TOOL_FLOWGUARD_PLAN,
  TOOL_FLOWGUARD_REVIEW,
} from '../tool-names.js';

/** Tools that own a review obligation and its pending-review key. */
export type ReviewableTool =
  | typeof TOOL_FLOWGUARD_PLAN
  | typeof TOOL_FLOWGUARD_IMPLEMENT
  | typeof TOOL_FLOWGUARD_ARCHITECTURE
  | typeof TOOL_FLOWGUARD_REVIEW;

/** Per-tool pending review state. */
export type PendingReviewTool = ReviewableTool;

export interface PendingReview {
  readonly tool: PendingReviewTool;
  readonly requestedAt: string;
  attemptId: string | null;
  obligationId: string | null;
}

/** Session-level review-enforcement state. */
export interface SessionEnforcementState {
  readonly pendingReviews: Map<PendingReviewTool, PendingReview>;
}

/** Injected machine terminal-phase predicate. */
export type TerminalPhasePredicate = (phase: string) => boolean;

export interface ReviewClaimAssertionEvidence {
  readonly checkId: string;
  readonly providerId: string;
  readonly localId: string;
  readonly status: 'passed' | 'failed' | 'errored' | 'skipped';
  readonly suiteName?: string;
  readonly testName: string;
  readonly sourceFile?: string;
  readonly durationMs?: number;
}

export interface ReviewClaimAssertionEvidenceSet {
  readonly reportDigests: readonly string[];
  readonly assertions: readonly ReviewClaimAssertionEvidence[];
}

/** Shared verification-evidence DTO for state projection and prompt rendering. */
export interface ReviewVerificationEvidenceItem {
  readonly attemptId: string;
  readonly kind: string;
  readonly command: string;
  readonly passed: boolean;
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly executionMs: number;
  readonly outputDigest: string;
  readonly detail: string;
  readonly executedAt: string;
  readonly executionObservedStateDigest: string;
  readonly preCommitStateDigest: string;
  readonly stateChangedDuringExecution: boolean;
  readonly claimAssertionEvidence?: ReviewClaimAssertionEvidenceSet;
}

/**
 * Minimal SDK client interface for the review orchestrator.
 *
 * Mirrors the subset of OpencodeClient used by review modules.
 * Defined as an interface (not imported from SDK) so these modules
 * have zero runtime SDK dependency — testable with plain mocks.
 */
export interface OrchestratorClient {
  app: {
    agents(): Promise<{ data?: Array<Record<string, unknown>> | undefined; error?: unknown }>;
  };
  session: {
    prompt(opts: {
      path: { id: string };
      body: {
        agent?: string;
        system?: string;
        parts: Array<{ type: string; text: string }>;
        format?: {
          type: 'json_schema';
          schema: Record<string, unknown>;
          retryCount?: number;
        };
      };
    }): Promise<{
      data?:
        | {
            /** Response parts are diagnostics only, never reviewer authority. */
            parts?: Array<{
              type?: string;
              text?: string;
            }>;
            info?: {
              structured?: unknown;
              error?: {
                name: string;
                message?: string;
                data?: { message?: string; retries?: number };
              };
            };
          }
        | undefined;
      error?: unknown;
    }>;
  };
  /** Optional TUI client for toast notifications. Not available in headless/CLI mode. */
  tui?: {
    showToast(opts: {
      body: { message: string; variant?: 'info' | 'success' | 'error' };
    }): Promise<unknown>;
  };
}

/**
 * Successful reviewer result bound to the exact visible child session.
 *
 * `rawResponse` and any free-form text are diagnostics only; findings become
 * authority exclusively through the host-validated structured payload.
 */
export interface ReviewerSuccessResult {
  readonly blocked?: false;
  readonly sessionId: string;
  readonly rawResponse: string;
  readonly findings: Record<string, unknown> | null;
  readonly reviewOutputMode: 'structured_output';
  readonly structuredOutputUsed: boolean;
  readonly reviewAssuranceLevel: 'structured_high';
  /** Host-observed lifecycle timestamps for the successful reviewer prompt. */
  readonly invokedAt?: string;
  readonly fulfilledAt?: string;
}
