/** Native V2 budgeting validation. No V1 maxOutputTokens hook or simulated wire/headroom proof. */
import { describe, expect, it } from 'vitest';
import {
  validateNativeReviewerOutputLimit,
  ReviewerOutputCapError,
} from './reviewer-output-cap.js';

describe('native reviewer output budgeting', () => {
  it('leaves host budgeting entirely to the native host', () => {
    expect(() => validateNativeReviewerOutputLimit('host')).not.toThrow();
  });

  it.each([1, 32_000, 65_536, 393_216, Number.MAX_SAFE_INTEGER])(
    'blocks explicit limit %s until native headroom and final-wire proof exist',
    (limit) => {
      expect(() => validateNativeReviewerOutputLimit(limit)).toThrow(ReviewerOutputCapError);
      expect(() => validateNativeReviewerOutputLimit(limit)).toThrow(
        expect.objectContaining({
          code: 'REVIEWER_OUTPUT_CAP_MODEL_LIMIT_UNKNOWN',
        }),
      );
    },
  );

  it.each([0, -1, 1.5, NaN, Infinity, -Infinity])(
    'rejects invalid numeric configuration %s explicitly',
    (limit) => {
      expect(() => validateNativeReviewerOutputLimit(limit)).toThrow(
        expect.objectContaining({
          code: 'REVIEWER_OUTPUT_CAP_CONFIG_INVALID',
        }),
      );
    },
  );

  it.each(['host', 65_536] as const)(
    'does not mask unreadable config behind %s budgeting',
    (limit) => {
      expect(() => validateNativeReviewerOutputLimit(limit, new Error('unreadable'))).toThrow(
        expect.objectContaining({
          code: 'REVIEWER_OUTPUT_CAP_CONFIG_UNREADABLE',
          message: expect.stringContaining('unreadable'),
        }),
      );
    },
  );

  it.each([null, 'config denied', 0])(
    'treats any supplied config failure as unreadable: %j',
    (failure) => {
      expect(() => validateNativeReviewerOutputLimit('host', failure)).toThrow(
        expect.objectContaining({
          code: 'REVIEWER_OUTPUT_CAP_CONFIG_UNREADABLE',
        }),
      );
    },
  );
});
