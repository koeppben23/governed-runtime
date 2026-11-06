/**
 * @module integration/diagnostics/review-subject
 * @description Exact review-subject projection for the diagnostic review view.
 *
 * The subject projection copies persisted revision identity, frozen material
 * and reviewer output. It never implies approval authority.
 */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { DiagnosticWarning } from '../../adapters/diagnostics/export-schema.js';
import { warning } from '../../adapters/diagnostics/types.js';
import { sanitizeDiagnosticString } from '../../logging/redact.js';
import { hashText } from '../../shared/hashing.js';
import { hashCanonicalReviewContent } from '../../shared/review-subject.js';
import type { SessionState } from '../../state/schema.js';
import type { ReviewFindings, ReviewObligation } from '../../state/evidence.js';
import type { ReviewFindingView, ReviewSubjectView } from './types.js';

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

function latestFindings(findings: readonly ReviewFindings[]): ReviewFindings | undefined {
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

function findingDetails(findings: ReviewFindings | undefined): {
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

function obligationFor(
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

function subjectBinding(
  obligation: ReviewObligation | undefined,
  subjectDigest: string,
): ReviewSubjectView['subjectBinding'] {
  if (!obligation) return 'not_verified';
  return obligation.subjectDigest === subjectDigest ? 'matched' : 'mismatch';
}

function addSubjectBindingWarning(
  warnings: DiagnosticWarning[],
  binding: ReviewSubjectView['subjectBinding'],
  message: string,
): void {
  if (binding !== 'mismatch') return;
  warnings.push(sanitizedWarning('REVIEW_SUBJECT_MISMATCH', message, null, 'review'));
}

function addVerdictGapWarnings(
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

function addFindingsWarnings(
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

function addContentDigestWarning(
  warnings: DiagnosticWarning[],
  verified: ReviewSubjectView['contentVerified'],
  message: string,
): void {
  if (verified !== 'mismatch') return;
  warnings.push(sanitizedWarning('REVIEW_CONTENT_DIGEST_MISMATCH', message, null, 'state'));
}

function addImplementationVerdictWarnings(
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

function verdictOf(
  findings: ReviewFindings | undefined,
  ...fallbacks: Array<string | null | undefined>
): string | null {
  return findings?.overallVerdict ?? firstDefined(...fallbacks);
}

function reviewedAtOf(
  findings: ReviewFindings | undefined,
  ...fallbacks: Array<string | null | undefined>
): string | null {
  return findings?.reviewedAt ?? firstDefined(...fallbacks);
}

function materialDigestOf(obligation: ReviewObligation | undefined): string | null {
  return obligation?.reviewMaterial.materialDigest ?? null;
}

function findingsVersionOf(findings: ReviewFindings | undefined, label: string): string | null {
  if (!findings) return null;
  return label === 'plan' ? `plan v${findings.planVersion}` : `${label} ${findings.iteration}`;
}

function contentLabel(obligation: ReviewObligation): string {
  if (obligation.reviewSubject?.kind === 'repository_change') return 'Repository change';
  if (obligation.reviewSubject?.kind === 'content') return 'Review content';
  return 'Review subject';
}

function implementationCompletion(state: SessionState): string | null {
  return state.implReview
    ? `iteration ${state.implReview.iteration}; ${state.implReview.verdict}`
    : null;
}

function reviewCompletionOf(findings: ReviewFindings | undefined): string | null {
  return findings ? 'review report recorded' : null;
}

function boundContent(
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

function verifiedDigest(
  content: string | null,
  expected: string | null,
  hash: (value: string) => string,
): ReviewSubjectView['contentVerified'] {
  if (content === null || expected === null) return 'not_available';
  return hash(content) === expected ? 'verified' : 'mismatch';
}

function planSubject(
  state: SessionState,
  warnings: DiagnosticWarning[],
  maxSubjectBytes: number,
): ReviewSubjectView | null {
  const plan = state.plan;
  if (!plan) return null;
  const findings = latestFindings(plan.reviewFindings);
  const obligation = obligationFor(
    findings,
    state.reviewAssurance?.obligations ?? [],
    'plan',
    plan.current.digest,
  );
  const bounded = boundContent(plan.current.body, maxSubjectBytes);
  const binding = subjectBinding(obligation, plan.current.digest);
  const captured = capturedVerdict(state, obligation);
  addSubjectBindingWarning(
    warnings,
    binding,
    'The latest plan review obligation is bound to a different subject digest than the displayed plan revision.',
  );
  if (findings && findings.planVersion !== plan.current.planVersion) {
    warnings.push(
      sanitizedWarning(
        'REVIEW_FINDINGS_STALE',
        `Latest plan review findings refer to plan v${findings.planVersion}, but the displayed revision is v${plan.current.planVersion}.`,
        null,
        'review',
      ),
    );
  }
  addVerdictGapWarnings(warnings, findings, obligation, captured, 'plan revision');
  const findingsView = findingsForFindings(findings);
  addFindingsWarnings(warnings, findingsView);
  return {
    kind: 'plan',
    label: `Plan v${plan.current.planVersion}`,
    revision: `v${plan.current.planVersion}`,
    digest: plan.current.digest,
    materialDigest: materialDigestOf(obligation),
    content: bounded.content,
    contentBytes: bounded.bytes,
    contentTruncated: bounded.truncated,
    contentVerified: verifiedDigest(plan.current.body, plan.current.digest, hashText),
    paths: [],
    reviewCompletion: plan.reviewCompletion,
    reviewerVerdict: verdictOf(findings, captured),
    reviewedAt: reviewedAtOf(findings, obligation?.fulfilledAt),
    reviewedObligationId: obligation?.obligationId ?? null,
    reviewedSubjectDigest: obligation?.subjectDigest ?? null,
    subjectBinding: binding,
    findingsVersion: findingsVersionOf(findings, 'plan'),
    findings: findingsView.items,
    findingsTruncated: findingsView.truncated,
    ...findingDetails(findings),
  };
}

function architectureSubject(
  state: SessionState,
  warnings: DiagnosticWarning[],
  maxSubjectBytes: number,
): ReviewSubjectView | null {
  const architecture = state.architecture;
  if (!architecture) return null;
  const findings = latestFindings(architecture.reviewFindings);
  const obligation = obligationFor(
    findings,
    state.reviewAssurance?.obligations ?? [],
    'architecture',
    architecture.digest,
  );
  const bounded = boundContent(architecture.adrText, maxSubjectBytes);
  const binding = subjectBinding(obligation, architecture.digest);
  const captured = capturedVerdict(state, obligation);
  addSubjectBindingWarning(
    warnings,
    binding,
    'The latest architecture review obligation is bound to a different subject digest than the displayed ADR.',
  );
  addVerdictGapWarnings(warnings, findings, obligation, captured, 'ADR');
  const findingsView = findingsForFindings(findings);
  addFindingsWarnings(warnings, findingsView);
  return {
    kind: 'architecture',
    label: `${architecture.id}: ${architecture.title}`,
    revision: architecture.id,
    digest: architecture.digest,
    materialDigest: materialDigestOf(obligation),
    content: bounded.content,
    contentBytes: bounded.bytes,
    contentTruncated: bounded.truncated,
    contentVerified: verifiedDigest(architecture.adrText, architecture.digest, hashText),
    paths: [],
    reviewCompletion: architecture.reviewCompletion,
    reviewerVerdict: verdictOf(findings, captured),
    reviewedAt: reviewedAtOf(findings, obligation?.fulfilledAt),
    reviewedObligationId: obligation?.obligationId ?? null,
    reviewedSubjectDigest: obligation?.subjectDigest ?? null,
    subjectBinding: binding,
    findingsVersion: findingsVersionOf(findings, 'review iteration'),
    findings: findingsView.items,
    findingsTruncated: findingsView.truncated,
    ...findingDetails(findings),
  };
}

async function readImplementationDiff(
  sessDir: string,
  state: SessionState,
  warnings: DiagnosticWarning[],
  maxSubjectBytes: number,
): Promise<{
  content: string | null;
  bytes: number;
  truncated: boolean;
  verified: ReviewSubjectView['contentVerified'];
}> {
  const implementation = state.implementation;
  if (!implementation) {
    return { content: null, bytes: 0, truncated: false, verified: 'not_available' };
  }
  if (implementation.diffDigest === undefined) {
    warnings.push(
      sanitizedWarning(
        'IMPLEMENTATION_DIFF_NOT_RECORDED',
        'No content-addressed implementation diff artifact is recorded for this revision.',
        null,
        'state',
      ),
    );
    return { content: null, bytes: 0, truncated: false, verified: 'not_available' };
  }
  const diffPath = path.join(sessDir, `implementation-diff.${implementation.diffDigest}.patch`);
  try {
    const info = await stat(diffPath);
    if (info.size > maxSubjectBytes) {
      warnings.push(
        sanitizedWarning(
          'IMPLEMENTATION_DIFF_TOO_LARGE',
          `The implementation diff exceeds the ${maxSubjectBytes}-byte view limit and was not read.`,
          null,
          'state',
        ),
      );
      return { content: null, bytes: info.size, truncated: true, verified: 'not_available' };
    }
    const raw = await readFile(diffPath, 'utf8');
    const bounded = boundContent(raw, maxSubjectBytes);
    return {
      content: bounded.content,
      bytes: bounded.bytes,
      truncated: bounded.truncated,
      verified: verifiedDigest(raw, implementation.diffDigest, hashText),
    };
  } catch {
    warnings.push(
      sanitizedWarning(
        'IMPLEMENTATION_DIFF_UNAVAILABLE',
        'The recorded implementation diff artifact could not be read.',
        null,
        'state',
      ),
    );
    return { content: null, bytes: 0, truncated: false, verified: 'not_available' };
  }
}

async function implementationSubject(
  sessDir: string,
  state: SessionState,
  warnings: DiagnosticWarning[],
  maxSubjectBytes: number,
): Promise<ReviewSubjectView | null> {
  const implementation = state.implementation;
  if (!implementation) return null;
  const findings = latestFindings(state.implReviewFindings);
  const obligation = obligationFor(
    findings,
    state.reviewAssurance?.obligations ?? [],
    'implement',
    implementation.digest,
  );
  const diff = await readImplementationDiff(sessDir, state, warnings, maxSubjectBytes);
  const binding = subjectBinding(obligation, implementation.digest);
  const captured = capturedVerdict(state, obligation);
  addSubjectBindingWarning(
    warnings,
    binding,
    'The latest implementation review obligation is bound to a different subject digest than the displayed implementation.',
  );
  addImplementationVerdictWarnings(warnings, findings, state.implReview, obligation, captured);
  const findingsView = findingsForFindings(findings);
  addFindingsWarnings(warnings, findingsView);
  addContentDigestWarning(
    warnings,
    diff.verified,
    'The displayed implementation diff does not match its recorded content digest.',
  );
  return {
    kind: 'implementation',
    label: `Implementation ${implementation.implementationId}`,
    revision: implementation.implementationId,
    digest: implementation.digest,
    materialDigest: materialDigestOf(obligation),
    content: diff.content,
    contentBytes: diff.bytes,
    contentTruncated: diff.truncated,
    contentVerified: diff.verified,
    paths: [...implementation.changedFiles],
    reviewCompletion: implementationCompletion(state),
    reviewerVerdict: verdictOf(findings, state.implReview?.verdict, captured),
    reviewedAt: reviewedAtOf(findings, state.implReview?.executedAt, obligation?.fulfilledAt),
    reviewedObligationId: obligation?.obligationId ?? null,
    reviewedSubjectDigest: obligation?.subjectDigest ?? null,
    subjectBinding: binding,
    findingsVersion: findingsVersionOf(findings, 'review iteration'),
    findings: findingsView.items,
    findingsTruncated: findingsView.truncated,
    ...findingDetails(findings),
  };
}

function contentSubject(
  state: SessionState,
  warnings: DiagnosticWarning[],
  maxSubjectBytes: number,
): ReviewSubjectView | null {
  const obligations = (state.reviewAssurance?.obligations ?? []).filter(
    (item) => item.obligationType === 'review',
  );
  const obligation = obligations.at(-1);
  if (!obligation) return null;
  const findings = latestFindings(state.peerReviewFindings);
  const bounded = boundContent(obligation.reviewMaterial.content, maxSubjectBytes);
  const digest = obligation.reviewSubject?.subjectDigest ?? obligation.subjectDigest;
  const binding = subjectBinding(obligation, digest);
  const verified = verifiedDigest(
    obligation.reviewMaterial.content,
    obligation.reviewMaterial.materialDigest,
    hashCanonicalReviewContent,
  );
  const captured = capturedVerdict(state, obligation);
  addContentDigestWarning(
    warnings,
    verified,
    'The displayed review material does not match its recorded material digest.',
  );
  addVerdictGapWarnings(warnings, findings, obligation, captured, 'review subject');
  const findingsView = findingsForFindings(findings);
  addFindingsWarnings(warnings, findingsView);
  return {
    kind: 'content',
    label: contentLabel(obligation),
    revision: obligation.obligationId,
    digest,
    materialDigest: obligation.reviewMaterial.materialDigest,
    content: bounded.content,
    contentBytes: bounded.bytes,
    contentTruncated: bounded.truncated,
    contentVerified: verified,
    paths: [],
    reviewCompletion: reviewCompletionOf(findings),
    reviewerVerdict: verdictOf(findings, captured),
    reviewedAt: reviewedAtOf(findings, obligation.fulfilledAt),
    reviewedObligationId: obligation.obligationId,
    reviewedSubjectDigest: obligation.subjectDigest,
    subjectBinding: binding,
    findingsVersion: findingsVersionOf(findings, 'review iteration'),
    findings: findingsView.items,
    findingsTruncated: findingsView.truncated,
    ...findingDetails(findings),
  };
}

function implementationPhases(phase: SessionState['phase']): boolean {
  return (
    phase === 'IMPLEMENTATION' ||
    phase === 'IMPL_VALIDATION' ||
    phase === 'IMPL_REVIEW' ||
    phase === 'EVIDENCE_REVIEW' ||
    phase === 'EXPORT_READY' ||
    phase === 'COMPLETE'
  );
}

function reviewPhases(phase: SessionState['phase']): boolean {
  return phase === 'PEER_REVIEW' || phase === 'PEER_REVIEW_COMPLETE';
}

function architecturePhases(phase: SessionState['phase']): boolean {
  return phase === 'ARCHITECTURE' || phase === 'ARCH_REVIEW' || phase === 'ARCH_COMPLETE';
}

function planPhases(phase: SessionState['phase']): boolean {
  return (
    phase === 'TICKET' || phase === 'PLAN' || phase === 'PLAN_REVIEW' || phase === 'VALIDATION'
  );
}

async function phaseSubject(
  state: SessionState,
  sessDir: string,
  warnings: DiagnosticWarning[],
  maxSubjectBytes: number,
): Promise<ReviewSubjectView | null> {
  if (reviewPhases(state.phase)) return contentSubject(state, warnings, maxSubjectBytes);
  if (architecturePhases(state.phase)) {
    return architectureSubject(state, warnings, maxSubjectBytes);
  }
  if (implementationPhases(state.phase)) {
    return implementationSubject(sessDir, state, warnings, maxSubjectBytes);
  }
  if (planPhases(state.phase)) return planSubject(state, warnings, maxSubjectBytes);
  return null;
}

async function fallbackSubject(
  state: SessionState,
  sessDir: string,
  warnings: DiagnosticWarning[],
  maxSubjectBytes: number,
): Promise<ReviewSubjectView | null> {
  return (
    (await implementationSubject(sessDir, state, warnings, maxSubjectBytes)) ??
    planSubject(state, warnings, maxSubjectBytes) ??
    architectureSubject(state, warnings, maxSubjectBytes) ??
    contentSubject(state, warnings, maxSubjectBytes)
  );
}

export async function selectSubject(
  state: SessionState,
  sessDir: string,
  warnings: DiagnosticWarning[],
  maxSubjectBytes: number,
): Promise<ReviewSubjectView | null> {
  return (
    (await phaseSubject(state, sessDir, warnings, maxSubjectBytes)) ??
    fallbackSubject(state, sessDir, warnings, maxSubjectBytes)
  );
}

export function unavailableSubject(): ReviewSubjectView {
  return {
    kind: 'unavailable',
    label: 'No reviewable subject recorded',
    revision: null,
    digest: null,
    materialDigest: null,
    content: null,
    contentBytes: 0,
    contentTruncated: false,
    contentVerified: 'not_applicable',
    paths: [],
    reviewCompletion: null,
    reviewerVerdict: null,
    reviewedAt: null,
    reviewedObligationId: null,
    reviewedSubjectDigest: null,
    subjectBinding: 'not_applicable',
    findingsVersion: null,
    findings: [],
    findingsTruncated: false,
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
  };
}
