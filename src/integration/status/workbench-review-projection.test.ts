import { describe, expect, it } from 'vitest';

import { unavailableSubject } from '../diagnostics/review-subject-selection.js';
import type { ReviewView } from '../diagnostics/types.js';
import { projectWorkbenchReview } from './workbench-review-projection.js';

function view(): ReviewView {
  return {
    schemaVersion: 'diagnostic-view.v1',
    kind: 'review',
    rootSessionId: 'ses_root',
    generatedAt: '2026-11-07T00:00:00.000Z',
    status: 'COMPLETE',
    phase: 'PLAN_REVIEW',
    subject: {
      ...unavailableSubject(),
      kind: 'plan',
      label: 'Frozen plan revision',
      revision: '3',
      digest: 'a'.repeat(64),
      content: 'PRIVATE implementation details',
      paths: ['/private/worktree/internal.md'],
      contentVerified: 'verified',
      subjectBinding: 'matched',
      reviewerVerdict: 'ACCEPT',
      reviewedSubjectDigest: 'a'.repeat(64),
      findings: [
        {
          severity: 'critical',
          category: 'correctness',
          message: 'Must fix incorrect rollback',
          findingId: 'finding-42',
        },
      ],
      missingVerification: ['Not independently reproduced'],
    },
    proof: {
      certificates: [],
      implementationDigest: null,
      claims: [
        {
          claimId: 'private-claim-id',
          statement: 'All retry outcomes are reconciled',
          signalClass: 'test',
          critical: true,
          verificationState: null,
          certificateId: null,
          authorityDigest: null,
          evidenceRefCount: 0,
          counterexampleRefCount: 0,
        },
      ],
      coverageGaps: [],
    },
    reviewLinks: null,
    decisionAuthority: 'not_granted',
    warnings: [],
  };
}

