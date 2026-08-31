import { describe, expect, it } from 'vitest';
import { makeState, PLAN_RECORD } from '../fixtures.js';
import { canonicalJsonStringify } from '../shared/canonical-json.js';
import { hashText } from '../shared/hashing.js';
import { enforcePlanReviewEvidence } from './plan-review-evidence.js';

const declarations = {
  flow: 'plan' as const,
  claims: [
    {
      claimId: '00000000-0000-4000-8000-000000000003',
      statement: 'The login flow rejects invalid credentials.',
      critical: true,
      authoritySectionId: 'authentication',
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

    expect(enforcePlanReviewEvidence(state, resolution)).toMatchObject({
      code: 'PLAN_REVIEW_EVIDENCE_REQUIRED',
    });
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
