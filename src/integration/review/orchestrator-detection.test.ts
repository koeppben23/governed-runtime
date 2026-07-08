/**
 * @module integration/review/orchestrator-detection.test
 * @description Unit coverage for the review-required detection helpers that the
 * orchestrator re-exports. These guard the INDEPENDENT_REVIEW_REQUIRED gate and
 * the attestation-context extraction, so they are mutation-scoped: every branch
 * and return is exercised here so surviving mutants signal a real coverage gap.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 */

import { describe, it, expect } from 'vitest';
import { isReviewRequired, extractReviewContext } from './orchestrator-detection.js';
import { REVIEW_REQUIRED_PREFIX } from './enforcement/types.js';
import { TOOL_FLOWGUARD_PLAN, TOOL_FLOWGUARD_REVIEW } from '../tool-names.js';

const OTHER_TOOL = 'flowguard_implement';

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
    const out = JSON.stringify({ next: `prefixed ${REVIEW_REQUIRED_PREFIX}` });
    expect(isReviewRequired(out)).toBe(false);
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
    // Same payload, wrong tool name -> not a review-required signal.
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
    it('HAPPY: extracts attestation values and defaults iteration/planVersion to 1', () => {
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
    const fullObligation = {
      reviewObligation: {
        obligationId: 'ob-9',
        criteriaVersion: 'p37-v1',
        mandateDigest: 'digest-9',
        iteration: 2,
        planVersion: 3,
      },
    };

    it('HAPPY: extracts from a nested reviewObligation object', () => {
      expect(extractReviewContext(OTHER_TOOL, fullObligation)).toEqual({
        iteration: 2,
        planVersion: 3,
        obligationId: 'ob-9',
        criteriaVersion: 'p37-v1',
        mandateDigest: 'digest-9',
      });
    });

    it('CORNER: falls back to flat reviewObligation* fields when no nested object', () => {
      const out = {
        reviewObligationId: 'flat-ob',
        reviewCriteriaVersion: 'p37-v1',
        reviewMandateDigest: 'flat-digest',
        reviewObligationIteration: 4,
        reviewObligationPlanVersion: 5,
      };
      expect(extractReviewContext(OTHER_TOOL, out)).toEqual({
        iteration: 4,
        planVersion: 5,
        obligationId: 'flat-ob',
        criteriaVersion: 'p37-v1',
        mandateDigest: 'flat-digest',
      });
    });

    it('CORNER: parses iteration/planVersion from the next string when not in the obligation', () => {
      const out = {
        reviewObligation: {
          obligationId: 'ob-9',
          criteriaVersion: 'p37-v1',
          mandateDigest: 'digest-9',
        },
        next: 'INDEPENDENT_REVIEW_REQUIRED iteration=7 planVersion=8',
      };
      const result = extractReviewContext(OTHER_TOOL, out);
      expect(result?.iteration).toBe(7);
      expect(result?.planVersion).toBe(8);
    });

    it('BAD: returns null when obligationId is missing', () => {
      const out = {
        reviewObligation: {
          criteriaVersion: 'p37-v1',
          mandateDigest: 'd',
          iteration: 1,
          planVersion: 1,
        },
      };
      expect(extractReviewContext(OTHER_TOOL, out)).toBeNull();
    });

    it('BAD: returns null when criteriaVersion is missing', () => {
      const out = {
        reviewObligation: { obligationId: 'o', mandateDigest: 'd', iteration: 1, planVersion: 1 },
      };
      expect(extractReviewContext(OTHER_TOOL, out)).toBeNull();
    });

    it('BAD: returns null when mandateDigest is missing', () => {
      const out = {
        reviewObligation: {
          obligationId: 'o',
          criteriaVersion: 'p37-v1',
          iteration: 1,
          planVersion: 1,
        },
      };
      expect(extractReviewContext(OTHER_TOOL, out)).toBeNull();
    });

    it('BAD: returns null when iteration cannot be resolved from obligation or next', () => {
      const out = {
        reviewObligation: {
          obligationId: 'o',
          criteriaVersion: 'p37-v1',
          mandateDigest: 'd',
          planVersion: 1,
        },
        next: 'no numbers here',
      };
      expect(extractReviewContext(OTHER_TOOL, out)).toBeNull();
    });

    it('BAD: returns null when planVersion cannot be resolved', () => {
      const out = {
        reviewObligation: {
          obligationId: 'o',
          criteriaVersion: 'p37-v1',
          mandateDigest: 'd',
          iteration: 1,
        },
        next: 'iteration=1 only',
      };
      expect(extractReviewContext(OTHER_TOOL, out)).toBeNull();
    });

    it('EDGE: plan tool with mismatched selfReviewIteration returns null', () => {
      const out = {
        reviewObligation: {
          obligationId: 'ob-9',
          criteriaVersion: 'p37-v1',
          mandateDigest: 'digest-9',
          iteration: 2,
          planVersion: 3,
        },
        selfReviewIteration: 99,
      };
      expect(extractReviewContext(TOOL_FLOWGUARD_PLAN, out)).toBeNull();
    });

    it('EDGE: plan tool with matching selfReviewIteration succeeds', () => {
      const out = {
        reviewObligation: {
          obligationId: 'ob-9',
          criteriaVersion: 'p37-v1',
          mandateDigest: 'digest-9',
          iteration: 2,
          planVersion: 3,
        },
        selfReviewIteration: 2,
      };
      expect(extractReviewContext(TOOL_FLOWGUARD_PLAN, out)?.iteration).toBe(2);
    });

    it('EDGE: plan tool with no selfReviewIteration field is not gated', () => {
      expect(extractReviewContext(TOOL_FLOWGUARD_PLAN, fullObligation)?.obligationId).toBe('ob-9');
    });

    it('CORNER: a non-object reviewObligation is ignored in favor of flat fields', () => {
      const out = {
        reviewObligation: 'not-an-object',
        reviewObligationId: 'flat-ob',
        reviewCriteriaVersion: 'p37-v1',
        reviewMandateDigest: 'flat-digest',
        reviewObligationIteration: 1,
        reviewObligationPlanVersion: 1,
      };
      expect(extractReviewContext(OTHER_TOOL, out)?.obligationId).toBe('flat-ob');
    });

    it('CORNER: an array reviewObligation is ignored in favor of flat fields', () => {
      const out = {
        reviewObligation: [{ obligationId: 'nested-should-be-ignored' }],
        reviewObligationId: 'flat-ob',
        reviewCriteriaVersion: 'p37-v1',
        reviewMandateDigest: 'flat-digest',
        reviewObligationIteration: 1,
        reviewObligationPlanVersion: 1,
      };
      expect(extractReviewContext(OTHER_TOOL, out)?.obligationId).toBe('flat-ob');
    });

    it('EDGE: a non-plan tool ignores selfReviewIteration entirely (gate returns true)', () => {
      // selfReviewIteration mismatches the obligation iteration, but for a
      // non-plan tool the self-review gate must not apply, so extraction succeeds.
      const out = {
        reviewObligation: {
          obligationId: 'ob-9',
          criteriaVersion: 'p37-v1',
          mandateDigest: 'digest-9',
          iteration: 2,
          planVersion: 3,
        },
        selfReviewIteration: 99,
      };
      expect(extractReviewContext(OTHER_TOOL, out)?.iteration).toBe(2);
    });
  });
});
