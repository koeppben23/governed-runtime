/**
 * @module integration/review/capture-retry
 * @description Failure classification for native reviewer capture/binding.
 *
 * Only failures a fresh reviewer attempt can plausibly repair on the same
 * frozen obligation are retryable. Capability, mandate, integrity, provenance,
 * reuse, exhaustion, and execution-mode failures fail the review closed.
 * Unknown codes are classified terminal (fail closed).
 *
 * @version v1
 */

import type { ChallengeConsistencyCode } from '../enforcement/challenge-consistency.js';
import type { ReviewFindingsScopeFailureCode } from '../enforcement/findings-consistency.js';
import { REASON_MANDATE_MISSING, REASON_MANDATE_MISMATCH } from '../shared-helpers.js';
import type { StructuredFollowupFailureCode } from './structured-followup.js';

/**
 * Codes emitted by the reviewers' binding boundary. The union is DERIVED from
 * the emitting authorities wherever they export a code union, so adding a code
 * to an emitter makes `CLASSIFICATION` fail to compile (missing key) instead of
 * silently leaving an unclassified code in the retry authority.
 */
type AttestationFailureCode = typeof REASON_MANDATE_MISSING | typeof REASON_MANDATE_MISMATCH;
/** Codes emitted by the recorder-result mapping in the after-hook. */
type RecorderFailureCode =
  'SUBAGENT_EVIDENCE_REUSED' | 'REVIEW_ATTEMPT_UNAVAILABLE' | 'REVIEW_MATERIAL_INTEGRITY_FAILED';
/** Codes emitted directly by the structured-capture/fulfillment pipeline. */
type PipelineFailureCode =
  | 'REVIEW_ASSURANCE_STATE_UNAVAILABLE'
  | 'REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE'
  | 'REVIEW_EVIDENCE_NOT_OBSERVED'
  | 'SUBAGENT_UNABLE_TO_REVIEW';

/** Every reviewer capture/binding failure code the after-hook can receive. */
export type ReviewerCaptureFailureCode =
  | ChallengeConsistencyCode
  | StructuredFollowupFailureCode
  | ReviewFindingsScopeFailureCode
  | AttestationFailureCode
  | RecorderFailureCode
  | PipelineFailureCode;

/**
 * Complete classification table. `satisfies` enforces that every variant of
 * the derived emitter union has exactly one entry; adding a new emitter code
 * without classifying it is a compile error.
 */
const CLASSIFICATION = {
  // Retryable: a fresh reviewer attempt can plausibly repair the output.
  HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION: 'retryable',
  HOST_STRUCTURED_OUTPUT_REQUIRED: 'retryable',
  REVIEW_EVIDENCE_NOT_OBSERVED: 'retryable',
  SUBAGENT_CHALLENGE_CONTRADICTED: 'retryable',
  SUBAGENT_CHALLENGE_COUNT_INCOHERENT: 'retryable',
  SUBAGENT_CHALLENGE_EVIDENCE_MISSING: 'retryable',
  SUBAGENT_CHALLENGE_INSUBSTANTIAL: 'retryable',
  SUBAGENT_CHALLENGE_KIND_INCOHERENT: 'retryable',
  SUBAGENT_CHALLENGE_NOT_DISTINCT: 'retryable',
  SUBAGENT_RESOLUTION_VERDICT_DUPLICATE: 'retryable',
  SUBAGENT_RESOLUTION_VERDICT_INCOHERENT: 'retryable',
  SUBAGENT_RESOLUTION_VERDICT_UNEXPECTED: 'retryable',
  SUBAGENT_RESOLUTION_VERDICT_UNKNOWN: 'retryable',
  REVIEW_FINDING_SUBJECT_ANCHOR_REQUIRED: 'retryable',
  REVIEW_EVIDENCE_LOCATION_ESCAPES_REPOSITORY: 'retryable',
  REVIEW_EVIDENCE_LOCATION_INVALID: 'retryable',
  REVIEW_FINDING_SUBJECT_ANCHOR_OUT_OF_SCOPE: 'retryable',
  // Terminal: capability, mandate, integrity, provenance, reuse, exhaustion.
  STRUCTURED_REVIEW_CAPABILITY_UNAVAILABLE: 'terminal',
  STRUCTURED_REVIEW_EXECUTION_MODE_INCOMPATIBLE: 'terminal',
  SUBAGENT_MANDATE_MISSING: 'terminal',
  SUBAGENT_MANDATE_MISMATCH: 'terminal',
  SUBAGENT_IMPLEMENTATION_CHALLENGE_UNRESOLVED: 'terminal',
  SUBAGENT_PRIOR_CHALLENGE_UNRESOLVED: 'terminal',
  REVIEW_SUBJECT_SCOPE_UNAVAILABLE: 'terminal',
  REVIEW_REPOSITORY_REVISION_UNAVAILABLE: 'terminal',
  SUBAGENT_EVIDENCE_REUSED: 'terminal',
  REVIEW_ATTEMPT_UNAVAILABLE: 'terminal',
  REVIEW_MATERIAL_INTEGRITY_FAILED: 'terminal',
  REVIEW_ASSURANCE_STATE_UNAVAILABLE: 'terminal',
  REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE: 'terminal',
  SUBAGENT_UNABLE_TO_REVIEW: 'terminal',
} as const satisfies Readonly<Record<ReviewerCaptureFailureCode, 'retryable' | 'terminal'>>;

