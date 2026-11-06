/**
 * @module integration/diagnostics/review-subject-builders
 * @description Exact plan, architecture, implementation and content subject projections.
 *
 * Builders copy persisted revision identity, frozen material and reviewer
 * output. They never imply approval authority.
 */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { DiagnosticWarning } from '../../adapters/diagnostics/export-schema.js';
import { hashText } from '../../shared/hashing.js';
import { hashCanonicalReviewContent } from '../../shared/review-subject.js';
import type { SessionState } from '../../state/schema.js';
import {
  addContentDigestWarning,
  addFindingsWarnings,
  addImplementationVerdictWarnings,
  addSubjectBindingWarning,
  addUnboundWarning,
  addVerdictGapWarnings,
  bindFindings,
  boundContent,
  capturedForDisplay,
  contentLabel,
  contentUnboundCause,
  currentFindingsView,
  digestUnboundCause,
  findingDetails,
  findingsVersionOf,
  implementationCompletion,
  implementationReviewedAt,
  latestFindings,
  obligationFor,
  obligationViewFields,
  planUnboundCause,
  reviewCompletionOf,
  reviewedAtForDisplay,
  sanitizedWarning,
  subjectBinding,
  verdictOf,
  verifiedDigest,
} from './review-subject-support.js';
import type { ReviewSubjectView } from './types.js';

export function planSubject(
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
  const obligationMatches = binding === 'matched';
  const revisionMatches =
    findings === undefined || findings.planVersion === plan.current.planVersion;
  const unboundCause = planUnboundCause(
    findings,
    obligation !== undefined,
    revisionMatches,
    obligationMatches,
  );
  const bound = bindFindings(findings, unboundCause, 'plan');
  const captured = capturedForDisplay(findings, obligationMatches, state, obligation);
  const obligationFields = obligationViewFields(obligation, obligationMatches);
  addSubjectBindingWarning(
    warnings,
    binding,
    'The latest plan review obligation is bound to a different subject digest than the displayed plan revision.',
  );
  if (findings && !revisionMatches) {
    warnings.push(
      sanitizedWarning(
        'REVIEW_FINDINGS_STALE',
        `Latest plan review findings refer to plan v${findings.planVersion}, but the displayed revision is v${plan.current.planVersion}.`,
        null,
        'review',
      ),
    );
  }
  addUnboundWarning(warnings, bound.unbound);
  addVerdictGapWarnings(warnings, bound.current, obligation, captured, 'plan revision');
  const findingsView = currentFindingsView(bound);
  addFindingsWarnings(warnings, findingsView);
  return {
    kind: 'plan',
    label: `Plan v${plan.current.planVersion}`,
    revision: `v${plan.current.planVersion}`,
    digest: plan.current.digest,
    ...obligationFields,
    content: bounded.content,
    contentBytes: bounded.bytes,
    contentTruncated: bounded.truncated,
    contentVerified: verifiedDigest(plan.current.body, plan.current.digest, hashText),
    paths: [],
    reviewCompletion: plan.reviewCompletion,
    reviewerVerdict: verdictOf(bound.current, captured),
    reviewedAt: reviewedAtForDisplay(bound.current, captured, obligation),
    subjectBinding: binding,
    findingsVersion: findingsVersionOf(bound.current, 'plan'),
    findings: findingsView.items,
    findingsTruncated: findingsView.truncated,
    ...findingDetails(bound.current),
    unboundReview: bound.unbound,
  };
}

