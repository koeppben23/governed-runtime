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
import type { EvidenceLocationFailure } from '../observations/observation-binding.js';
import type { ReviewObligationType } from '../../../state/evidence.js';
import { REASON_MANDATE_MISSING, REASON_MANDATE_MISMATCH } from '../shared-helpers.js';
import type { PendingReviewRetryDiagnostic, ReviewerCompletionFailureCode } from '../types.js';
import type { StructuredFollowupFailureCode } from './native-task-review-types.js';

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
  | ReviewerCompletionFailureCode
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
  REVIEWER_TASK_INCOMPLETE: 'retryable',
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
  REVIEWER_STEP_BUDGET_EXHAUSTED: 'terminal',
  REVIEWER_OUTPUT_TRUNCATED: 'terminal',
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
  // An abort may be intentional (user stop): never restarted automatically.
  REVIEWER_TASK_ABORTED: 'terminal',
  REVIEWER_COMPLETION_UNVERIFIABLE: 'terminal',
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

/** Reviewer-capacity failures that close the obligation without an automatic re-arm. */
export const CAPACITY_REVIEWER_CAPTURE_CODES = [
  'REVIEWER_STEP_BUDGET_EXHAUSTED',
  'REVIEWER_OUTPUT_TRUNCATED',
] as const;
export type CapacityReviewerCaptureCode = (typeof CAPACITY_REVIEWER_CAPTURE_CODES)[number];

export function isCapacityReviewerCaptureCode(code: string): code is CapacityReviewerCaptureCode {
  return (CAPACITY_REVIEWER_CAPTURE_CODES as readonly string[]).includes(code);
}

/**
 * Phase-legal recovery for a spent/interrupted reviewer release. Every
 * obligation family has a typed or command-native recovery that re-arms the
 * same frozen obligation with a fresh attempt.
 */
export function transportRecoveryInstruction(obligationType: ReviewObligationType): string {
  switch (obligationType) {
    case 'implement':
      return 'Call flowguard_review_implementation with reviewRecovery: "retry_transport" to re-arm the same review obligation with a fresh attempt, then invoke Task again.';
    case 'plan':
      return 'Call flowguard_plan({ reviewRecovery: "retry_transport" }) to re-arm the same review obligation with a fresh attempt, then invoke Task again.';
    case 'architecture':
      return 'Call flowguard_architecture({ reviewRecovery: "retry_transport" }) to re-arm the same review obligation with a fresh attempt, then invoke Task again.';
    case 'review':
      return 'Re-run flowguard_review with reviewObligationId to re-arm the same frozen review obligation with a fresh attempt, then invoke Task again.';
  }
}

const MAX_BLOCK_REASON_CHARS = 240;
const MAX_DIAGNOSTIC_SUMMARY_ENTRIES = 3;
const MAX_DIAGNOSTIC_VALUE_CHARS = 160;

/** Failure codes whose catalog message interpolates the failing finding index. */
const FINDING_INDEX_FAILURE_CODES: ReadonlySet<string> = new Set([
  'REVIEW_FINDING_SUBJECT_ANCHOR_REQUIRED',
  'REVIEW_FINDING_SUBJECT_ANCHOR_OUT_OF_SCOPE',
  'REVIEW_EVIDENCE_LOCATION_ESCAPES_REPOSITORY',
  'REVIEW_EVIDENCE_LOCATION_INVALID',
  'REVIEW_REPOSITORY_REVISION_UNAVAILABLE',
]);

/** Max finding positions transported per diagnostic; bounds the transported list. */
const MAX_FINDING_INDEX_POSITIONS = 8;
/** Max frozen subject paths transported per diagnostic; bounds the transported list. */
const MAX_ALLOWED_SUBJECT_PATHS = 20;

function boundCaptureReason(reason: string): string {
  const firstLine = reason.split('\n')[0]?.trim() ?? '';
  return firstLine.length > MAX_BLOCK_REASON_CHARS
    ? `${firstLine.slice(0, MAX_BLOCK_REASON_CHARS)}…`
    : firstLine;
}

