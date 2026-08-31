/**
 * @module evidence-plan.test
 * @description Tests for evidence-plan module.
 * Extracted from evidence-split.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  PlanEvidence,
  PlanRecord,
  resolvePlanReviewCompletion,
  SelfReviewLoop,
} from './evidence-plan.js';
import { FIXED_TIME } from './evidence-test-constants.js';

describe('evidence-plan', () => {
  describe('HAPPY', () => {
    it('PlanEvidence parses valid plan', () => {
      const plan = {
        body: '## Plan\nStep 1: Fix auth\nStep 2: Add tests',
        digest: 'sha256-plan',
        sections: ['Plan'],
        createdAt: FIXED_TIME,
        recordDigest: 'record-digest',
        planVersion: 1,
        supersedesRecordDigest: null,
        originatingReviewObligationId: null,
        revisionReason: null,
        lineageStatus: 'verified' as const,
      };
      const parsed = PlanEvidence.parse(plan);
      expect(parsed.body).toBe(plan.body);
      expect(parsed.digest).toBe(plan.digest);
      expect(parsed.sections).toEqual(plan.sections);
      expect(parsed.createdAt).toBe(plan.createdAt);
      expect(parsed.planVersion).toBe(1);
      expect(parsed.supersedesRecordDigest).toBeNull();
      expect(parsed.lineageStatus).toBe('verified');
    });

    it('PlanRecord parses record with history', () => {
      const current = {
        body: '## Plan v2',
        digest: 'digest-v2',
        sections: ['Plan'],
        createdAt: FIXED_TIME,
        recordDigest: 'record-v2',
        planVersion: 2,
        supersedesRecordDigest: null,
        originatingReviewObligationId: null,
        revisionReason: null,
        lineageStatus: 'verified' as const,
      };
      const record = { current, history: [] };
      expect(PlanRecord.parse(record).current).toMatchObject(current);
    });

    it('PlanRecord with empty history is valid', () => {
      const current = {
        body: 'Plan',
        digest: 'abc',
        sections: [],
        createdAt: FIXED_TIME,
        recordDigest: 'record',
        planVersion: 1,
        supersedesRecordDigest: null,
        originatingReviewObligationId: null,
        revisionReason: null,
        lineageStatus: 'verified' as const,
      };
      const record = { current, history: [] };
      expect(PlanRecord.parse(record).current).toMatchObject(current);
    });

    it('SelfReviewLoop parses converged state', () => {
      const loop = {
        iteration: 1,
        maxIterations: 3,
        prevDigest: null,
        currDigest: 'digest-of-plan',
        revisionDelta: 'none' as const,
        verdict: 'accept' as const,
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
          recordDigest: 'record',
          planVersion: 1,
          supersedesRecordDigest: null,
          originatingReviewObligationId: null,
          revisionReason: null,
          lineageStatus: 'verified',
        }),
      ).toThrow();
    });

    it('PlanEvidence rejects a version missing its lineage (no legacy defaulting)', () => {
      expect(() =>
        PlanEvidence.parse({
          body: 'Plan',
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
          verdict: 'accept',
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
          verdict: 'accept',
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
        recordDigest: 'record',
        planVersion: 1,
        supersedesRecordDigest: null,
        originatingReviewObligationId: null,
        revisionReason: null,
        lineageStatus: 'verified' as const,
      };
      const parsed = PlanEvidence.parse(plan);
      expect(parsed.body).toBe(plan.body);
      expect(parsed.digest).toBe(plan.digest);
      expect(parsed.planVersion).toBe(1);
    });

    it('PlanRecord rejects missing history', () => {
      expect(() =>
        PlanRecord.parse({
          current: {
            body: 'Plan',
            digest: 'abc',
            sections: [],
            createdAt: FIXED_TIME,
            recordDigest: 'record',
            planVersion: 1,
            supersedesRecordDigest: null,
            originatingReviewObligationId: null,
            revisionReason: null,
            lineageStatus: 'verified',
          },
        }),
      ).toThrow();
    });
  });

  describe('EDGE', () => {
    it('does not classify unable_to_review at the iteration limit as review_exhausted', () => {
      expect(resolvePlanReviewCompletion(3, 3, 'none', 'unable_to_review')).toBe('pending');
    });

    it('SelfReviewLoop prevDigest can be null on first iteration', () => {
      const loop = {
        iteration: 0,
        maxIterations: 3,
        prevDigest: null,
        currDigest: 'abc',
        revisionDelta: 'none',
        verdict: 'accept',
      };
      expect(SelfReviewLoop.parse(loop)).toEqual(loop);
    });
  });
});
