/** Persisted plan/review/approval fixtures for external demo witness tests. */
export function reviewedPlan() {
  return {
    phase: 'PLAN_REVIEW',
    flowguardSessionId: 'fg-1',
    binding: { hostSessionId: 'ses_parent' },
    plan: {
      current: { digest: 'plan-A', recordDigest: 'record-A', planVersion: 1 },
      reviewCompletion: 'reviewer_accepted',
    },
    reviewAssurance: {
      obligations: [
        {
          obligationId: 'ob-A',
          obligationType: 'plan',
          subjectDigest: 'plan-A',
          status: 'consumed',
          consumedAt: '2026-10-13T00:00:00Z',
          invocationId: 'inv-A',
        },
      ],
      invocations: [
        {
          invocationId: 'inv-A',
          obligationId: 'ob-A',
          attemptId: 'attempt-A',
          consumedByObligationId: 'ob-A',
          capturedVerdict: 'accept',
          structuredOutputUsed: true,
        },
      ],
      attempts: [{ attemptId: 'attempt-A', obligationId: 'ob-A', subjectDigest: 'plan-A' }],
    },
  };
}

export function approvedPlan() {
  const state = reviewedPlan();
  return {
    ...state,
    phase: 'IMPLEMENTATION',
    plan: {
      ...state.plan,
      approvalCertificate: {
        certificateId: 'cert-A',
        authorityDigest: 'plan-A',
        planRecordDigest: 'record-A',
        planVersion: 1,
        reviewBinding: {
          kind: 'current_review',
          reviewObligationId: 'ob-A',
          reviewedSubjectDigest: 'plan-A',
        },
      },
    },
  };
}
