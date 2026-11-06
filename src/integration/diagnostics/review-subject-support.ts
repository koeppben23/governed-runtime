/**
 * @module integration/diagnostics/review-subject-support
 * @description Shared binding, warning and content helpers for review subjects.
 */

import type { DiagnosticWarning } from '../../adapters/diagnostics/export-schema.js';
import { warning } from '../../adapters/diagnostics/types.js';
import { sanitizeDiagnosticString } from '../../logging/redact.js';
import type { SessionState } from '../../state/schema.js';
import type { ReviewFindings, ReviewObligation } from '../../state/evidence.js';
import type {
  HistoricalImplReviewView,
  ReviewFindingView,
  ReviewSubjectView,
  UnboundReviewView,
} from './types.js';

export const DEFAULT_MAX_SUBJECT_BYTES = 32 * 1024;
const MAX_FINDINGS = 100;

export function sanitizedWarning(
  code: string,
  message: string,
  sessionId: string | null,
  source: DiagnosticWarning['source'],
): DiagnosticWarning {
  return warning(code, sanitizeDiagnosticString(message), sessionId, source);
}

export function latestFindings(findings: readonly ReviewFindings[]): ReviewFindings | undefined {
  return findings.at(-1);
}

function findingsForFindings(findings: ReviewFindings | undefined): {
  items: readonly ReviewFindingView[];
  truncated: boolean;
} {
  const source = findings
    ? [...findings.blockingIssues, ...findings.majorRisks].map((item) => ({
        severity: item.severity,
        category: item.category,
        message: item.message,
        findingId: item.findingId ?? null,
      }))
    : [];
  return {
    items: source.slice(0, MAX_FINDINGS),
    truncated: source.length > MAX_FINDINGS,
  };
}

export function findingDetails(findings: ReviewFindings | undefined): {
  missingVerification: readonly string[];
  scopeCreep: readonly string[];
  unknowns: readonly string[];
} {
  return {
    missingVerification: findings?.missingVerification ?? [],
    scopeCreep: findings?.scopeCreep ?? [],
    unknowns: findings?.unknowns ?? [],
  };
}

export function obligationFor(
  findings: ReviewFindings | undefined,
  obligations: readonly ReviewObligation[],
  obligationType: ReviewObligation['obligationType'],
  subjectDigest: string,
): ReviewObligation | undefined {
  const attestedId = findings?.attestation?.toolObligationId;
  if (attestedId !== undefined) {
    const attested = obligations.find((item) => item.obligationId === attestedId);
    if (attested) return attested;
  }
  const exact = obligations
    .filter(
      (item) => item.obligationType === obligationType && item.subjectDigest === subjectDigest,
    )
    .at(-1);
  if (exact) return exact;
  return obligations.filter((item) => item.obligationType === obligationType).at(-1);
}

function capturedVerdict(
  state: SessionState,
  obligation: ReviewObligation | undefined,
): string | null {
  if (!obligation) return null;
  return (
    state.reviewAssurance?.invocations
      .filter((item) => item.obligationId === obligation.obligationId)
      .at(-1)?.capturedVerdict ?? null
  );
}

export function subjectBinding(
  obligation: ReviewObligation | undefined,
  subjectDigest: string,
): ReviewSubjectView['subjectBinding'] {
  if (!obligation) return 'not_verified';
  return obligation.subjectDigest === subjectDigest ? 'matched' : 'mismatch';
}

export function addSubjectBindingWarning(
  warnings: DiagnosticWarning[],
  binding: ReviewSubjectView['subjectBinding'],
  message: string,
): void {
  if (binding !== 'mismatch') return;
  warnings.push(sanitizedWarning('REVIEW_SUBJECT_MISMATCH', message, null, 'review'));
}

export function addVerdictGapWarnings(
  warnings: DiagnosticWarning[],
  findings: ReviewFindings | undefined,
  obligation: ReviewObligation | undefined,
  captured: string | null,
  subjectLabel: string,
): void {
  if (!findings && captured === null) {
    warnings.push(
      sanitizedWarning(
        'REVIEW_VERDICT_NOT_RECORDED',
        `No reviewer verdict or findings are recorded for the displayed ${subjectLabel}.`,
        null,
        'review',
      ),
    );
  }
  if (obligation === undefined) {
    warnings.push(
      sanitizedWarning(
        'REVIEW_OBLIGATION_NOT_VERIFIED',
        `No exact review obligation is recorded for the displayed ${subjectLabel}.`,
        null,
        'review',
      ),
    );
  }
}

