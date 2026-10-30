import { describe, expect, it } from 'vitest';
import { FIXED_TIME, makeState } from '../../fixtures.js';
import { completedDispatchForInvocation } from '../../state/evidence-test-constants.js';
import { ReviewFindings } from '../../state/evidence.js';
import {
  artifactReviewSubjectScope,
  createReviewObligation,
  freezeReviewMaterial,
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
} from '../review/obligations/assurance.js';
import { buildInvocationFixture as buildInvocationEvidence } from '../../review-invocation-test-helpers.js';
import { hashFindings } from '../review/findings-hash.js';
import {
  buildReviewFeedbackProjection,
  statusProjectionKind,
} from './status-detail-projections.js';

function feedbackState() {
  const base = makeState('ARCHITECTURE');
  const obligation = createReviewObligation({
    policySnapshot: {
      challengePolicy: {
        version: 'challenge-policy.v1',
        counts: { TRIVIAL: 0, STANDARD: 1, 'HIGH-RISK': 2 },
      },
      maxReviewerAttempts: 1,
    },
    obligationType: 'architecture',
    reviewCycle: 1,
    iteration: 0,
    planVersion: 1,
    now: FIXED_TIME,
    subjectDigest: 'adr-digest-reviewed',
    reviewSubjectScope: artifactReviewSubjectScope(
      'adr',
      '## Context\nA\n\n## Decision\nB\n\n## Consequences\nC',
      'adr-digest-reviewed',
    ),
    reviewMaterial: freezeReviewMaterial(
      '## Architecture Decision Artifact\n\n## Context\nA\n\n## Decision\nB\n\n## Consequences\nC\n',
      'adr-digest-reviewed',
    ),
    repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
  });
  const findings = {
    iteration: 0,
    planVersion: 1,
    reviewMode: 'subagent',
    overallVerdict: 'changes_requested',
    blockingIssues: [],
    majorRisks: [],
    missingVerification: ['Add a controller regression test for the null path.'],
    scopeCreep: ['Do not change the repository API.'],
    unknowns: ['The nullability contract is not documented.'],
    challenges: [],
    reviewedBy: { sessionId: 'ses-reviewer' },
    reviewedAt: FIXED_TIME,
    attestation: {
      mandateDigest: REVIEW_MANDATE_DIGEST,
      criteriaVersion: REVIEW_CRITERIA_VERSION,
      toolObligationId: obligation.obligationId,
      iteration: 0,
      planVersion: 1,
      reviewedBy: 'flowguard-reviewer',
    },
  } as ReviewFindings;
  const attemptId = '00000000-0000-4000-8000-000000000123';
  const invocation = buildInvocationEvidence({
    obligationId: obligation.obligationId,
    obligationType: 'architecture',
    mandateDigest: REVIEW_MANDATE_DIGEST,
    criteriaVersion: REVIEW_CRITERIA_VERSION,
    parentSessionId: base.binding.hostSessionId,
    childSessionId: 'ses-reviewer',
    promptHash: 'a'.repeat(64),
    findingsHash: hashFindings(findings),
    invokedAt: FIXED_TIME,
    fulfilledAt: FIXED_TIME,
    capturedRawFindings: findings,
    attemptId,
  });

  return makeState('ARCHITECTURE', {
    reviewAssurance: {
      assuranceSchemaVersion: 'review-assurance.v7',
      obligations: [
        {
          ...obligation,
          status: 'fulfilled',
          invocationId: invocation.invocationId,
          fulfilledAt: FIXED_TIME,
        },
      ],
      invocations: [invocation],
      attempts: [
        {
          attemptId,
          obligationId: obligation.obligationId,
          obligationType: 'architecture',
          subjectDigest: obligation.subjectDigest,
          ordinal: 1,
          childSessionId: 'ses-reviewer',
          status: 'bound',
          origin: { kind: 'initial' },
          repositoryDiscovery: { kind: 'not_applicable' },
          observations: [],
          createdAt: FIXED_TIME,
          completedAt: FIXED_TIME,
        },
      ],
      dispatches: [completedDispatchForInvocation(invocation)],
    },
  });
}

