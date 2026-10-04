/**
 * @module state/review-dispatch.test
 * @description Unit tests for the durable reviewer-dispatch ledger mutators,
 * focused on the native Task host-call rebinding used when the exact child
 * session identity becomes observable only after host release.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all categories present.
 */

import { describe, expect, it } from 'vitest';
import {
  appendReviewDispatch,
  emptyReviewAssurance,
  rebindReviewDispatchHostCall,
} from './review-dispatch.js';
import type { ReviewDispatchRecord } from './evidence-review.js';

const ATTEMPT_ID = '11111111-2222-4111-8111-111111111111';
const OTHER_ATTEMPT_ID = '99999999-2222-4111-8111-111111111111';
const OBLIGATION_ID = '11111111-1111-4111-8111-111111111111';
const AUTHORIZED_AT = '2026-05-10T12:00:00.000Z';

function dispatch(overrides: Partial<ReviewDispatchRecord> = {}): ReviewDispatchRecord {
  return {
    dispatchId: '88888888-8888-4888-8888-888888888888',
    attemptId: ATTEMPT_ID,
    obligationId: OBLIGATION_ID,
    hostCallId: 'task-call-1',
    canonicalPromptDigest: 'a'.repeat(64),
    dispatchAuthorizedAt: AUTHORIZED_AT,
    dispatchStatus: 'authorized',
    ...overrides,
  };
}

describe('state/review-dispatch host-call rebinding', () => {
  describe('HAPPY', () => {
    it('rebinds the authorized dispatch to the bound child session', () => {
      const before = appendReviewDispatch(emptyReviewAssurance(), dispatch());
      const after = rebindReviewDispatchHostCall(before, 'task-call-1', 'child-session-1');

      expect(after.dispatches).toHaveLength(1);
      expect(after.dispatches[0]).toMatchObject({
        dispatchId: '88888888-8888-4888-8888-888888888888',
        attemptId: ATTEMPT_ID,
        hostCallId: 'child-session-1',
        dispatchStatus: 'authorized',
        canonicalPromptDigest: 'a'.repeat(64),
      });
    });
  });

  describe('BAD', () => {
    it('never rebinds a dispatch that already concluded', () => {
      const before = appendReviewDispatch(
        emptyReviewAssurance(),
        dispatch({ dispatchStatus: 'completed', completedAt: AUTHORIZED_AT }),
      );
      const after = rebindReviewDispatchHostCall(before, 'task-call-1', 'child-session-1');

      expect(after.dispatches[0]?.hostCallId).toBe('task-call-1');
    });

    it('never rebinds an unknown-outcome dispatch', () => {
      const before = appendReviewDispatch(
        emptyReviewAssurance(),
        dispatch({ dispatchStatus: 'outcome_unknown' }),
      );
      const after = rebindReviewDispatchHostCall(before, 'task-call-1', 'child-session-1');

      expect(after.dispatches[0]?.hostCallId).toBe('task-call-1');
    });
  });

  describe('CORNER', () => {
    it('is a no-op when the provisional host call is absent', () => {
      const before = appendReviewDispatch(emptyReviewAssurance(), dispatch());
      const after = rebindReviewDispatchHostCall(before, 'unknown-call', 'child-session-1');

      expect(after).toEqual(before);
    });

    it('is idempotent when the record is already bound', () => {
      const rebound = rebindReviewDispatchHostCall(
        appendReviewDispatch(emptyReviewAssurance(), dispatch()),
        'task-call-1',
        'child-session-1',
      );
      const again = rebindReviewDispatchHostCall(rebound, 'task-call-1', 'child-session-1');

      expect(again).toEqual(rebound);
    });
  });

  describe('EDGE', () => {
    it('rebinds only the exact provisional host call', () => {
      let assurance = appendReviewDispatch(emptyReviewAssurance(), dispatch());
      assurance = appendReviewDispatch(
        assurance,
        dispatch({
          dispatchId: '77777777-8888-4888-8888-888888888888',
          attemptId: OTHER_ATTEMPT_ID,
          hostCallId: 'task-call-2',
        }),
      );

      const after = rebindReviewDispatchHostCall(assurance, 'task-call-2', 'child-session-2');

      expect(after.dispatches.map((record) => record.hostCallId)).toEqual([
        'task-call-1',
        'child-session-2',
      ]);
    });
  });
});
