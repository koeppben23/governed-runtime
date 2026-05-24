/**
 * @module evidence-plan.test
 * @description Tests for evidence-plan module.
 * Extracted from evidence-split.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { PlanEvidence, PlanRecord, SelfReviewLoop } from './evidence-plan.js';
import { FIXED_TIME } from './evidence-test-constants.js';

describe('evidence-plan', () => {
  describe('HAPPY', () => {
    it('PlanEvidence parses valid plan', () => {
      const plan = {
        body: '## Plan\nStep 1: Fix auth\nStep 2: Add tests',
        digest: 'sha256-plan',
        sections: ['Plan'],
        createdAt: FIXED_TIME,
      };
      expect(PlanEvidence.parse(plan)).toEqual(plan);
    });

    it('PlanRecord parses record with history', () => {
      const current = {
        body: '## Plan v2',
        digest: 'digest-v2',
        sections: ['Plan'],
        createdAt: FIXED_TIME,
      };
      const record = { current, history: [] };
      expect(PlanRecord.parse(record)).toEqual(record);
    });

    it('PlanRecord with empty history is valid', () => {
      const record = {
        current: { body: 'Plan', digest: 'abc', sections: [], createdAt: FIXED_TIME },
        history: [],
      };
      expect(PlanRecord.parse(record)).toEqual(record);
    });

    it('SelfReviewLoop parses converged state', () => {
      const loop = {
        iteration: 1,
        maxIterations: 3,
        prevDigest: null,
        currDigest: 'digest-of-plan',
        revisionDelta: 'none' as const,
        verdict: 'approve' as const,
      };
      expect(SelfReviewLoop.parse(loop)).toEqual(loop);
    });

    it('SelfReviewLoop parses pending state', () => {
      const loop = {
        iteration: 2,
        maxIterations: 5,
        prevDigest: 'digest-v1',
        currDigest: 'digest-v2',
        revisionDelta: 'minor' as const,
        verdict: 'changes_requested' as const,
      };
      expect(SelfReviewLoop.parse(loop)).toEqual(loop);
    });
  });

  describe('BAD', () => {
    it('PlanEvidence rejects empty body', () => {
      expect(() =>
        PlanEvidence.parse({
          body: '',
          digest: 'abc',
          sections: [],
          createdAt: FIXED_TIME,
        }),
      ).toThrow();
    });

    it('SelfReviewLoop rejects negative iteration', () => {
      expect(() =>
        SelfReviewLoop.parse({
          iteration: -1,
          maxIterations: 3,
          prevDigest: null,
          currDigest: 'abc',
          revisionDelta: 'none',
          verdict: 'approve',
        }),
      ).toThrow();
    });

    it('SelfReviewLoop rejects zero maxIterations', () => {
      expect(() =>
        SelfReviewLoop.parse({
          iteration: 0,
          maxIterations: 0,
          prevDigest: null,
          currDigest: 'abc',
          revisionDelta: 'none',
          verdict: 'approve',
        }),
      ).toThrow();
    });
  });

  describe('CORNER', () => {
    it('PlanEvidence with empty sections array is valid', () => {
      const plan = {
        body: 'No headers here',
        digest: 'abc',
        sections: [],
        createdAt: FIXED_TIME,
      };
      expect(PlanEvidence.parse(plan)).toEqual(plan);
    });

    it('PlanRecord rejects missing history', () => {
      expect(() =>
        PlanRecord.parse({
          current: { body: 'Plan', digest: 'abc', sections: [], createdAt: FIXED_TIME },
        }),
      ).toThrow();
    });
  });

  describe('EDGE', () => {
    it('SelfReviewLoop prevDigest can be null on first iteration', () => {
      const loop = {
        iteration: 0,
        maxIterations: 3,
        prevDigest: null,
        currDigest: 'abc',
        revisionDelta: 'none',
        verdict: 'approve',
      };
      expect(SelfReviewLoop.parse(loop)).toEqual(loop);
    });
  });
});
