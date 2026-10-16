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

  it('rejects p42-v2 obligations after the plan-review verification authority change', () => {
    // The plan criteria now bind check authority to the persisted verification
    // candidates and separate plan review from later validation. Obligations
    // minted under p42-v2 must not dispatch under the new semantics; recovery
    // is a fresh obligation, never re-stamping the old one.
    expect(REVIEW_CRITERIA_VERSION).not.toBe('p42-v2');
    expect(
      isCurrentReviewGeneration({
        criteriaVersion: 'p42-v2',
        mandateDigest: REVIEW_MANDATE_DIGEST,
      }),
    ).toBe(false);
  });

  it('rejects p42-v3 obligations after the plan evidence-role and blocking-bar change', () => {
    // The plan criteria now state the evidence-role rule once (overlapping
    // suites of different checks are admissible) and carry the blocking-issue
    // bar. Obligations minted under p42-v3 fail closed.
    expect(REVIEW_CRITERIA_VERSION).toBe('p42-v4');
    expect(
      isCurrentReviewGeneration({
        criteriaVersion: 'p42-v3',
        mandateDigest: REVIEW_MANDATE_DIGEST,
      }),
    ).toBe(false);
    expect(
      isCurrentReviewGeneration({
        criteriaVersion: 'p42-v4',
        mandateDigest: REVIEW_MANDATE_DIGEST,
      }),
    ).toBe(true);
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
