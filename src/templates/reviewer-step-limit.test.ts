/**
 * @module templates/reviewer-step-limit
 * @description Isolated step-budget experiment: only 10/12/14 are accepted;
 * every other value fails closed instead of silently using the default.
 */

import { describe, expect, it } from 'vitest';
import {
  REVIEWER_STEP_LIMIT_ENV,
  ReviewerStepLimitConfigurationError,
  resolveReviewerStepLimit,
} from './mandates-reviewer-criteria.js';

describe('reviewer step limit experiment', () => {
  it('defaults to 10 and accepts exactly the measured values', () => {
    expect(resolveReviewerStepLimit({})).toBe(10);
    expect(resolveReviewerStepLimit({ [REVIEWER_STEP_LIMIT_ENV]: '10' })).toBe(10);
    expect(resolveReviewerStepLimit({ [REVIEWER_STEP_LIMIT_ENV]: '12' })).toBe(12);
    expect(resolveReviewerStepLimit({ [REVIEWER_STEP_LIMIT_ENV]: '14' })).toBe(14);
  });

  it('rejects every other value with CONFIGURATION_INVALID', () => {
    for (const value of ['11', '13', '15', 'on', '']) {
      try {
        resolveReviewerStepLimit({ [REVIEWER_STEP_LIMIT_ENV]: value });
        throw new Error(`expected ${JSON.stringify(value)} to be rejected`);
      } catch (error) {
        expect(error).toBeInstanceOf(ReviewerStepLimitConfigurationError);
        expect((error as ReviewerStepLimitConfigurationError).code).toBe('CONFIGURATION_INVALID');
      }
    }
  });
});