type ClassificationKey = keyof typeof CLASSIFICATION;

export type RetryableReviewerCaptureCode = {
  [K in ClassificationKey]: (typeof CLASSIFICATION)[K] extends 'retryable' ? K : never;
}[ClassificationKey];

export type TerminalReviewerCaptureCode = Exclude<
  ReviewerCaptureFailureCode,
  RetryableReviewerCaptureCode
>;

function codesWithClassification(kind: 'retryable' | 'terminal'): readonly string[] {
  return (Object.keys(CLASSIFICATION) as ClassificationKey[]).filter(
    (code) => CLASSIFICATION[code] === kind,
  );
}

/** Every known retryable capture/binding failure code. */
export const RETRYABLE_REVIEWER_CAPTURE_CODES: readonly RetryableReviewerCaptureCode[] =
  codesWithClassification('retryable') as readonly RetryableReviewerCaptureCode[];

/** Every known terminal capture/binding failure code. */
export const TERMINAL_REVIEWER_CAPTURE_CODES: readonly TerminalReviewerCaptureCode[] =
  codesWithClassification('terminal') as readonly TerminalReviewerCaptureCode[];

/** Capture-retry decision. Unknown codes are terminal with their original code. */
export type ReviewerCaptureFailureDecision =
  | { readonly retryable: true; readonly code: RetryableReviewerCaptureCode }
  | { readonly retryable: false; readonly code: string };

/** String guard: is this one of the classified reviewer capture/binding codes? */
export function isKnownReviewerCaptureFailureCode(
  code: string,
): code is ReviewerCaptureFailureCode {
  return Object.prototype.hasOwnProperty.call(CLASSIFICATION, code);
}

function isRetryableCode(code: ReviewerCaptureFailureCode): code is RetryableReviewerCaptureCode {
  return CLASSIFICATION[code] === 'retryable';
}

/** Classify a reviewer capture/binding failure code; unknown codes are terminal. */
export function classifyReviewerCaptureFailure(code: string): ReviewerCaptureFailureDecision {
  if (!isKnownReviewerCaptureFailureCode(code)) return { retryable: false, code };
  return isRetryableCode(code) ? { retryable: true, code } : { retryable: false, code };
}

/** Upper bound for one host-generated retry diagnostic line. */
const MAX_RETRY_DIAGNOSTIC_CHARS = 600;

/**
 * Bounded, single-line, host-generated retry context for the immediately
 * re-armed reviewer attempt. The reason is produced by the binding authority
 * (paths, line numbers, observed line counts, schema issue paths) — never by
 * the agent. It is carried as trusted prompt context so a fresh reviewer can
 * avoid repeating the exact rejected citation without any agent repair text.
 */
export function buildCaptureRetryDiagnostics(code: string, reason: string): readonly string[] {
  const compact = reason.replace(/\s+/g, ' ').trim();
  if (compact.length === 0) return [code];
  const truncated =
    compact.length > MAX_RETRY_DIAGNOSTIC_CHARS
      ? `${compact.slice(0, MAX_RETRY_DIAGNOSTIC_CHARS)}…`
      : compact;
  return [`${code}: ${truncated}`];
}

/** Exact retry instruction the host projects after a successful re-arm. */
export function buildReviewerCaptureRetryOutput(input: {
  readonly code: string;
  readonly obligationId: string;
  readonly attemptId: string;
  readonly diagnostics?: readonly string[];
}): string {
  return JSON.stringify({
    status:
      'Reviewer capture failed its evidence contract; a fresh review attempt was re-armed on the same frozen obligation.',
    reviewDispatch: { required: true, completed: false },
    reviewRetry: {
      code: input.code,
      obligationId: input.obligationId,
      attemptId: input.attemptId,
      retryable: true,
      ...(input.diagnostics !== undefined && input.diagnostics.length > 0
        ? { diagnostics: [...input.diagnostics] }
        : {}),
    },
    agentInstruction:
      'Invoke the reviewer Task again immediately (subagent_type "flowguard-reviewer"); FlowGuard authorizes the fresh attempt with the rejected-capture diagnostics as trusted retry context. Do not re-submit reviewer findings.',
  });
}
