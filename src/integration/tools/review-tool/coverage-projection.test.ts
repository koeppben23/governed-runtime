/**
 * @module integration/tools/review-tool/coverage-projection.test
 * @description Unit coverage for buildPeerReviewCoverage — the canonical
 *              target-coverage projection persisted with a peer review report.
 */
import { describe, it, expect } from 'vitest';
import { buildPeerReviewCoverage } from './completion.js';
import { buildReviewReport } from '../../../rails/review.js';
import { assuranceWith, makeProgressedState, makeState } from '../../../fixtures.js';
import {
  buildInvocationEvidence,
  createReviewObligation,
  freezeReviewMaterial,
} from '../../review/assurance.js';
import {
  PEER_REVIEW_EVIDENCE_SCHEMA_VERSION,
  PeerReviewCoverage,
  createPeerReviewTask,
  type PeerReviewPreparedEvidence,
} from '../../../state/peer-review.js';
import type { SessionState } from '../../../state/schema.js';
import type { FrozenReviewSubject, ReviewReportFinding } from '../../../state/evidence.js';

const NOW = '2026-01-15T10:00:00.000Z';
const REVIEW_TASK_ID = '00000000-0000-4000-8000-00000000000b';
const ATTEMPT_ID = '00000000-0000-4000-8000-00000000000c';

const contentSubject: FrozenReviewSubject = {
  kind: 'content',
  source: { kind: 'inline', mediaType: 'text' },
  materialDigest: 'b'.repeat(64),
  subjectDigest: 'a'.repeat(64),
  lineCount: 1,
};

const repositorySubject: FrozenReviewSubject = {
  kind: 'repository_change',
  source: { kind: 'pull_request', pullRequestNumber: 7 },
  baseRepository: { host: 'github.com', owner: 'flowguard', name: 'governed-runtime' },
  headRepository: { host: 'github.com', owner: 'flowguard', name: 'governed-runtime' },
  baseSha: 'b'.repeat(40),
  headSha: 'a'.repeat(40),
  changedPaths: ['src/a.ts', 'src/b.ts'],
  materialDigest: 'c'.repeat(64),
  subjectDigest: 'd'.repeat(64),
};

function reviewObligation() {
  return createReviewObligation({
    policySnapshot: {
      challengePolicy: {
        version: 'challenge-policy.v1',
        counts: { TRIVIAL: 0, STANDARD: 1, 'HIGH-RISK': 2 },
      },
      maxReviewerAttempts: 1,
    },
    obligationType: 'review',
    reviewCycle: null,
    iteration: 1,
    planVersion: 1,
    now: NOW,
    subjectDigest: 'a'.repeat(64),
    reviewMaterial: freezeReviewMaterial('frozen review material', 'a'.repeat(64)),
    reviewSubject: contentSubject,
  });
}

function preparedEntry(obligationId: string, objectiveCount?: number): PeerReviewPreparedEvidence {
  const { task, requestedDigests } = createPeerReviewTask({
    subjectDigest: 'a'.repeat(64),
    ...(objectiveCount
      ? {
          objectives: Array.from({ length: objectiveCount }, (_, index) => ({
            objectiveId: `objective-${index + 1}`,
            statement: `Objective ${index + 1}`,
          })),
        }
      : {}),
  });
  return {
    kind: 'prepared',
    schemaVersion: PEER_REVIEW_EVIDENCE_SCHEMA_VERSION,
    evidenceId: '00000000-0000-4000-8000-000000000001',
    reviewTaskId: REVIEW_TASK_ID,
    obligationId,
    preparedAt: NOW,
    task,
    requestedDigests,
  };
}

function boundInvocation(obligationId: string) {
  return buildInvocationEvidence({
    obligationId,
    obligationType: 'review',
    mandateDigest: 'mandate-digest',
    criteriaVersion: 'criteria-v1',
    parentSessionId: 'parent-session',
    childSessionId: 'child-session',
    promptHash: 'a'.repeat(64),
    findingsHash: 'b'.repeat(64),
    invokedAt: NOW,
    fulfilledAt: NOW,
    capturedRawFindings: { overallVerdict: 'accept' },
    attemptId: ATTEMPT_ID,
  });
}

function reportFor(
  state: SessionState,
  subject: FrozenReviewSubject | undefined,
  findings: ReviewReportFinding[] = [],
) {
  return buildReviewReport({
    state,
    now: NOW,
    validationSummary: [],
    findings,
    ...(subject && { reviewSubject: subject }),
  });
}