describe('buildReviewFeedbackProjection', () => {
  it('projects only exact, current, bound, unconsumed changes-requested feedback as untrusted data', () => {
    const projection = buildReviewFeedbackProjection(feedbackState());

    expect(projection).toMatchObject({
      source: 'bound_reviewer_evidence',
      contentTrust: 'untrusted_reviewer_content',
      obligation: { type: 'architecture', subjectDigest: 'adr-digest-reviewed' },
      review: { reviewerSessionId: 'ses-reviewer', verdict: 'changes_requested' },
      missingVerification: ['Add a controller regression test for the null path.'],
      scopeCreep: ['Do not change the repository API.'],
      unknowns: ['The nullability contract is not documented.'],
    });
    expect(ReviewFindings.safeParse(projection).success).toBe(false);
  });

  it('fails closed for consumed evidence or a host-session mismatch', () => {
    const state = feedbackState();
    const assurance = state.reviewAssurance!;
    const consumed = {
      ...state,
      reviewAssurance: {
        ...assurance,
        obligations: assurance.obligations.map((item) => ({
          ...item,
          status: 'consumed' as const,
          consumedAt: FIXED_TIME,
        })),
        invocations: assurance.invocations.map((item) => ({
          ...item,
          consumedByObligationId: item.obligationId,
        })),
      },
    };
    const mismatchedHost = {
      ...state,
      reviewAssurance: {
        ...assurance,
        invocations: assurance.invocations.map((item) => ({
          ...item,
          parentSessionId: 'ses-other-host',
        })),
      },
    };

    expect(buildReviewFeedbackProjection(consumed)).toBeNull();
    expect(buildReviewFeedbackProjection(mismatchedHost)).toBeNull();
  });

  it('fails closed outside the owning phase, for a stale generation, or a different obligation type', () => {
    const state = feedbackState();
    const assurance = state.reviewAssurance!;
    const architectureReview = { ...state, phase: 'ARCH_REVIEW' as const };
    const staleGeneration = {
      ...state,
      reviewAssurance: {
        ...assurance,
        obligations: assurance.obligations.map((item) => ({
          ...item,
          criteriaVersion: 'obsolete-generation',
        })),
      },
    };
    const planObligation = {
      ...state,
      reviewAssurance: {
        ...assurance,
        obligations: assurance.obligations.map((item) => ({
          ...item,
          obligationType: 'plan' as const,
        })),
        invocations: assurance.invocations.map((item) => ({
          ...item,
          obligationType: 'plan' as const,
        })),
      },
    };

    expect(buildReviewFeedbackProjection(architectureReview)).toBeNull();
    expect(buildReviewFeedbackProjection(staleGeneration)).toBeNull();
    expect(buildReviewFeedbackProjection(planObligation)).toBeNull();
  });
});

describe('statusProjectionKind (single projection-dispatch authority)', () => {
  it('selects the full status without a focused flag', () => {
    expect(statusProjectionKind({})).toBe('full');
    expect(statusProjectionKind({ whyBlocked: false, evidence: undefined })).toBe('full');
  });

  it.each([null, undefined, 'evidence', 42])('treats non-object arguments (%j) as full', (args) => {
    expect(statusProjectionKind(args)).toBe('full');
  });

  it.each([
    'finish',
    'whyBlocked',
    'evidence',
    'context',
    'readiness',
    'reviewFeedback',
    'proofGraph',
  ] as const)('selects the %s projection for its own flag', (flag) => {
    expect(statusProjectionKind({ [flag]: true })).toBe(flag);
  });

  it('keeps first-match precedence when several flags are set', () => {
    expect(statusProjectionKind({ proofGraph: true, finish: true, whyBlocked: true })).toBe(
      'finish',
    );
    expect(statusProjectionKind({ reviewFeedback: true, evidence: true, whyBlocked: true })).toBe(
      'whyBlocked',
    );
    expect(statusProjectionKind({ proofGraph: true, readiness: true })).toBe('readiness');
  });
});
