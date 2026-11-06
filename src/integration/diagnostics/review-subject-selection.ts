/**
 * @module integration/diagnostics/review-subject-selection
 * @description Flow-phase selection of the displayed review subject.
 */

import type { DiagnosticWarning } from '../../adapters/diagnostics/export-schema.js';
import type { SessionState } from '../../state/schema.js';
import {
  architectureSubject,
  contentSubject,
  implementationSubject,
  planSubject,
} from './review-subject.js';
import type { ReviewSubjectView } from './types.js';

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
    unboundReview: null,
    historicalImplReview: null,
  };
}
