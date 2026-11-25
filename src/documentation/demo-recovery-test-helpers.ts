/** Project fixture state for demo tests using the product's canonical V2 invocation. */
import { reviewInvocationValidator } from '../../demos/lib/review-recovery-authority.mjs';
import { ARCHITECTURE_REVIEW_ASSURANCE, PLAN_REVIEW_ASSURANCE } from '../fixtures.js';
import { hasValidStructuredInvocationContract } from '../integration/review/validation/review-validation-acceptance.js';
import { ReviewInvocationEvidence } from '../state/evidence-review-invocation.js';

export const validateReviewInvocation = reviewInvocationValidator(
  ReviewInvocationEvidence,
  hasValidStructuredInvocationContract,
);

export function consumedReview(
  obligationType: 'plan' | 'architecture' | 'implement',
  subjectDigest: string,
  parentSessionId = 'ses_parent',
) {
  const { obligations, invocations, attempts } =
    obligationType === 'architecture' ? ARCHITECTURE_REVIEW_ASSURANCE : PLAN_REVIEW_ASSURANCE;
  const invocation = ReviewInvocationEvidence.parse({
    ...invocations[0],
    obligationType,
    parentSessionId,
  });
  return {
    obligations: [{ ...obligations[0]!, obligationType, subjectDigest }],
    invocations: [{ ...invocation }],
    attempts: [{ ...attempts[0]!, obligationType, subjectDigest }],
  };
}

export function reviewedPlan(
  digest = 'plan-A',
  recordDigest = 'record-A',
  hostSessionId = 'ses_parent',
) {
  return {
    phase: 'PLAN_REVIEW',
    flowguardSessionId: 'fg-1',
    binding: { hostSessionId },
    plan: {
      current: { digest, recordDigest, planVersion: 1 },
      reviewCompletion: 'reviewer_accepted',
    },
    selfReview: { iteration: 1, maxIterations: 2, verdict: 'accept' },
    reviewAssurance: consumedReview('plan', digest, hostSessionId),
  };
}

export function approvedPlan() {
  const state = reviewedPlan();
  const { digest, recordDigest, planVersion } = state.plan.current;
  return {
    ...state,
    phase: 'IMPLEMENTATION',
    plan: {
      ...state.plan,
      approvalCertificate: {
        certificateId: 'cert-A',
        authorityDigest: digest,
        planRecordDigest: recordDigest,
        planVersion,
        reviewBinding: {
          kind: 'current_review',
          reviewObligationId: state.reviewAssurance.obligations[0]!.obligationId,
          reviewedSubjectDigest: digest,
        },
      },
    },
  };
}
