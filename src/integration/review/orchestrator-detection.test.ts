/**
 * @module integration/review/orchestrator-detection.test
 * @description Unit coverage for review-required detection and canonical review-context extraction.
 * @test-policy HAPPY, BAD, CORNER, EDGE
 */

import { describe, it, expect } from 'vitest';
import { isReviewRequired, extractReviewContext } from './orchestrator-detection.js';
import { REVIEW_REQUIRED_PREFIX } from './enforcement/types.js';
import { TOOL_FLOWGUARD_PLAN, TOOL_FLOWGUARD_REVIEW } from '../tool-names.js';

const OTHER_TOOL = 'flowguard_implement';

function canonicalObligation(overrides: Record<string, unknown> = {}) {
  return {
    reviewObligation: {
      obligationId: 'ob-9',
      criteriaVersion: 'p37-v1',
      mandateDigest: 'digest-9',
      iteration: 2,
      planVersion: 3,
      ...overrides,
    },
  };
}

describe('isReviewRequired', () => {
  it('HAPPY: returns true when next starts with the REVIEW_REQUIRED prefix', () => {
    const out = JSON.stringify({ next: `${REVIEW_REQUIRED_PREFIX}: do the review` });
    expect(isReviewRequired(out)).toBe(true);
  });

  it('HAPPY: returns true for flowguard_review CONTENT_ANALYSIS_REQUIRED with attestation object', () => {
    const out = JSON.stringify({
      error: true,
      code: 'CONTENT_ANALYSIS_REQUIRED',
      requiredReviewAttestation: { toolObligationId: 'o1' },
    });
    expect(isReviewRequired(out, TOOL_FLOWGUARD_REVIEW)).toBe(true);
  });

  it('BAD: returns false when output is not parseable', () => {
    expect(isReviewRequired('not json at all {')).toBe(false);
  });

  it('BAD: returns false when parsed result is an array', () => {
    expect(isReviewRequired(JSON.stringify([{ next: REVIEW_REQUIRED_PREFIX }]))).toBe(false);
  });

  it('CORNER: returns false when next is present but does not start with the prefix', () => {
    expect(isReviewRequired(JSON.stringify({ next: `prefixed ${REVIEW_REQUIRED_PREFIX}` }))).toBe(
      false,
    );
  });

  it('CORNER: returns false when next is not a string', () => {
    expect(isReviewRequired(JSON.stringify({ next: 123 }))).toBe(false);
  });

  it('EDGE: CONTENT_ANALYSIS_REQUIRED path requires the flowguard_review tool name', () => {
    const out = JSON.stringify({
      error: true,
      code: 'CONTENT_ANALYSIS_REQUIRED',
      requiredReviewAttestation: { toolObligationId: 'o1' },
    });
    expect(isReviewRequired(out, OTHER_TOOL)).toBe(false);
    expect(isReviewRequired(out, TOOL_FLOWGUARD_PLAN)).toBe(false);
  });

  it('EDGE: CONTENT_ANALYSIS_REQUIRED requires error===true', () => {
    const out = JSON.stringify({
      error: false,
      code: 'CONTENT_ANALYSIS_REQUIRED',
      requiredReviewAttestation: { toolObligationId: 'o1' },
    });
    expect(isReviewRequired(out, TOOL_FLOWGUARD_REVIEW)).toBe(false);
  });

  it('EDGE: CONTENT_ANALYSIS_REQUIRED requires the exact code', () => {
    const out = JSON.stringify({
      error: true,
      code: 'SOMETHING_ELSE',
      requiredReviewAttestation: { toolObligationId: 'o1' },
    });
    expect(isReviewRequired(out, TOOL_FLOWGUARD_REVIEW)).toBe(false);
  });

  it('EDGE: CONTENT_ANALYSIS_REQUIRED requires an object attestation', () => {
    const out = JSON.stringify({
      error: true,
      code: 'CONTENT_ANALYSIS_REQUIRED',
      requiredReviewAttestation: 'not-an-object',
    });
    expect(isReviewRequired(out, TOOL_FLOWGUARD_REVIEW)).toBe(false);
  });
});

