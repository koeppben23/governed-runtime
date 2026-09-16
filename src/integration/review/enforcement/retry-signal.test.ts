import { describe, expect, it } from 'vitest';
import { createSessionState, onFlowGuardToolAfter } from './enforcement.js';
import { reviewDispatchRequired } from '../dispatch-signal.js';
import { NOW } from './test-helpers.js';

describe('peer review retry signal', () => {
  it('registers the reissued attempt before the next reviewer dispatch', () => {
    const state = createSessionState();
    const attemptId = '33333333-2222-4111-8111-111111111111';
    const obligationId = '33333333-1111-4111-8111-111111111111';

    onFlowGuardToolAfter(
      state,
      'flowguard_review',
      { reviewObligationId: obligationId, reviewVerdict: 'changes_requested' },
      JSON.stringify({
        error: true,
        code: 'REVIEW_ATTEMPT_UNAVAILABLE',
        reviewAttemptId: attemptId,
        reviewObligation: { obligationId },
        requiredReviewAttestation: {
          toolObligationId: obligationId,
          mandateDigest: 'test-mandate-digest',
          criteriaVersion: 'p37-v1',
        },
        reviewDispatch: reviewDispatchRequired(),
      }),
      NOW,
    );

    expect(state.pendingReviews.get('flowguard_review')).toMatchObject({
      attemptId,
      obligationId,
    });
  });
});
