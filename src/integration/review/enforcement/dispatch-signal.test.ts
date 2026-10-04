/**
 * @module integration/review/dispatch-signal.test
 * @description Contract coverage for the structured review-dispatch signal.
 * The signal is fail-closed: malformed shapes are never interpreted as a
 * review-required or review-completed dispatch.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 */

import { describe, it, expect } from 'vitest';
import {
  reviewDispatchRequired,
  reviewDispatchCompleted,
  readReviewDispatch,
  isReviewDispatchRequired,
  isReviewDispatchCompleted,
} from './dispatch-signal.js';

describe('reviewDispatchRequired / reviewDispatchCompleted', () => {
  it('HAPPY: builds the required signal', () => {
    expect(reviewDispatchRequired()).toEqual({ required: true });
  });

  it('HAPPY: builds the completed signal with the bound verdict', () => {
    expect(reviewDispatchCompleted('changes_requested')).toEqual({
      required: true,
      completed: true,
      verdict: 'changes_requested',
    });
  });
});

describe('readReviewDispatch', () => {
  it('HAPPY: reads a required signal from a tool response envelope', () => {
    expect(readReviewDispatch({ reviewDispatch: { required: true } })).toEqual({ required: true });
  });

  it('HAPPY: reads a completed signal from a tool response envelope', () => {
    expect(
      readReviewDispatch({
        phase: 'PLAN',
        reviewDispatch: { required: true, completed: true, verdict: 'accept' },
      }),
    ).toEqual({ required: true, completed: true, verdict: 'accept' });
  });

  it('CORNER: ignores unrelated envelope fields', () => {
    expect(
      readReviewDispatch({
        directive: { code: 'PLAN_REVIEW_IN_PROGRESS' },
        reviewDispatch: { required: true },
      }),
    ).toEqual({ required: true });
  });

  it('BAD: returns null for non-object envelopes', () => {
    for (const value of [null, undefined, 42, 'required', true]) {
      expect(readReviewDispatch(value)).toBeNull();
    }
  });

  it('BAD: returns null for an array envelope', () => {
    expect(readReviewDispatch([{ required: true }])).toBeNull();
  });

  it('BAD: returns null when reviewDispatch is absent', () => {
    expect(readReviewDispatch({ phase: 'PLAN' })).toBeNull();
  });

  it('BAD: returns null for non-object reviewDispatch values', () => {
    for (const value of [null, 'required', 42, [true]]) {
      expect(readReviewDispatch({ reviewDispatch: value })).toBeNull();
    }
  });

  it('BAD: returns null when required is missing or not a boolean', () => {
    expect(readReviewDispatch({ reviewDispatch: {} })).toBeNull();
    expect(readReviewDispatch({ reviewDispatch: { required: 'true' } })).toBeNull();
    expect(readReviewDispatch({ reviewDispatch: { required: 1 } })).toBeNull();
  });

  it('BAD: returns null when completed is not a boolean', () => {
    expect(readReviewDispatch({ reviewDispatch: { required: true, completed: 'yes' } })).toBeNull();
  });

  it('BAD: returns null when verdict is not a string', () => {
    expect(
      readReviewDispatch({ reviewDispatch: { required: true, completed: true, verdict: 42 } }),
    ).toBeNull();
  });

  it('EDGE: completed without a verdict remains a valid typed signal', () => {
    expect(readReviewDispatch({ reviewDispatch: { required: true, completed: true } })).toEqual({
      required: true,
      completed: true,
    });
  });
});

describe('isReviewDispatchRequired', () => {
  it('HAPPY: true for a required signal', () => {
    expect(isReviewDispatchRequired({ reviewDispatch: { required: true } })).toBe(true);
  });

  it('BAD: false for a completed signal', () => {
    expect(
      isReviewDispatchRequired({
        reviewDispatch: { required: true, completed: true, verdict: 'accept' },
      }),
    ).toBe(false);
  });

  it('CORNER: false for a non-required signal', () => {
    expect(isReviewDispatchRequired({ reviewDispatch: { required: false } })).toBe(false);
  });

  it('BAD: false when the field is missing', () => {
    expect(isReviewDispatchRequired({ phase: 'PLAN' })).toBe(false);
  });

  it('BAD: false when the signal is malformed (fail-closed)', () => {
    expect(isReviewDispatchRequired({ reviewDispatch: { required: 'true' } })).toBe(false);
    expect(isReviewDispatchRequired({ reviewDispatch: [1] })).toBe(false);
  });

  it('BAD: false for a removed textual next field', () => {
    expect(isReviewDispatchRequired({ next: 'INDEPENDENT_REVIEW_REQUIRED' })).toBe(false);
  });
});

describe('isReviewDispatchCompleted', () => {
  it('HAPPY: true for a completed signal', () => {
    expect(
      isReviewDispatchCompleted({
        reviewDispatch: { required: true, completed: true, verdict: 'accept' },
      }),
    ).toBe(true);
  });

  it('BAD: false for a required-only signal', () => {
    expect(isReviewDispatchCompleted({ reviewDispatch: { required: true } })).toBe(false);
  });

  it('CORNER: false when required is false even if completed is true', () => {
    expect(
      isReviewDispatchCompleted({
        reviewDispatch: { required: false, completed: true, verdict: 'accept' },
      }),
    ).toBe(false);
  });

  it('BAD: false when the signal is malformed (fail-closed)', () => {
    expect(
      isReviewDispatchCompleted({ reviewDispatch: { required: true, completed: 'true' } }),
    ).toBe(false);
  });

  it('BAD: false when the field is missing', () => {
    expect(isReviewDispatchCompleted({ phase: 'PLAN' })).toBe(false);
  });
});