describe('extractReviewContext', () => {
  describe('standalone /review path', () => {
    it('HAPPY: extracts attestation values and uses standalone iteration/version contract', () => {
      const out = {
        requiredReviewAttestation: {
          toolObligationId: 'ob-1',
          mandateDigest: 'digest-1',
          criteriaVersion: 'p37-v1',
        },
      };
      expect(extractReviewContext(TOOL_FLOWGUARD_REVIEW, out)).toEqual({
        iteration: 1,
        planVersion: 1,
        obligationId: 'ob-1',
        criteriaVersion: 'p37-v1',
        mandateDigest: 'digest-1',
      });
    });

    it('BAD: returns null when a required attestation field is missing', () => {
      const out = {
        requiredReviewAttestation: { toolObligationId: 'ob-1', mandateDigest: 'digest-1' },
      };
      expect(extractReviewContext(TOOL_FLOWGUARD_REVIEW, out)).toBeNull();
    });

    it('BAD: returns null when attestation is absent entirely', () => {
      expect(extractReviewContext(TOOL_FLOWGUARD_REVIEW, {})).toBeNull();
    });
  });

  describe('loop tool path (plan/implement/architecture)', () => {
    it('HAPPY: extracts exclusively from the canonical reviewObligation object', () => {
      expect(extractReviewContext(OTHER_TOOL, canonicalObligation())).toEqual({
        iteration: 2,
        planVersion: 3,
        obligationId: 'ob-9',
        criteriaVersion: 'p37-v1',
        mandateDigest: 'digest-9',
      });
    });

    it('BAD: does not synthesize authority from removed flat fields', () => {
      const out = {
        reviewObligationId: 'flat-ob',
        reviewCriteriaVersion: 'p37-v1',
        reviewMandateDigest: 'flat-digest',
        reviewObligationIteration: 4,
        reviewObligationPlanVersion: 5,
      };
      expect(extractReviewContext(OTHER_TOOL, out)).toBeNull();
    });

    it('BAD: does not parse iteration or planVersion from presentation text', () => {
      const out = {
        reviewObligation: {
          obligationId: 'ob-9',
          criteriaVersion: 'p37-v1',
          mandateDigest: 'digest-9',
        },
        next: 'INDEPENDENT_REVIEW_REQUIRED iteration=7 planVersion=8',
      };
      expect(extractReviewContext(OTHER_TOOL, out)).toBeNull();
    });

    it.each([
      ['obligationId', { obligationId: undefined }],
      ['criteriaVersion', { criteriaVersion: undefined }],
      ['mandateDigest', { mandateDigest: undefined }],
      ['iteration', { iteration: undefined }],
      ['planVersion', { planVersion: undefined }],
    ])('BAD: returns null when canonical %s is missing', (_field, override) => {
      expect(extractReviewContext(OTHER_TOOL, canonicalObligation(override))).toBeNull();
    });

    it('BAD: rejects non-object reviewObligation even when legacy flat fields are present', () => {
      const out = {
        reviewObligation: 'not-an-object',
        reviewObligationId: 'flat-ob',
        reviewCriteriaVersion: 'p37-v1',
        reviewMandateDigest: 'flat-digest',
        reviewObligationIteration: 1,
        reviewObligationPlanVersion: 1,
      };
      expect(extractReviewContext(OTHER_TOOL, out)).toBeNull();
    });

    it('BAD: rejects array reviewObligation even when legacy flat fields are present', () => {
      const out = {
        reviewObligation: [{ obligationId: 'nested-should-be-ignored' }],
        reviewObligationId: 'flat-ob',
        reviewCriteriaVersion: 'p37-v1',
        reviewMandateDigest: 'flat-digest',
        reviewObligationIteration: 1,
        reviewObligationPlanVersion: 1,
      };
      expect(extractReviewContext(OTHER_TOOL, out)).toBeNull();
    });

    it('EDGE: plan tool with mismatched selfReviewIteration returns null', () => {
      expect(
        extractReviewContext(TOOL_FLOWGUARD_PLAN, {
          ...canonicalObligation(),
          selfReviewIteration: 99,
        }),
      ).toBeNull();
    });

    it('EDGE: plan tool with matching selfReviewIteration succeeds', () => {
      expect(
        extractReviewContext(TOOL_FLOWGUARD_PLAN, {
          ...canonicalObligation(),
          selfReviewIteration: 2,
        })?.iteration,
      ).toBe(2);
    });

    it('EDGE: plan tool with no selfReviewIteration field is not additionally gated', () => {
      expect(extractReviewContext(TOOL_FLOWGUARD_PLAN, canonicalObligation())?.obligationId).toBe(
        'ob-9',
      );
    });

    it('EDGE: a non-plan tool ignores selfReviewIteration entirely', () => {
      expect(
        extractReviewContext(OTHER_TOOL, {
          ...canonicalObligation(),
          selfReviewIteration: 99,
        })?.iteration,
      ).toBe(2);
    });
  });
});