describe('Desktop workbench review projection', () => {
  it('retains exact review binding while excluding raw document content and paths', () => {
    const output = projectWorkbenchReview(view(), 'ses_root');
    expect(output.schemaVersion).toBe('workbench-review.v1');
    expect(output.status).toBe('COMPLETE');
    expect(output.subject.reviewerVerdict).toBe('ACCEPT');
    expect(output.subject.subjectBinding).toBe('matched');
    expect(output.subject.digest).toBe('a'.repeat(64));
    expect(output.subject.findings[0]?.message).toBe('Must fix incorrect rollback');
    expect(output.proof.claims[0]?.verificationState).toBeNull();
    expect(output.decisionAuthority).toBe('not_granted');
    expect(JSON.stringify(output)).not.toContain('PRIVATE implementation');
    expect(JSON.stringify(output)).not.toContain('/private/worktree');
    expect(JSON.stringify(output)).not.toContain('private-claim-id');
  });

  it('does not report unverified subject or historical reviews as current approval', () => {
    const base = view();
    const result = projectWorkbenchReview(
      {
        ...base,
        status: 'NOT_VERIFIED',
        subject: {
          ...base.subject,
          reviewerVerdict: null,
          subjectBinding: 'mismatch',
          unboundReview: {
            verdict: 'ACCEPT',
            reviewedAt: null,
            findingsVersion: null,
            findings: [],
            findingsTruncated: false,
            missingVerification: [],
            scopeCreep: [],
            unknowns: [],
            reason: 'stale_revision',
          },
        },
      },
      'ses_root',
    );
    expect(result.status).toBe('NOT_VERIFIED');
    expect(result.subject.reviewerVerdict).toBeNull();
    expect(result.subject.unboundReviewReason).toBe('stale_revision');
    expect(result.decisionAuthority).toBe('not_granted');
  });

  it('derives a bounded chronological review-assurance timeline without inventing missing events', () => {
    const base = view();
    const output = projectWorkbenchReview(
      {
        ...base,
        reviewLinks: {
          obligations: [
            {
              obligationId: 'secret-obligation',
              obligationType: 'plan',
              status: 'fulfilled',
              iteration: 1,
              reviewCycle: 1,
              planVersion: 1,
              subjectDigest: 'a'.repeat(64),
              invocationId: null,
              blockedCode: null,
              fulfilledAt: '2026-11-07T11:00:04.000Z',
              consumedAt: null,
            },
          ],
          attempts: [
            {
              attemptId: 'secret-attempt',
              obligationId: 'secret-obligation',
              status: 'completed',
              ordinal: 1,
              childSessionId: null,
              subjectDigest: 'a'.repeat(64),
              createdAt: '2026-11-07T11:00:00.000Z',
              completedAt: '2026-11-07T11:00:03.000Z',
            },
          ],
          dispatches: [
            {
              dispatchId: 'secret-dispatch',
              attemptId: 'secret-attempt',
              obligationId: 'secret-obligation',
              hostCallId: 'secret-host-call',
              dispatchStatus: 'outcome_unknown',
              dispatchAuthorizedAt: '2026-11-07T11:00:01.000Z',
              completedAt: null,
            },
          ],
          invocations: [
            {
              invocationId: 'secret-invocation',
              obligationId: 'secret-obligation',
              attemptId: 'secret-attempt',
              childSessionId: 'secret-child',
              parentSessionId: 'ses_root',
              capturedVerdict: 'accept',
              invokedAt: '2026-11-07T11:00:02.000Z',
              fulfilledAt: null,
            },
          ],
          truncated: false,
        },
      },
      'ses_root',
    );
    expect(output.timeline?.status).toBe('available');
    expect(output.timeline?.total).toBe(5);
    expect(output.timeline?.events.map((entry) => entry.kind)).toEqual([
      'attempt',
      'dispatch',
      'invocation',
      'attempt',
      'obligation',
    ]);
    expect(output.timeline?.events.some((entry) => entry.state === 'outcome_unknown')).toBe(true);
    expect(JSON.stringify(output)).not.toContain('secret-');
    expect(output.proof.claims[0]?.certificateBinding).toBe('not_recorded');
  });

  it('keeps a truncated timeline visibly partial and uses the latest 32 persisted events', () => {
    const base = view();
    const attempts = Array.from({ length: 30 }, (_, i) => ({
      attemptId: 'private-' + i,
      obligationId: 'private-obligation',
      status: 'completed',
      ordinal: i + 1,
      childSessionId: null,
      subjectDigest: 'b'.repeat(64),
      createdAt: '2026-11-07T11:' + String(i).padStart(2, '0') + ':00.000Z',
      completedAt: '2026-11-07T11:' + String(i).padStart(2, '0') + ':30.000Z',
    }));
    const result = projectWorkbenchReview(
      {
        ...base,
        reviewLinks: {
          attempts,
          obligations: [],
          dispatches: [],
          invocations: [],
          truncated: true,
        },
      },
      'ses_root',
    );
    expect(result.timeline?.status).toBe('truncated');
    expect(result.timeline?.total).toBe(60);
    expect(result.timeline?.events).toHaveLength(32);
    expect(result.timeline?.events[0]?.at).toBe('2026-11-07T11:14:00.000Z');
    expect(result.timeline?.events.at(-1)?.at).toBe('2026-11-07T11:29:30.000Z');
  });

  it('bounds findings, missing verification and claims without hiding truncation', () => {
    const base = view();
    const many = Array.from({ length: 25 }, (_, i) => ({
      severity: 'warning',
      category: 'correctness',
      message: 'Finding number ' + i,
      findingId: null,
    }));
    const result = projectWorkbenchReview(
      {
        ...base,
        subject: {
          ...base.subject,
          findings: many,
          missingVerification: Array.from({ length: 25 }, (_, i) => 'Missing ' + i),
        },
      },
      'ses_root',
    );
    expect(result.subject.findings).toHaveLength(20);
    expect(result.subject.findingsTotal).toBe(25);
    expect(result.subject.findingsTruncated).toBe(true);
    expect(result.subject.missingVerification).toHaveLength(20);
    expect(result.subject.missingVerificationTruncated).toBe(true);
  });
});