export function addFindingsWarnings(
  warnings: DiagnosticWarning[],
  findingsView: { readonly truncated: boolean },
): void {
  if (!findingsView.truncated) return;
  warnings.push(
    sanitizedWarning(
      'REVIEW_FINDINGS_TRUNCATED',
      `Only the first ${MAX_FINDINGS} findings are shown.`,
      null,
      'review',
    ),
  );
}

export function addContentDigestWarning(
  warnings: DiagnosticWarning[],
  verified: ReviewSubjectView['contentVerified'],
  message: string,
): void {
  if (verified !== 'mismatch') return;
  warnings.push(sanitizedWarning('REVIEW_CONTENT_DIGEST_MISMATCH', message, null, 'state'));
}

export function addImplementationVerdictWarnings(
  warnings: DiagnosticWarning[],
  findings: ReviewFindings | undefined,
  implReview: SessionState['implReview'],
  obligation: ReviewObligation | undefined,
  captured: string | null,
): void {
  if (!findings && implReview === null && captured === null) {
    warnings.push(
      sanitizedWarning(
        'REVIEW_VERDICT_NOT_RECORDED',
        'No reviewer verdict or findings are recorded for the displayed implementation.',
        null,
        'review',
      ),
    );
  }
  if (obligation === undefined) {
    warnings.push(
      sanitizedWarning(
        'REVIEW_OBLIGATION_NOT_VERIFIED',
        'No exact review obligation is recorded for the displayed implementation.',
        null,
        'review',
      ),
    );
  }
}

function firstDefined(...values: Array<string | null | undefined>): string | null {
  return values.find((value): value is string => typeof value === 'string') ?? null;
}

export function planUnboundCause(
  findings: ReviewFindings | undefined,
  hasObligation: boolean,
  revisionMatches: boolean,
  obligationMatches: boolean,
): UnboundReviewView['reason'] | null {
  if (findings === undefined) return null;
  if (!hasObligation) return 'subject_not_verified';
  if (!revisionMatches) return 'stale_revision';
  return obligationMatches ? null : 'subject_mismatch';
}

export function digestUnboundCause(
  findings: ReviewFindings | undefined,
  hasObligation: boolean,
  obligationMatches: boolean,
): UnboundReviewView['reason'] | null {
  if (findings === undefined) return null;
  if (!hasObligation) return 'subject_not_verified';
  return obligationMatches ? null : 'subject_mismatch';
}

export function contentUnboundCause(
  findings: ReviewFindings | undefined,
  attestedId: string | undefined,
  obligationId: string,
): UnboundReviewView['reason'] | null {
  if (findings === undefined) return null;
  if (attestedId === undefined) return 'subject_not_verified';
  return attestedId === obligationId ? null : 'subject_mismatch';
}

export function obligationViewFields(
  obligation: ReviewObligation | undefined,
  matches: boolean,
): Pick<ReviewSubjectView, 'materialDigest' | 'reviewedObligationId' | 'reviewedSubjectDigest'> {
  return {
    materialDigest: matches ? materialDigestOf(obligation) : null,
    reviewedObligationId: matches ? (obligation?.obligationId ?? null) : null,
    reviewedSubjectDigest: matches ? (obligation?.subjectDigest ?? null) : null,
  };
}

export function verdictOf(
  findings: ReviewFindings | undefined,
  ...fallbacks: Array<string | null | undefined>
): string | null {
  return findings?.overallVerdict ?? firstDefined(...fallbacks);
}

function materialDigestOf(obligation: ReviewObligation | undefined): string | null {
  return obligation?.reviewMaterial.materialDigest ?? null;
}

export function findingsVersionOf(
  findings: ReviewFindings | undefined,
  label: string,
): string | null {
  if (!findings) return null;
  return label === 'plan' ? `plan v${findings.planVersion}` : `${label} ${findings.iteration}`;
}

export function contentLabel(obligation: ReviewObligation): string {
  if (obligation.reviewSubject?.kind === 'repository_change') return 'Repository change';
  if (obligation.reviewSubject?.kind === 'content') return 'Review content';
  return 'Review subject';
}

export interface FindingsBinding {
  readonly current: ReviewFindings | undefined;
  readonly unbound: UnboundReviewView | null;
}

/**
 * Bind reviewer output to the displayed subject. Only exact revision-bound
 * findings become the current verdict; everything else is retained separately
 * as historical/unassigned output.
 *
 * `unboundCause` is null only when the output is positively bound to the
 * displayed revision.
 */
