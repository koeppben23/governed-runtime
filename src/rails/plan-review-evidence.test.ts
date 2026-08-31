import { describe, expect, it } from 'vitest';
import { makeState, PLAN_RECORD, FIXED_TIME } from '../fixtures.js';
import { canonicalJsonStringify } from '../shared/canonical-json.js';
import { hashText } from '../shared/hashing.js';
import { enforcePlanReviewEvidence } from './plan-review-evidence.js';
import { executeReviewDecision } from './review-decision.js';
import { assuranceChain } from './review-decision-test-helpers.js';

const declarations = {
  flow: 'plan' as const,
  version: 'v2' as const,
  claims: [
    {
      claimId: '00000000-0000-4000-8000-000000000003',
      statement: 'The login flow rejects invalid credentials.',
      critical: true,
      authoritySectionId: 'authentication',
      claimScope: 'specific_behavior' as const,
      expectedCheckId: 'test',
    },
  ],
};

describe('enforcePlanReviewEvidence', () => {
  it('blocks approval when review evidence froze different claim declarations', () => {
    const state = makeState('PLAN_REVIEW', {
      plan: {
        current: PLAN_RECORD.current,
        history: PLAN_RECORD.history,
        claimDeclarations: declarations,
        reviewCompletion: 'reviewer_accepted',
      },
    });
    const resolution = {
      obligationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      invocationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      findingsHash: 'a'.repeat(64),
      subjectDigest: PLAN_RECORD.current.digest,
      reviewerVerdict: 'accept',
      claimDeclarationsDigest: hashText('different declarations'),
    };

    const blockedResult = enforcePlanReviewEvidence(state, resolution);
    expect(blockedResult).toMatchObject({
      code: 'PLAN_REVIEW_EVIDENCE_REQUIRED',
    });
    expect(blockedResult?.reason).toContain('claim_declarations_mismatch');
  });

  it('blocks approval when bound review evidence carries no claim declarations digest', () => {
    const state = makeState('PLAN_REVIEW', {
      plan: {
        current: PLAN_RECORD.current,
        history: PLAN_RECORD.history,
        reviewCompletion: 'reviewer_accepted',
      },
    });
    const resolution = {
      obligationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      invocationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      findingsHash: 'a'.repeat(64),
      subjectDigest: PLAN_RECORD.current.digest,
      reviewerVerdict: 'accept',
    };

    const blockedResult = enforcePlanReviewEvidence(state, resolution);
    expect(blockedResult).toMatchObject({
      kind: 'blocked',
      code: 'PLAN_REVIEW_EVIDENCE_REQUIRED',
    });
    expect(blockedResult?.reason).toContain('claim_declarations_missing');
  });

  it('accepts review evidence frozen against the exact declarations', () => {
    const state = makeState('PLAN_REVIEW', {
      plan: {
        current: PLAN_RECORD.current,
        history: PLAN_RECORD.history,
        claimDeclarations: declarations,
        reviewCompletion: 'reviewer_accepted',
      },
    });
    const resolution = {
      obligationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      invocationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      findingsHash: 'a'.repeat(64),
      subjectDigest: PLAN_RECORD.current.digest,
      reviewerVerdict: 'accept',
      claimDeclarationsDigest: hashText(canonicalJsonStringify(declarations)),
    };

    expect(enforcePlanReviewEvidence(state, resolution)).toBeNull();
  });
});

describe('plan approval certificate authority (version-tuple binding)', () => {
  const O1 = '11111111-1111-4111-8111-111111111111';
  const O2 = '22222222-2222-4222-8222-222222222222';
  const SUBJECT = PLAN_RECORD.current.digest;

  it('binds the current-version review when an older revision reviewed identical content', () => {
    const state = makeState('PLAN_REVIEW', {
      plan: {
        current: { ...PLAN_RECORD.current, planVersion: 2 },
        history: [PLAN_RECORD.current],
        reviewCompletion: 'reviewer_accepted',
      },
      reviewAssurance: assuranceChain([
        {
          obligationId: O1,
          obligationType: 'plan',
          subjectDigest: SUBJECT,
          status: 'consumed',
          iteration: 2,
          planVersion: 1,
          capturedVerdict: 'accept',
          invocationId: `${O1}-inv`,
          findingsHash: 'a'.repeat(64),
          claimDeclarationsDigest: hashText('older-claims'),
        },
        {
          obligationId: O2,
          obligationType: 'plan',
          subjectDigest: SUBJECT,
          status: 'consumed',
          iteration: 0,
          planVersion: 2,
          capturedVerdict: 'accept',
          invocationId: `${O2}-inv`,
          findingsHash: 'b'.repeat(64),
          claimDeclarationsDigest: hashText(
            canonicalJsonStringify({ flow: 'plan', version: 'v2', claims: [] }),
          ),
        },
      ]),
    });

    const result = executeReviewDecision(
      state,
      { verdict: 'approve', rationale: 'ok', decidedBy: 'reviewer-1' },
      { now: () => FIXED_TIME, digest: hashText },
    );

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      const binding = result.state.plan?.approvalCertificate?.reviewBinding;
      expect(binding?.kind).toBe('current_review');
      expect(binding?.kind === 'current_review' ? binding.reviewObligationId : undefined).toBe(O2);
    }
  });
});
