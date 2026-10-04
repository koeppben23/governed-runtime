import { describe, expect, it } from 'vitest';
import {
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
  isCurrentReviewGeneration,
} from './assurance.js';

describe('review generation authority', () => {
  it('accepts exactly the active criteria generation', () => {
    expect(
      isCurrentReviewGeneration({
        criteriaVersion: REVIEW_CRITERIA_VERSION,
        mandateDigest: REVIEW_MANDATE_DIGEST,
      }),
    ).toBe(true);
  });

  it('rejects a stale criteria version', () => {
    expect(
      isCurrentReviewGeneration({
        criteriaVersion: 'p41-v1',
        mandateDigest: REVIEW_MANDATE_DIGEST,
      }),
    ).toBe(false);
  });

  it('rejects a stale mandate digest', () => {
    expect(
      isCurrentReviewGeneration({
        criteriaVersion: REVIEW_CRITERIA_VERSION,
        mandateDigest: 'sha256:stale-generation',
      }),
    ).toBe(false);
  });
});