/**
 * Validator-derived finding positions ONLY: a comma-separated list is
 * re-normalized to canonical decimal positions, dropping every segment that is
 * not a valid non-negative integer. Returns undefined when no valid position
 * remains, so no invented value ever travels and callers degrade to the
 * code-only diagnostic instead.
 */
function normalizeFindingIndexes(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const positions: string[] = [];
  for (const segment of value.split(',')) {
    const candidate = segment.trim();
    if (!/^\d{1,9}$/.test(candidate)) continue;
    positions.push(String(Number.parseInt(candidate, 10)));
    if (positions.length >= MAX_FINDING_INDEX_POSITIONS) break;
  }
  return positions.length > 0 ? positions.join(', ') : undefined;
}

/** First validated finding position carried by the diagnostics, when present. */
function firstFindingIndex(
  diagnostics: readonly PendingReviewRetryDiagnostic[],
): string | undefined {
  for (const diagnostic of diagnostics) {
    const normalized = normalizeFindingIndexes(diagnostic.data?.findingIndex);
    if (normalized !== undefined) return normalized;
  }
  return undefined;
}

/**
 * Challenge-evidence failure reasons the canonical consistency validator emits.
 * Only these machine-produced values may reach a recovery instruction.
 */
const CHALLENGE_EVIDENCE_REASONS: ReadonlySet<string> = new Set([
  'validation_attempt_missing',
  'implementation_reference_missing',
  'evidence_missing',
  'evidence_mismatch',
  'obligation_mismatch',
]);

/** Required reference kind named by each missing-evidence reason. */
const REQUIRED_REF_BY_REASON: Readonly<Record<string, string>> = {
  validation_attempt_missing: 'validation_attempt',
  implementation_reference_missing: 'implementation',
};

/**
 * Validator-derived challenge position ONLY: a non-negative integer or
 * undefined. Anything else degrades to the code-only diagnostic, so no
 * reviewer-authored value is ever echoed back as a field path.
 */
