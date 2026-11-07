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
