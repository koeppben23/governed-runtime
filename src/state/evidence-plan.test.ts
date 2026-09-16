/**
 * @module evidence-plan.test
 * @description Tests for evidence-plan module.
 * Extracted from evidence-split.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  PlanEvidence,
  PlanRecord,
  computeRecordDigest,
  resolvePlanReviewCompletion,
  SelfReviewLoop,
} from './evidence-plan.js';
import { FIXED_TIME, makePlanRevision, makePlanRevisionAfter } from './evidence-test-constants.js';

describe('evidence-plan', () => {
  describe('HAPPY', () => {
    it('PlanEvidence parses a coherent revision', () => {
      const plan = makePlanRevision({ body: '## Plan\nStep 1: Fix auth\nStep 2: Add tests' });
      const parsed = PlanEvidence.parse(plan);
      expect(parsed.body).toBe(plan.body);
      expect(parsed.digest).toBe(plan.digest);
      expect(parsed.sections).toEqual(plan.sections);
      expect(parsed.createdAt).toBe(plan.createdAt);
      expect(parsed.revisionId).toBe(plan.revisionId);
      expect(parsed.planVersion).toBe(1);
      expect(parsed.supersedesRecordDigest).toBeNull();
      expect(parsed.lineageStatus).toBe('verified');
    });

    it('PlanRecord parses a coherent chain with history', () => {
      const v1 = makePlanRevision({ body: '## Plan v1', createdAt: FIXED_TIME });
      const v2 = makePlanRevisionAfter(v1, {
        body: '## Plan v2',
        createdAt: '2026-01-01T00:00:01.000Z',
      });
      const record = { current: v2, history: [v1], reviewCompletion: 'pending' as const };
      const parsed = PlanRecord.parse(record);
      expect(parsed.current).toMatchObject(v2);
      expect(parsed.history[0]).toMatchObject(v1);
    });

    it('PlanRecord with empty history is valid', () => {
      const current = makePlanRevision({ body: 'Plan' });
      const record = { current, history: [], reviewCompletion: 'pending' as const };
      expect(PlanRecord.parse(record).current).toMatchObject(current);
    });

    it('PlanRecord history order does not affect lineage coherence', () => {
      const v1 = makePlanRevision({ body: '## Plan v1', createdAt: FIXED_TIME });
      const v2 = makePlanRevisionAfter(v1, {
        body: '## Plan v2',
        createdAt: '2026-01-01T00:00:01.000Z',
      });
      const v3 = makePlanRevisionAfter(v2, {
        body: '## Plan v3',
        createdAt: '2026-01-01T00:00:02.000Z',
      });
      const newestFirst = { current: v3, history: [v2, v1], reviewCompletion: 'pending' as const };
      const oldestFirst = { current: v3, history: [v1, v2], reviewCompletion: 'pending' as const };
      expect(PlanRecord.parse(newestFirst).history).toHaveLength(2);
      expect(PlanRecord.parse(oldestFirst).history).toHaveLength(2);
    });

    it('SelfReviewLoop parses converged state', () => {
      const loop = {
        iteration: 1,
        reviewCycle: 1,
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
        reviewCycle: 2,
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
      expect(() => PlanEvidence.parse({ ...makePlanRevision({ body: '' }), body: '' })).toThrow();
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

    it('PlanRecord rejects a digest that does not match hashText(body)', () => {
      const current = { ...makePlanRevision({ body: 'Plan' }), digest: 'not-the-body-hash' };
      expect(() => PlanRecord.parse({ current, history: [], reviewCompletion: 'pending' })).toThrow(
        /digest does not match hashText\(body\)/,
      );
    });

    it('PlanRecord rejects a recordDigest that does not match computeRecordDigest(...)', () => {
      const current = {
        ...makePlanRevision({ body: 'Plan' }),
        recordDigest: 'wrong-record-digest',
      };
      expect(() => PlanRecord.parse({ current, history: [], reviewCompletion: 'pending' })).toThrow(
        /recordDigest does not match computeRecordDigest/,
      );
    });

    it('PlanRecord rejects a non-contiguous lineage (v2 without v1)', () => {
      const v2 = makePlanRevision({ body: '## Plan v2', planVersion: 2 });
      expect(() =>
        PlanRecord.parse({ current: v2, history: [], reviewCompletion: 'pending' }),
      ).toThrow(/not contiguous/);
    });

    it('PlanRecord rejects a broken supersedes link', () => {
      const v1 = makePlanRevision({ body: '## Plan v1' });
      // Internally consistent record digest, but supersedes a digest that is
      // not the predecessor's record digest.
      const v2 = makePlanRevision({
        body: '## Plan v2',
        planVersion: 2,
        supersedesRecordDigest: 'a'.repeat(64),
      });
      expect(() =>
        PlanRecord.parse({ current: v2, history: [v1], reviewCompletion: 'pending' }),
      ).toThrow(/chain is broken at v2/);
    });

    it('PlanRecord rejects a v1 that supersedes a predecessor', () => {
      const badV1 = makePlanRevision({
        body: '## Plan v1',
        supersedesRecordDigest: 'a'.repeat(64),
      });
      expect(() =>
        PlanRecord.parse({ current: badV1, history: [], reviewCompletion: 'pending' }),
      ).toThrow(/chain is broken at v1/);
    });

    it('PlanRecord rejects a current revision that is not the lineage head', () => {
      const v1 = makePlanRevision({ body: '## Plan v1' });
      const v2 = makePlanRevisionAfter(v1, { body: '## Plan v2' });
      expect(() =>
        PlanRecord.parse({ current: v1, history: [v2], reviewCompletion: 'pending' }),
      ).toThrow(/not the lineage head/);
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
      const plan = makePlanRevision({ body: 'No headers here' });
      const parsed = PlanEvidence.parse(plan);
      expect(parsed.body).toBe(plan.body);
      expect(parsed.digest).toBe(plan.digest);
      expect(parsed.planVersion).toBe(1);
    });

    it('PlanRecord rejects missing history', () => {
      expect(() =>
        PlanRecord.parse({
          current: makePlanRevision({ body: 'Plan' }),
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
        reviewCycle: 1,
        maxIterations: 3,
        prevDigest: null,
        currDigest: 'abc',
        revisionDelta: 'none',
        verdict: 'accept',
      };
      expect(SelfReviewLoop.parse(loop)).toEqual(loop);
    });
  });

  describe('RECORD DIGEST STABILITY', () => {
    const input = {
      contentDigest: 'content-digest',
      planVersion: 3,
      supersedesRecordDigest: 'predecessor-record-digest',
      originatingReviewObligationId: '00000000-0000-4000-8000-000000000001',
      revisionReason: 'Review requested changes',
      revisionId: '00000000-0000-4000-8000-000000000002',
    };

    it('recomputes to the same digest regardless of property order', () => {
      expect(computeRecordDigest(input)).toBe(
        computeRecordDigest({
          revisionId: input.revisionId,
          revisionReason: input.revisionReason,
          originatingReviewObligationId: input.originatingReviewObligationId,
          supersedesRecordDigest: input.supersedesRecordDigest,
          planVersion: input.planVersion,
          contentDigest: input.contentDigest,
        }),
      );
    });

    it('changes when the revisionId changes', () => {
      expect(computeRecordDigest(input)).not.toBe(
        computeRecordDigest({ ...input, revisionId: '00000000-0000-4000-8000-000000000003' }),
      );
    });
  });
});