function normalizeChallengeIndex(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** Bounded, structured diagnostic summary derived from the retry diagnostics. */
function boundedDiagnosticSummary(diagnostics: readonly PendingReviewRetryDiagnostic[]): string[] {
  const entries: string[] = [];
  for (const diagnostic of diagnostics) {
    for (const [key, value] of Object.entries(diagnostic.data ?? {}).slice(0, 2)) {
      entries.push(
        `${key}=${
          value.length > MAX_DIAGNOSTIC_VALUE_CHARS
            ? `${value.slice(0, MAX_DIAGNOSTIC_VALUE_CHARS)}…`
            : value
        }`,
      );
      if (entries.length >= MAX_DIAGNOSTIC_SUMMARY_ENTRIES) return entries;
    }
  }
  return entries;
}

/**
 * Block detail for a native reviewer capture/binding failure. The real
 * obligation id is always interpolated (never a `{obligationId}` placeholder),
 * the raw capture reason is bounded to its first line, and the concrete
 * location failures travel as a bounded structured summary instead of a raw
 * JSON blob (Run-10 diagnostics). Validated finding positions from the
 * diagnostics travel as their own `findingIndex` field so the catalog template
 * interpolates the actual rejected finding instead of a raw placeholder.
 */
export function captureFailureBlockDetail(input: {
  readonly obligationId: string;
  readonly reason: string;
  readonly diagnostics?: readonly PendingReviewRetryDiagnostic[];
}): Record<string, string> {
  const detail: Record<string, string> = {
    obligationId: input.obligationId,
    reason: boundCaptureReason(input.reason),
  };
  const diagnostics = input.diagnostics ?? [];
  const summary = boundedDiagnosticSummary(diagnostics);
  if (summary.length > 0) detail.diagnostics = summary.join(' | ');
  const findingIndex = firstFindingIndex(diagnostics);
  if (findingIndex !== undefined) detail.findingIndex = findingIndex;
  return detail;
}

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

/**
 * Central prompt/output budget for retry diagnostics: at most this many
 * failure entries and this many characters per untrusted scalar reach the
 * reviewer prompt. The limits protect the prompt budget without altering the
 * underlying review evidence or the operator envelope.
 */
export const MAX_RETRY_DIAGNOSTICS = 8;
export const MAX_RETRY_SCALAR_CHARS = 200;

function truncateRetryScalar(value: string): string {
  return value.length > MAX_RETRY_SCALAR_CHARS
    ? `${value.slice(0, MAX_RETRY_SCALAR_CHARS)}…`
    : value;
}

/** Host-classified, code-only retry diagnostic for a capture/binding failure. */
export function buildCodeOnlyRetryDiagnostic(code: string): PendingReviewRetryDiagnostic {
  return { code };
}

/** The scalar data carried by one structured evidence-location failure. */
function locationFailureData(failure: EvidenceLocationFailure): Readonly<Record<string, string>> {
  const data: Record<string, string> = {};
  if ('path' in failure) data.path = truncateRetryScalar(failure.path);
  if ('revision' in failure) data.revision = failure.revision;
  if ('line' in failure) data.line = String(failure.line);
  if ('endLine' in failure) data.endLine = String(failure.endLine);
  if ('lineCount' in failure) data.lineCount = String(failure.lineCount);
  return data;
}

/**
 * Host-classified retry diagnostics for structured evidence-location failures.
 * Scalars copied from reviewed material are carried as data values only and are
 * centrally bounded in count and length.
 */
export function buildBindingRetryDiagnostics(
  code: RetryableReviewerCaptureCode,
  failures: readonly EvidenceLocationFailure[],
): readonly PendingReviewRetryDiagnostic[] {
  return failures.slice(0, MAX_RETRY_DIAGNOSTICS).map((failure) => ({
    code,
    reasonKind: failure.kind,
    data: locationFailureData(failure),
  }));
}

/**
 * Max structured reviewer-contract diagnostics carried per capture failure.
 * The primary failure leads; further issues must not turn diagnostics into a
 * second copy of the rejected payload.
 */
export const MAX_STRUCTURED_CONTRACT_DIAGNOSTICS = 3;

function structuredIssueRecord(issue: unknown): Record<string, unknown> | null {
  return issue && typeof issue === 'object' ? (issue as Record<string, unknown>) : null;
}

function structuredIssuePath(issue: Record<string, unknown>): string {
  const path = issue.path;
  if (!Array.isArray(path)) return '';
  return path
    .filter(
      (segment): segment is string | number =>
        typeof segment === 'string' || typeof segment === 'number',
    )
    .map(String)
    .join('.');
}

/** Allowed values or expected type of a canonical schema issue, when present. */
function structuredIssueConstraint(issue: Record<string, unknown>): string | undefined {
  const values = issue.values;
  if (
    Array.isArray(values) &&
    values.length > 0 &&
    values.every(
      (value) =>
        typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean',
    )
  ) {
    return values.map(String).join('|');
  }
  const expected = issue.expected;
  return typeof expected === 'string' && expected.length > 0 ? expected : undefined;
}

/**
 * Bounded, data-lean diagnostics for a reviewer findings payload rejected by
 * the canonical ReviewerFindingsInput schema. Only the offending field path,
 * the issue code, and the violated constraint travel — never the rejected
 * value, raw schema output, or any other reviewer-authored content.
 */
export function buildStructuredFindingsContractDiagnostics(
  issues: readonly unknown[],
): readonly PendingReviewRetryDiagnostic[] {
  const diagnostics: PendingReviewRetryDiagnostic[] = [];
  for (const issue of issues) {
    const record = structuredIssueRecord(issue);
    if (!record) continue;
    const code = record.code;
    if (typeof code !== 'string' || code.length === 0) continue;
    const constraint = structuredIssueConstraint(record);
    diagnostics.push({
      code: 'HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION',
      reasonKind: truncateRetryScalar(code),
      data: {
        path: truncateRetryScalar(structuredIssuePath(record)),
        ...(constraint !== undefined ? { constraint: truncateRetryScalar(constraint) } : {}),
      },
    });
    if (diagnostics.length >= MAX_STRUCTURED_CONTRACT_DIAGNOSTICS) break;
  }
  return diagnostics;
}

/**
 * Short, primary-first block reason for a canonical reviewer-contract
 * rejection. The first offending field and its violated constraint lead, so
 * the bounded operator envelope keeps the decisive cause instead of a
 * truncated serialization of raw schema output.
 */
export function structuredFindingsContractReason(issues: readonly unknown[]): string {
  const [first] = buildStructuredFindingsContractDiagnostics(issues);
  const count = issues.length;
  const noun = count === 1 ? 'issue' : 'issues';
  if (!first) {
    return `ReviewerFindingsInput rejected (${String(count)} schema ${noun}); no structured issue detail available`;
  }
  const path = first.data?.path ?? '';
  const constraint = first.data?.constraint;
  const detail =
    constraint !== undefined
      ? `expected ${constraint}`
      : (first.reasonKind ?? 'contract_violation');
  return `ReviewerFindingsInput rejected (${String(count)} schema ${noun}); first: ${path} — ${detail}`;
}

/**
 * Data-lean audit projection of bounded capture diagnostics for the durable
 * closure record: reason kind, field path, and violated constraint only.
 */
export function captureClosureAuditDiagnostics(
  diagnostics: readonly PendingReviewRetryDiagnostic[],
): readonly Readonly<Record<string, string>>[] {
  return diagnostics.slice(0, MAX_STRUCTURED_CONTRACT_DIAGNOSTICS).map((diagnostic) => ({
    reasonKind: diagnostic.reasonKind ?? diagnostic.code,
    path: diagnostic.data?.path ?? '',
    ...(diagnostic.data?.constraint !== undefined
      ? { constraint: diagnostic.data.constraint }
      : {}),
  }));
}

const REVISION_VALUES = new Set(['base', 'head']);

/** Runtime field shape per failure kind; mirrors the EvidenceLocationFailure union. */
const LOCATION_FAILURE_SHAPES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  no_attempt: { path: 'string' },
  revision_unavailable: { revision: 'revision' },
  unobserved: { path: 'string', revision: 'revision' },
  binary_line_citation: { path: 'string', revision: 'revision' },
  line_out_of_range: { path: 'string', revision: 'revision', line: 'number', lineCount: 'number' },
  end_line_out_of_range: {
    path: 'string',
    revision: 'revision',
    endLine: 'number',
    lineCount: 'number',
  },
};

