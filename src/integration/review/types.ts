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
import type { ReviewMessageCapture } from '../../state/review-message-capture.js';

/** Tools that own a review obligation and its pending-review key. */
export type ReviewableTool =
  | typeof TOOL_FLOWGUARD_PLAN
  | typeof TOOL_FLOWGUARD_IMPLEMENT
  | typeof TOOL_FLOWGUARD_ARCHITECTURE
  | typeof TOOL_FLOWGUARD_REVIEW;

/** Per-tool pending review state. */
export type PendingReviewTool = ReviewableTool;

/**
 * Reviewer task completion failure codes: the reviewer child ended without a
 * proven final review answer, so no structured output was ever produced or
 * evaluated. Canonical here so the retry prompt (prompting zone) and the
 * completion classifier (dispatch zone) share one vocabulary.
 */
const REVIEWER_COMPLETION_FAILURE_CODES = [
  'REVIEWER_COMPLETION_UNVERIFIABLE',
  'REVIEWER_TASK_ABORTED',
  'REVIEWER_OUTPUT_TRUNCATED',
  'REVIEWER_STEP_BUDGET_EXHAUSTED',
  'REVIEWER_TASK_INCOMPLETE',
  'REVIEWER_HOST_MESSAGE_ENCODING_FAILED',
] as const;

export type ReviewerCompletionFailureCode = (typeof REVIEWER_COMPLETION_FAILURE_CODES)[number];

export function isReviewerCompletionFailureCode(
  code: string,
): code is ReviewerCompletionFailureCode {
  return (REVIEWER_COMPLETION_FAILURE_CODES as readonly string[]).includes(code);
}

/** Reviewer output-cap configuration failure categories. */
export type ReviewerOutputCapErrorCode =
  | 'REVIEWER_OUTPUT_CAP_CONFIG_UNREADABLE'
  | 'REVIEWER_OUTPUT_CAP_CONFIG_INVALID'
  | 'REVIEWER_OUTPUT_CAP_MODEL_LIMIT_UNKNOWN'
  | 'REVIEWER_OUTPUT_CAP_MODEL_LIMIT_TOO_SMALL';

/** Reviewer output-cap failure retained for the native Task after-hook. */
export interface ReviewerOutputCapFailure {
  readonly code: ReviewerOutputCapErrorCode;
  readonly reason: string;
  readonly model: string;
  readonly modelLimit: number | null;
  readonly configured: number | 'host';
}

/** Terminal failure raised by the bounded reviewer execution watchdog. */
export type ReviewerExecutionFailureCode =
  'REVIEWER_EXECUTION_TIMEOUT' | 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN';

export interface ReviewerExecutionIdentity {
  readonly parentSessionId: string;
  readonly callId: string;
  readonly childSessionId?: string;
}

export interface ReviewerExecutionFailure {
  readonly code: ReviewerExecutionFailureCode;
  readonly reason: string;
  readonly phase: 'review' | 'tool' | 'serialization' | 'total';
  readonly abortConfirmed: boolean;
}

/**
 * Host-classified retry diagnostic for a re-armed reviewer attempt.
 *
 * `code` is the host validation failure code; `reasonKind` is the host
 * classification of the failure (never reviewer-authored text); `data` carries
 * only scalar values copied from reviewed material or reviewer output. Those
 * values are UNTRUSTED DATA, rendered as data only — never as instructions.
 */
export interface PendingReviewRetryDiagnostic {
  readonly code: string;
  readonly reasonKind?: string;
  readonly data?: Readonly<Record<string, string>>;
}

export interface PendingReview {
  readonly tool: PendingReviewTool;
  readonly requestedAt: string;
  attemptId: string | null;
  obligationId: string | null;
  /**
   * Transient, best-effort advisory diagnostics of the rejected prior capture
   * for the immediately re-armed attempt. They are never persisted as session
   * authority: a crash between the durable re-arm and the pending registration
   * loses the hint, while the re-armed attempt stays canonically recoverable
   * and no review authority or safety property is lost.
   */
  retryDiagnostics?: readonly PendingReviewRetryDiagnostic[];
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

/** Semantic host operations, not an SDK client or a wire-response adapter. */
export interface OrchestratorClient {
  listAgents(sessionId: string): Promise<readonly { readonly id: string }[]>;
  getSession(sessionId: string): Promise<{
    readonly sessionId: string;
    readonly parentSessionId?: string;
    readonly directory: string;
  }>;
  readHistory(sessionId: string): Promise<unknown>;
  interrupt(sessionId: string): Promise<boolean>;
  quiescence(sessionId: string): Promise<'idle' | 'busy' | 'unknown'>;
  reviewerCall(parentSessionId: string, childSessionId: string): Promise<string | null>;
  /** An admitted prompt is not a completed/correlated serialization reply. */
  executeReviewerPrompt(input: {
    readonly sessionId: string;
    readonly requestId: string;
    readonly agent: string;
    readonly model: import('../../state/review-message-capture.js').ReviewerModelSelection;
    readonly text: string;
  }): Promise<unknown>;
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
  readonly reviewOutputMode: 'validated_json';
  readonly reviewAssuranceLevel: 'host_message_validated';
  readonly capture: ReviewMessageCapture;
  /** Host-observed lifecycle timestamps for the successful reviewer prompt. */
  readonly invokedAt?: string;
  readonly fulfilledAt?: string;
}