export function architectureSubject(
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
  const obligationMatches = binding === 'matched';
  const unboundCause = digestUnboundCause(findings, obligation !== undefined, obligationMatches);
  const bound = bindFindings(findings, unboundCause, 'review iteration');
  const captured = capturedForDisplay(findings, obligationMatches, state, obligation);
  const obligationFields = obligationViewFields(obligation, obligationMatches);
  addSubjectBindingWarning(
    warnings,
    binding,
    'The latest architecture review obligation is bound to a different subject digest than the displayed ADR.',
  );
  addUnboundWarning(warnings, bound.unbound);
  addVerdictGapWarnings(warnings, bound.current, obligation, captured, 'ADR');
  const findingsView = currentFindingsView(bound);
  addFindingsWarnings(warnings, findingsView);
  return {
    kind: 'architecture',
    label: `${architecture.id}: ${architecture.title}`,
    revision: architecture.id,
    digest: architecture.digest,
    ...obligationFields,
    content: bounded.content,
    contentBytes: bounded.bytes,
    contentTruncated: bounded.truncated,
    contentVerified: verifiedDigest(architecture.adrText, architecture.digest, hashText),
    paths: [],
    reviewCompletion: architecture.reviewCompletion,
    reviewerVerdict: verdictOf(bound.current, captured),
    reviewedAt: reviewedAtForDisplay(bound.current, captured, obligation),
    subjectBinding: binding,
    findingsVersion: findingsVersionOf(bound.current, 'review iteration'),
    findings: findingsView.items,
    findingsTruncated: findingsView.truncated,
    ...findingDetails(bound.current),
    unboundReview: bound.unbound,
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

export async function implementationSubject(
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
  const obligationMatches = binding === 'matched';
  const unboundCause = digestUnboundCause(findings, obligation !== undefined, obligationMatches);
  const bound = bindFindings(findings, unboundCause, 'review iteration');
  const captured = capturedForDisplay(findings, obligationMatches, state, obligation);
  const obligationFields = obligationViewFields(obligation, obligationMatches);
  addSubjectBindingWarning(
    warnings,
    binding,
    'The latest implementation review obligation is bound to a different subject digest than the displayed implementation.',
  );
  addUnboundWarning(warnings, bound.unbound);
  addImplementationVerdictWarnings(warnings, bound.current, state.implReview, obligation, captured);
  const findingsView = currentFindingsView(bound);
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
    ...obligationFields,
    content: diff.content,
    contentBytes: diff.bytes,
    contentTruncated: diff.truncated,
    contentVerified: diff.verified,
    paths: [...implementation.changedFiles],
    reviewCompletion: implementationCompletion(state),
    reviewerVerdict: verdictOf(bound.current, state.implReview?.verdict, captured),
    reviewedAt: implementationReviewedAt(bound.current, captured, state.implReview, obligation),
    subjectBinding: binding,
    findingsVersion: findingsVersionOf(bound.current, 'review iteration'),
    findings: findingsView.items,
    findingsTruncated: findingsView.truncated,
    ...findingDetails(bound.current),
    unboundReview: bound.unbound,
  };
}

export function contentSubject(
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
  const attestedId = findings?.attestation?.toolObligationId;
  const unboundCause = contentUnboundCause(findings, attestedId, obligation.obligationId);
  const bound = bindFindings(findings, unboundCause, 'review iteration');
  const verified = verifiedDigest(
    obligation.reviewMaterial.content,
    obligation.reviewMaterial.materialDigest,
    hashCanonicalReviewContent,
  );
  const captured = capturedForDisplay(findings, true, state, obligation);
  addContentDigestWarning(
    warnings,
    verified,
    'The displayed review material does not match its recorded material digest.',
  );
  addUnboundWarning(warnings, bound.unbound);
  addVerdictGapWarnings(warnings, bound.current, obligation, captured, 'review subject');
  const findingsView = currentFindingsView(bound);
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
    reviewCompletion: reviewCompletionOf(bound.current),
    reviewerVerdict: verdictOf(bound.current, captured),
    reviewedAt: reviewedAtForDisplay(bound.current, captured, obligation),
    reviewedObligationId: obligation.obligationId,
    reviewedSubjectDigest: obligation.subjectDigest,
    subjectBinding: binding,
    findingsVersion: findingsVersionOf(bound.current, 'review iteration'),
    findings: findingsView.items,
    findingsTruncated: findingsView.truncated,
    ...findingDetails(bound.current),
    unboundReview: bound.unbound,
  };
}