describe('buildPeerReviewCoverage', () => {
  it('counts all objectives as covered only when a bound host-observed invocation exists', () => {
    const obligation = reviewObligation();
    const withEvidence = makeState('PEER_REVIEW_COMPLETE', {
      peerReviewEvidence: [preparedEntry(obligation.obligationId)],
      reviewAssurance: assuranceWith({ obligation }),
    });
    const withoutInvocation = buildPeerReviewCoverage({
      report: reportFor(withEvidence, contentSubject),
      state: withEvidence,
      obligation,
    });
    expect(withoutInvocation.objectivesTotal).toBe(3);
    expect(withoutInvocation.objectivesCovered).toBe(0);
    expect(withoutInvocation.reviewAssurance).toBeNull();

    const withInvocation = makeState('PEER_REVIEW_COMPLETE', {
      peerReviewEvidence: [preparedEntry(obligation.obligationId)],
      reviewAssurance: assuranceWith({
        obligation,
        invocations: [boundInvocation(obligation.obligationId)],
      }),
    });
    const covered = buildPeerReviewCoverage({
      report: reportFor(withInvocation, contentSubject),
      state: withInvocation,
      obligation,
    });
    expect(covered.objectivesTotal).toBe(3);
    expect(covered.objectivesCovered).toBe(3);
    expect(covered.reviewAssurance).toBe('structured_high');
  });

  it('uses the authoritative objective count from the prepared peer-review task', () => {
    const obligation = reviewObligation();
    const state = makeState('PEER_REVIEW_COMPLETE', {
      peerReviewEvidence: [preparedEntry(obligation.obligationId, 2)],
      reviewAssurance: assuranceWith({
        obligation,
        invocations: [boundInvocation(obligation.obligationId)],
      }),
    });
    const coverage = buildPeerReviewCoverage({
      report: reportFor(state, contentSubject),
      state,
      obligation,
    });
    expect(coverage.objectivesTotal).toBe(2);
    expect(coverage.objectivesCovered).toBe(2);
  });

  it('derives repository target coverage from the frozen subject', () => {
    const state = makeState('PEER_REVIEW_COMPLETE');
    const coverage = buildPeerReviewCoverage({
      report: reportFor(state, repositorySubject),
      state,
      obligation: null,
    });
    expect(coverage).toEqual({
      targetResolved: true,
      targetFrozen: true,
      repositoryIdentityVerified: true,
      baseSha: 'b'.repeat(40),
      headSha: 'a'.repeat(40),
      changedPathCount: 2,
      objectivesCovered: 0,
      objectivesTotal: 0,
      reviewAssurance: null,
      missingVerification: [],
    });
  });

  it('marks a content target frozen without repository identity', () => {
    const state = makeState('PEER_REVIEW_COMPLETE');
    const coverage = buildPeerReviewCoverage({
      report: reportFor(state, contentSubject),
      state,
      obligation: null,
    });
    expect(coverage.targetResolved).toBe(true);
    expect(coverage.targetFrozen).toBe(true);
    expect(coverage.repositoryIdentityVerified).toBeNull();
    expect(coverage.baseSha).toBeNull();
    expect(coverage.headSha).toBeNull();
    expect(coverage.changedPathCount).toBe(0);
  });

  it('resolves a lifecycle target only from report plan/implementation digests', () => {
    const unresolvedState = makeState('PEER_REVIEW_COMPLETE');
    const unresolved = buildPeerReviewCoverage({
      report: reportFor(unresolvedState, undefined),
      state: unresolvedState,
      obligation: null,
    });
    expect(unresolved.targetResolved).toBe(false);
    expect(unresolved.targetFrozen).toBe(false);

    const progressed = makeProgressedState('COMPLETE');
    const resolved = buildPeerReviewCoverage({
      report: reportFor(progressed, undefined),
      state: progressed,
      obligation: null,
    });
    expect(resolved.targetResolved).toBe(true);
    expect(resolved.targetFrozen).toBe(false);
  });

  it('extracts only missing-verification finding messages', () => {
    const findings: ReviewReportFinding[] = [
      {
        source: 'missing_verification',
        reportSeverity: 'warning',
        category: 'missing-verification',
        message: 'Run the integration suite',
      },
      {
        source: 'mechanical',
        reportSeverity: 'warning',
        category: 'completeness',
        message: 'Not a missing-verification finding',
      },
      {
        source: 'unknown',
        reportSeverity: 'info',
        category: 'unknown',
        message: 'Unclear',
      },
    ];
    const state = makeState('PEER_REVIEW_COMPLETE');
    const coverage = buildPeerReviewCoverage({
      report: reportFor(state, contentSubject, findings),
      state,
      obligation: null,
    });
    expect(coverage.missingVerification).toEqual(['Run the integration suite']);
  });

  it('never carries local-session completeness or four-eyes fields', () => {
    const state = makeState('PEER_REVIEW_COMPLETE');
    const coverage = buildPeerReviewCoverage({
      report: reportFor(state, contentSubject),
      state,
      obligation: null,
    });
    expect(coverage).not.toHaveProperty('overallComplete');
    expect(coverage).not.toHaveProperty('fourEyes');
    expect(coverage).not.toHaveProperty('slots');
    expect(coverage).not.toHaveProperty('summary');
    expect(coverage).not.toHaveProperty('phase');
    expect(coverage).not.toHaveProperty('policyMode');
    expect(coverage).not.toHaveProperty('sessionId');
    expect(
      PeerReviewCoverage.safeParse({ ...coverage, fourEyes: { satisfied: true } }).success,
    ).toBe(false);
  });

  it('treats an obligation without an authoritative task as zero objectives', () => {
    const obligation = reviewObligation();
    const state = makeState('PEER_REVIEW_COMPLETE', {
      peerReviewEvidence: [],
      reviewAssurance: assuranceWith({
        obligation,
        invocations: [boundInvocation(obligation.obligationId)],
      }),
    });
    const coverage = buildPeerReviewCoverage({
      report: reportFor(state, contentSubject),
      state,
      obligation,
    });
    expect(coverage.objectivesTotal).toBe(0);
    expect(coverage.objectivesCovered).toBe(0);
    expect(coverage.reviewAssurance).toBe('structured_high');
  });
});
