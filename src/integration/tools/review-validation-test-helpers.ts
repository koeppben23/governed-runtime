/**
 * Shared test fixtures for the review-validation host-task resolution family.
 * Import target only — never executed as a test suite.
 */

import type { ReviewInvocationEvidence, ReviewObligation } from '../../state/evidence-review.js';
import {
  hashFindings,
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
} from '../review/assurance.js';

export const RV_OBLIGATION_ID = '11111111-1111-4111-8111-111111111111';
export const RV_INVOCATION_ID = '22222222-2222-4222-8222-222222222222';
export const RV_NOW = new Date().toISOString();

export function makeReviewObligation(overrides: Partial<ReviewObligation> = {}): ReviewObligation {
  return {
    obligationId: RV_OBLIGATION_ID,
    obligationType: 'plan' as const,
    subjectDigest: 'test-subject-digest',
    iteration: 0,
    planVersion: 1,
    criteriaVersion: REVIEW_CRITERIA_VERSION,
    mandateDigest: REVIEW_MANDATE_DIGEST,
    maxReviewerOutputRepairAttempts: 1,
    createdAt: RV_NOW,
    pluginHandshakeAt: RV_NOW,
    status: 'fulfilled' as const,
    invocationId: RV_INVOCATION_ID,
    blockedCode: null,
    fulfilledAt: RV_NOW,
    consumedAt: null,
    reviewSubjectScope: {
      kind: 'repository_change',
      paths: ['src/foo.ts'],
      revisions: ['base', 'head'],
    },
    ...overrides,
  };
}

export function makeHostTaskInvocation(
  rawFindings: Record<string, unknown>,
  overrides: Partial<ReviewInvocationEvidence> = {},
): ReviewInvocationEvidence {
  return {
    invocationId: RV_INVOCATION_ID,
    obligationId: RV_OBLIGATION_ID,
    obligationType: 'plan' as const,
    parentSessionId: 'ses_parent',
    childSessionId: 'ses_child',
    agentType: 'flowguard-reviewer' as const,
    invocationMode: 'host_subagent_task' as const,
    hostVisible: true,
    promptHash: 'abc',
    mandateDigest: REVIEW_MANDATE_DIGEST,
    criteriaVersion: REVIEW_CRITERIA_VERSION,
    findingsHash: hashFindings(rawFindings),
    invokedAt: RV_NOW,
    fulfilledAt: RV_NOW,
    consumedByObligationId: null,
    capturedVerdict: 'accept',
    capturedRawFindings: rawFindings,
    reviewOutputMode: 'structured_output',
    structuredOutputUsed: true,
    reviewAssuranceLevel: 'structured_high',
    ...overrides,
  };
}