function fieldMatches(value: unknown, expected: string): boolean {
  if (expected !== 'revision') return typeof value === expected;
  return typeof value === 'string' && REVISION_VALUES.has(value);
}

function matchesLocationFailureShape(
  record: Record<string, unknown>,
  shape: Readonly<Record<string, string>>,
): boolean {
  return Object.entries(shape).every(([key, expected]) => fieldMatches(record[key], expected));
}

/** Defensive runtime shape check for a details-carried structured failure. */
function isEvidenceLocationFailure(value: unknown): value is EvidenceLocationFailure {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  const shape = typeof kind === 'string' ? LOCATION_FAILURE_SHAPES[kind] : undefined;
  return shape !== undefined && matchesLocationFailureShape(record, shape);
}

/**
 * Build the retry diagnostics for one object-shaped capture/binding failure.
 * REVIEW_EVIDENCE_NOT_OBSERVED carries structured location failures; scope and
 * anchor failures carry the validator-derived finding positions. Any malformed
 * or unexpected details shape degrades to the code-only diagnostic.
 */
/**
 * Out-of-scope findings transport the validator-derived positions and the
 * frozen allowed subject paths. Both are bounded; absent values degrade to the
 * code-only diagnostic.
 */
function outOfScopeDiagnostic(
  code: string,
  details: Readonly<Record<string, unknown>>,
): readonly PendingReviewRetryDiagnostic[] | null {
  if (code !== 'REVIEW_FINDING_SUBJECT_ANCHOR_OUT_OF_SCOPE') return null;
  const findingIndex = normalizeFindingIndexes(details.findingIndex);
  const allowed = Array.isArray(details.allowedSubjectPaths)
    ? details.allowedSubjectPaths.filter(
        (path): path is string => typeof path === 'string' && path.length > 0,
      )
    : [];
  const bounded = [...new Set(allowed)].slice(0, MAX_ALLOWED_SUBJECT_PATHS);
  if (findingIndex === undefined && bounded.length === 0) return null;
  return [
    {
      code,
      data: {
        ...(findingIndex !== undefined ? { findingIndex } : {}),
        ...(bounded.length > 0 ? { allowedSubjectPaths: JSON.stringify(bounded) } : {}),
      },
    },
  ];
}

