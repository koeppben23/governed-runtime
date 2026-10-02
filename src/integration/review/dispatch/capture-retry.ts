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

/** Capture/binding failures a bounded fresh reviewer attempt can plausibly repair. */
export const RETRYABLE_REVIEWER_CAPTURE_CODES = [
  'HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION',
  'HOST_STRUCTURED_OUTPUT_REQUIRED',
  'REVIEW_EVIDENCE_NOT_OBSERVED',
  'SUBAGENT_CHALLENGE_CONTRADICTED',
  'SUBAGENT_CHALLENGE_COUNT_INCOHERENT',
  'SUBAGENT_CHALLENGE_EVIDENCE_MISSING',
  'SUBAGENT_CHALLENGE_INSUBSTANTIAL',
  'SUBAGENT_CHALLENGE_KIND_INCOHERENT',
  'SUBAGENT_CHALLENGE_NOT_DISTINCT',
  'SUBAGENT_RESOLUTION_VERDICT_DUPLICATE',
  'SUBAGENT_RESOLUTION_VERDICT_INCOHERENT',
  'SUBAGENT_RESOLUTION_VERDICT_UNEXPECTED',
  'SUBAGENT_RESOLUTION_VERDICT_UNKNOWN',
  'REVIEW_FINDING_SUBJECT_ANCHOR_REQUIRED',
  'REVIEW_EVIDENCE_LOCATION_ESCAPES_REPOSITORY',
  'REVIEW_EVIDENCE_LOCATION_INVALID',
  'REVIEW_FINDING_SUBJECT_ANCHOR_OUT_OF_SCOPE',
] as const;

export type RetryableReviewerCaptureCode = (typeof RETRYABLE_REVIEWER_CAPTURE_CODES)[number];

/** Capture/binding failures that must fail the review closed without a retry. */
export const TERMINAL_REVIEWER_CAPTURE_CODES = [
  'STRUCTURED_REVIEW_CAPABILITY_UNAVAILABLE',
  'STRUCTURED_REVIEW_EXECUTION_MODE_INCOMPATIBLE',
  'SUBAGENT_MANDATE_MISSING',
  'SUBAGENT_MANDATE_MISMATCH',
  'SUBAGENT_IMPLEMENTATION_CHALLENGE_UNRESOLVED',
  'SUBAGENT_PRIOR_CHALLENGE_UNRESOLVED',
  'REVIEW_SUBJECT_SCOPE_UNAVAILABLE',
  'REVIEW_REPOSITORY_REVISION_UNAVAILABLE',
  'SUBAGENT_EVIDENCE_REUSED',
  'REVIEW_ATTEMPT_UNAVAILABLE',
  'REVIEW_MATERIAL_INTEGRITY_FAILED',
  'REVIEW_ASSURANCE_STATE_UNAVAILABLE',
  'REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE',
  'SUBAGENT_UNABLE_TO_REVIEW',
] as const;

export type TerminalReviewerCaptureCode = (typeof TERMINAL_REVIEWER_CAPTURE_CODES)[number];

/** Every known reviewer capture/binding failure code. */
export type ReviewerCaptureFailureCode = RetryableReviewerCaptureCode | TerminalReviewerCaptureCode;

/** Capture-retry decision. Unknown codes are terminal with their original code. */
export type ReviewerCaptureFailureDecision =
  | { readonly retryable: true; readonly code: RetryableReviewerCaptureCode }
  | { readonly retryable: false; readonly code: string };

const RETRYABLE_CODE_SET: ReadonlySet<string> = new Set(RETRYABLE_REVIEWER_CAPTURE_CODES);
const TERMINAL_CODE_SET: ReadonlySet<string> = new Set(TERMINAL_REVIEWER_CAPTURE_CODES);

/** String guard: is this one of the classified reviewer capture/binding codes? */
export function isKnownReviewerCaptureFailureCode(
  code: string,
): code is ReviewerCaptureFailureCode {
  return RETRYABLE_CODE_SET.has(code) || TERMINAL_CODE_SET.has(code);
}

