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

  it('rejects the immediately prior criteria generation after the #1081 criteria expansion', () => {
    // Guards that a semantic criteria change actually advanced the generation:
    // an obligation minted under the previous text must not keep dispatching
    // with the new reviewer semantics.
    expect(REVIEW_CRITERIA_VERSION).not.toBe('p42-v1');
    expect(
      isCurrentReviewGeneration({
        criteriaVersion: 'p42-v1',
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