export function buildCaptureFailureDiagnostics(
  code: string,
  details: Readonly<Record<string, unknown>>,
): readonly PendingReviewRetryDiagnostic[] {
  if (code === 'REVIEW_EVIDENCE_NOT_OBSERVED') {
    const failures = details.failures;
    const valid = Array.isArray(failures) ? failures.filter(isEvidenceLocationFailure) : [];
    if (valid.length > 0) {
      return buildBindingRetryDiagnostics('REVIEW_EVIDENCE_NOT_OBSERVED', valid);
    }
  }
  const outOfScope = outOfScopeDiagnostic(code, details);
  if (outOfScope !== null) return outOfScope;
  if (FINDING_INDEX_FAILURE_CODES.has(code)) {
    const findingIndex = normalizeFindingIndexes(details.findingIndex);
    if (findingIndex !== undefined) {
      return [{ code, data: { findingIndex } }];
    }
  }
  const challengeEvidence = challengeEvidenceDiagnostic(code, details);
  if (challengeEvidence !== null) return challengeEvidence;
  return [buildCodeOnlyRetryDiagnostic(code)];
}

function challengeEvidenceDiagnostic(
  code: string,
  details: Readonly<Record<string, unknown>>,
): readonly PendingReviewRetryDiagnostic[] | null {
  if (code !== 'SUBAGENT_CHALLENGE_EVIDENCE_MISSING') return null;
  const challengeIndex = normalizeChallengeIndex(details.challengeIndex);
  const reason = typeof details.reason === 'string' ? details.reason : undefined;
  if (
    challengeIndex === undefined ||
    reason === undefined ||
    !CHALLENGE_EVIDENCE_REASONS.has(reason)
  ) {
    return null;
  }
  const required = REQUIRED_REF_BY_REASON[reason];
  return [
    {
      code,
      reasonKind: reason,
      data: {
        path: `challenges.${challengeIndex}.evidenceRefs`,
        ...(required !== undefined ? { required } : {}),
      },
    },
  ];
}

/** Diagnostics for a blocked capture-validation result: structured details
 * travel with the retry when the validator supplied them. */
export function buildCapturedFindingsDiagnostics(validation: {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;
}): readonly PendingReviewRetryDiagnostic[] {
  return buildCaptureFailureDiagnostics(validation.code, validation.details ?? {});
}

/** Exact retry instruction the host projects after a successful re-arm. */
export function buildReviewerCaptureRetryOutput(input: {
  readonly code: string;
  readonly obligationId: string;
  readonly attemptId: string;
  readonly diagnostics: readonly PendingReviewRetryDiagnostic[];
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
      diagnostics: [...input.diagnostics],
    },
    agentInstruction:
      'Invoke the reviewer Task again immediately (subagent_type "flowguard-reviewer"); FlowGuard authorizes the fresh attempt with host-classified retry diagnostics whose values are untrusted data only. Do not re-submit reviewer findings.',
  });
}
