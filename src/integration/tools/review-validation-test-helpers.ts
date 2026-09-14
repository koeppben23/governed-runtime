/**
 * Shared test fixtures for the review-validation host-task resolution family.
 * Import target only — never executed as a test suite.
 */

import { randomUUID } from 'node:crypto';
import type {
  ReviewAssuranceState,
  ReviewInvocationEvidence,
  ReviewObligation,
} from '../../state/evidence-review.js';
import {
  hashFindings,
  hashText,
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
} from '../review/assurance.js';

export const RV_OBLIGATION_ID = '11111111-1111-4111-8111-111111111111';
export const RV_INVOCATION_ID = '22222222-2222-4222-8222-222222222222';
const RV_ATTEMPT_ID = '33333333-3333-4333-8333-333333333333';
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
    maxReviewerAttempts: 1,
    reviewProfile: 'core' as const,
    profileSource: 'policy_default' as const,
    reviewMaterial: {
      content: 'frozen plan review material',
      materialDigest: 'a'.repeat(64),
      subjectDigest: 'test-subject-digest',
    },
    requiredChallengeCount: 0,
    requiredChallengeKind: 'design_challenge',
    challengePolicyVersion: 'challenge-policy.v1',
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
    attemptId: RV_ATTEMPT_ID,
    obligationId: RV_OBLIGATION_ID,
    obligationType: 'plan' as const,
    parentSessionId: 'ses_parent',
    childSessionId: 'ses_child',
    agentType: 'flowguard-reviewer' as const,
    invocationMode: 'host_subagent_task' as const,
    source: 'host-orchestrated' as const,
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

/**
 * Canonical host-task dispatch fixture for a persisted attempt. Reuses the
 * attempt's existing active dispatch (an attempt can hold at most one) so a
 * re-recorded invocation stays coherent with the durable ledger; otherwise
 * mints a fresh completed dispatch whose host call id and canonical prompt
 * digest belong to the invocation being recorded.
 */
export function hostTaskDispatchPlan(input: {
  readonly isHostTask: boolean;
  readonly dispatches: ReviewAssuranceState['dispatches'];
  readonly attemptId: string;
  readonly obligationId: string;
  readonly at: string;
}): {
  readonly hostTaskCallId: string | undefined;
  readonly canonicalPromptDigest: string | undefined;
  readonly dispatch: ReviewAssuranceState['dispatches'][number] | undefined;
} {
  if (!input.isHostTask) {
    return { hostTaskCallId: undefined, canonicalPromptDigest: undefined, dispatch: undefined };
  }
  const existing = input.dispatches.find(
    (record) => record.attemptId === input.attemptId && record.dispatchStatus !== 'outcome_unknown',
  );
  if (existing) {
    return {
      hostTaskCallId: existing.hostCallId,
      canonicalPromptDigest: existing.canonicalPromptDigest,
      dispatch: undefined,
    };
  }
  const hostTaskCallId = `call-${randomUUID()}`;
  const canonicalPromptDigest = hashText(`host-task:${input.obligationId}:${input.attemptId}`);
  return {
    hostTaskCallId,
    canonicalPromptDigest,
    dispatch: {
      dispatchId: randomUUID(),
      attemptId: input.attemptId,
      obligationId: input.obligationId,
      hostCallId: hostTaskCallId,
      canonicalPromptDigest,
      dispatchAuthorizedAt: input.at,
      dispatchStatus: 'completed',
      completedAt: input.at,
    },
  };
}