export function bindFindings(
  findings: ReviewFindings | undefined,
  unboundCause: UnboundReviewView['reason'] | null,
  versionLabel: string,
): FindingsBinding {
  if (!findings) return { current: undefined, unbound: null };
  if (unboundCause === null) return { current: findings, unbound: null };
  const view = findingsForFindings(findings);
  return {
    current: undefined,
    unbound: {
      verdict: findings.overallVerdict,
      reviewedAt: findings.reviewedAt,
      findingsVersion: findingsVersionOf(findings, versionLabel),
      findings: view.items,
      findingsTruncated: view.truncated,
      ...findingDetails(findings),
      reason: unboundCause,
    },
  };
}

export function addUnboundWarning(
  warnings: DiagnosticWarning[],
  unbound: UnboundReviewView | null,
): void {
  if (!unbound) return;
  warnings.push(
    sanitizedWarning(
      'REVIEW_FINDINGS_UNBOUND',
      `Reviewer output is not bound to the displayed revision (${unbound.reason}) and is shown only as historical/unassigned output.`,
      null,
      'review',
    ),
  );
  if (unbound.findingsTruncated) {
    warnings.push(
      sanitizedWarning(
        'REVIEW_FINDINGS_TRUNCATED',
        `Only the first ${MAX_FINDINGS} historical/unassigned findings are shown.`,
        null,
        'review',
      ),
    );
  }
}

export function currentFindingsView(bound: FindingsBinding): {
  readonly items: readonly ReviewFindingView[];
  readonly truncated: boolean;
} {
  return bound.current ? findingsForFindings(bound.current) : { items: [], truncated: false };
}

export function capturedForDisplay(
  findings: ReviewFindings | undefined,
  obligationMatches: boolean,
  state: SessionState,
  obligation: ReviewObligation | undefined,
): string | null {
  if (findings !== undefined || !obligationMatches) return null;
  return capturedVerdict(state, obligation);
}

export function reviewedAtForDisplay(
  current: ReviewFindings | undefined,
  captured: string | null,
  obligation: ReviewObligation | undefined,
): string | null {
  if (current) return current.reviewedAt;
  if (captured !== null) return obligation?.fulfilledAt ?? null;
  return null;
}

export function implementationReviewedAt(
  current: ReviewFindings | undefined,
  captured: string | null,
  implReview: SessionState['implReview'],
  obligation: ReviewObligation | undefined,
): string | null {
  if (current) return current.reviewedAt;
  if (implReview !== null) return implReview.executedAt;
  if (captured !== null) return obligation?.fulfilledAt ?? null;
  return null;
}

export function implementationCompletion(implReview: SessionState['implReview']): string | null {
  return implReview ? `iteration ${implReview.iteration}; ${implReview.verdict}` : null;
}

export interface ImplReviewBinding {
  readonly current: SessionState['implReview'];
  readonly historical: HistoricalImplReviewView | null;
}

/** Bind the implementation-review loop to the displayed implementation digest. */
export function bindImplReview(
  implReview: SessionState['implReview'],
  implementationDigest: string,
): ImplReviewBinding {
  if (implReview === null) return { current: null, historical: null };
  if (implReview.currDigest === implementationDigest) {
    return { current: implReview, historical: null };
  }
  return {
    current: null,
    historical: {
      verdict: implReview.verdict,
      executedAt: implReview.executedAt,
      iteration: implReview.iteration,
      currDigest: implReview.currDigest,
      expectedDigest: implementationDigest,
      reason: 'digest_mismatch',
    },
  };
}

export function addHistoricalImplReviewWarning(
  warnings: DiagnosticWarning[],
  historical: HistoricalImplReviewView | null,
): void {
  if (historical === null) return;
  warnings.push(
    sanitizedWarning(
      'REVIEW_IMPL_LOOP_STALE',
      `The implementation-review loop is bound to digest ${historical.currDigest}, not the displayed implementation digest ${historical.expectedDigest}; it is shown only as historical output.`,
      null,
      'review',
    ),
  );
}

export function reviewCompletionOf(findings: ReviewFindings | undefined): string | null {
  return findings ? 'review report recorded' : null;
}

export function boundContent(
  content: string,
  maxBytes: number,
): { content: string; bytes: number; truncated: boolean } {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes <= maxBytes) return { content, bytes, truncated: false };
  return {
    content: Buffer.from(content, 'utf8').subarray(0, maxBytes).toString('utf8'),
    bytes,
    truncated: true,
  };
}

export function verifiedDigest(
  content: string | null,
  expected: string | null,
  hash: (value: string) => string,
): ReviewSubjectView['contentVerified'] {
  if (content === null || expected === null) return 'not_available';
  return hash(content) === expected ? 'verified' : 'mismatch';
}