// One exhaustive switch is the classification contract: an unclassified known
// code fails the exhaustive-switch check and a duplicated case fails
// no-duplicate-case. The flat 31-code shape is why the complexity budget is
// deliberately, locally raised.
// eslint-disable-next-line complexity -- exhaustive 31-code classification
function decisionForKnownCode(code: ReviewerCaptureFailureCode): ReviewerCaptureFailureDecision {
  switch (code) {
    case 'HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION':
    case 'HOST_STRUCTURED_OUTPUT_REQUIRED':
    case 'REVIEW_EVIDENCE_NOT_OBSERVED':
    case 'SUBAGENT_CHALLENGE_CONTRADICTED':
    case 'SUBAGENT_CHALLENGE_COUNT_INCOHERENT':
    case 'SUBAGENT_CHALLENGE_EVIDENCE_MISSING':
    case 'SUBAGENT_CHALLENGE_INSUBSTANTIAL':
    case 'SUBAGENT_CHALLENGE_KIND_INCOHERENT':
    case 'SUBAGENT_CHALLENGE_NOT_DISTINCT':
    case 'SUBAGENT_RESOLUTION_VERDICT_DUPLICATE':
    case 'SUBAGENT_RESOLUTION_VERDICT_INCOHERENT':
    case 'SUBAGENT_RESOLUTION_VERDICT_UNEXPECTED':
    case 'SUBAGENT_RESOLUTION_VERDICT_UNKNOWN':
    case 'REVIEW_FINDING_SUBJECT_ANCHOR_REQUIRED':
    case 'REVIEW_EVIDENCE_LOCATION_ESCAPES_REPOSITORY':
    case 'REVIEW_EVIDENCE_LOCATION_INVALID':
    case 'REVIEW_FINDING_SUBJECT_ANCHOR_OUT_OF_SCOPE':
      return { retryable: true, code };
    case 'STRUCTURED_REVIEW_CAPABILITY_UNAVAILABLE':
    case 'STRUCTURED_REVIEW_EXECUTION_MODE_INCOMPATIBLE':
    case 'SUBAGENT_MANDATE_MISSING':
    case 'SUBAGENT_MANDATE_MISMATCH':
    case 'SUBAGENT_IMPLEMENTATION_CHALLENGE_UNRESOLVED':
    case 'SUBAGENT_PRIOR_CHALLENGE_UNRESOLVED':
    case 'REVIEW_SUBJECT_SCOPE_UNAVAILABLE':
    case 'REVIEW_REPOSITORY_REVISION_UNAVAILABLE':
    case 'SUBAGENT_EVIDENCE_REUSED':
    case 'REVIEW_ATTEMPT_UNAVAILABLE':
    case 'REVIEW_MATERIAL_INTEGRITY_FAILED':
    case 'REVIEW_ASSURANCE_STATE_UNAVAILABLE':
    case 'REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE':
    case 'SUBAGENT_UNABLE_TO_REVIEW':
      return { retryable: false, code };
    default: {
      const exhaustive: never = code;
      return exhaustive;
    }
  }
}

/** Classify a reviewer capture/binding failure code; unknown codes are terminal. */
export function classifyReviewerCaptureFailure(code: string): ReviewerCaptureFailureDecision {
  return isKnownReviewerCaptureFailureCode(code)
    ? decisionForKnownCode(code)
    : { retryable: false, code };
}

/** Exact retry instruction the host projects after a successful re-arm. */
export function buildReviewerCaptureRetryOutput(input: {
  readonly code: string;
  readonly obligationId: string;
  readonly attemptId: string;
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
    },
    agentInstruction:
      'Invoke the reviewer Task again immediately (subagent_type "flowguard-reviewer"); FlowGuard authorizes the fresh attempt. Do not re-submit reviewer findings.',
  });
}
