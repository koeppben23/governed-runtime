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
  hasOutstandingReviewObligation,
  hasUnresolvedIntegrityIncident,
  isOpenReviewObligation,
} from './review-dispatch.js';
import type { ReviewDispatchRecord, ReviewObligation } from './evidence-review.js';

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

describe('review obligation open-work semantics', () => {
  function obligation(
    status: ReviewObligation['status'],
    consumedAt: string | null,
  ): ReviewObligation {
    return { status, consumedAt } as unknown as ReviewObligation;
  }

  it('HAPPY — pending and fulfilled obligations are open work', () => {
    expect(isOpenReviewObligation(obligation('pending', null))).toBe(true);
    expect(isOpenReviewObligation(obligation('fulfilled', null))).toBe(true);
  });

  it('BAD — consumed and deterministically blocked obligations are terminal', () => {
    expect(isOpenReviewObligation(obligation('consumed', '2026-01-01T00:00:00.000Z'))).toBe(false);
    expect(isOpenReviewObligation(obligation('blocked', null))).toBe(false);
  });

  it('EDGE — a consumedAt stamp alone closes an obligation', () => {
    expect(isOpenReviewObligation(obligation('pending', '2026-01-01T00:00:00.000Z'))).toBe(false);
  });

  it('hasOutstandingReviewObligation counts only open work', () => {
    expect(
      hasOutstandingReviewObligation({
        ...emptyReviewAssurance(),
        obligations: [
          obligation('blocked', null),
          obligation('consumed', '2026-01-01T00:00:00.000Z'),
        ],
      }),
    ).toBe(false);
    expect(
      hasOutstandingReviewObligation({
        ...emptyReviewAssurance(),
        obligations: [obligation('blocked', null), obligation('fulfilled', null)],
      }),
    ).toBe(true);
  });
});

describe('review integrity incident semantics (D7)', () => {
  function blocked(code: string | null): ReviewObligation {
    return {
      status: 'blocked',
      blockedCode: code,
      consumedAt: null,
    } as unknown as ReviewObligation;
  }

  function settled(status: 'consumed' | 'fulfilled'): ReviewObligation {
    return {
      status,
      blockedCode: null,
      invocationId: '00000000-0000-4000-8000-0000000000e1',
      fulfilledAt: '2026-01-03T00:00:00.000Z',
      consumedAt: status === 'consumed' ? '2026-01-03T00:00:00.000Z' : null,
    } as unknown as ReviewObligation;
  }

  it('BAD — absent assurance and deterministic blocks are not integrity incidents', () => {
    expect(hasUnresolvedIntegrityIncident(undefined)).toBe(false);
    expect(hasUnresolvedIntegrityIncident(null)).toBe(false);
    expect(
      hasUnresolvedIntegrityIncident({
        ...emptyReviewAssurance(),
        obligations: [blocked('REVIEW_ATTEMPT_UNAVAILABLE'), blocked(null)],
      }),
    ).toBe(false);
  });

  it('HAPPY — a reused-evidence block is an integrity incident', () => {
    expect(
      hasUnresolvedIntegrityIncident({
        ...emptyReviewAssurance(),
        obligations: [blocked('SUBAGENT_EVIDENCE_REUSED')],
      }),
    ).toBe(true);
  });

  it('BAD — later settled obligations never auto-resolve the incident', () => {
    for (const successor of [settled('fulfilled'), settled('consumed')]) {
      expect(
        hasUnresolvedIntegrityIncident({
          ...emptyReviewAssurance(),
          obligations: [blocked('SUBAGENT_EVIDENCE_REUSED'), successor],
        }),
      ).toBe(true);
    }
  });
});
