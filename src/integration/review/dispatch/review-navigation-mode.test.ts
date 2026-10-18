/**
 * @module integration/review/review-navigation-mode.test
 * @description Strict experiment flag: unset/off/on only; any other value is a
 * configuration failure, never a silent baseline run.
 */

import { describe, expect, it } from 'vitest';
import { IntegrationInvariantError } from '../../errors.js';
import { REVIEW_NAVIGATION_ENV, resolveReviewNavigationMode } from './review-navigation-mode.js';

describe('review navigation mode', () => {
  it('defaults to off and accepts the exact on/off values', () => {
    expect(resolveReviewNavigationMode({})).toBe('off');
    expect(resolveReviewNavigationMode({ [REVIEW_NAVIGATION_ENV]: 'off' })).toBe('off');
    expect(resolveReviewNavigationMode({ [REVIEW_NAVIGATION_ENV]: 'on' })).toBe('on');
  });

  it('rejects every other value with CONFIGURATION_INVALID', () => {
    for (const value of ['enabled', 'ON', 'true', '0', '']) {
      try {
        resolveReviewNavigationMode({ [REVIEW_NAVIGATION_ENV]: value });
        throw new Error(`expected ${JSON.stringify(value)} to be rejected`);
      } catch (error) {
        expect(error).toBeInstanceOf(IntegrationInvariantError);
        expect((error as IntegrationInvariantError).code).toBe('CONFIGURATION_INVALID');
      }
    }
  });
});
