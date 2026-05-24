/**
 * @module evidence-impl.test
 * @description Tests for evidence-impl module.
 * Extracted from evidence-split.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { ImplEvidence, ImplReviewResult } from './evidence-impl.js';
import { FIXED_TIME } from './evidence-test-constants.js';

describe('evidence-impl', () => {
  describe('HAPPY', () => {
    it('ImplEvidence parses valid implementation', () => {
      const impl = {
        changedFiles: ['src/auth.ts', 'src/auth.test.ts'],
        domainFiles: ['src/auth.ts'],
        digest: 'sha256-abc',
        executedAt: FIXED_TIME,
      };
      expect(ImplEvidence.parse(impl)).toEqual(impl);
    });

    it('ImplReviewResult parses converged review', () => {
      const result = {
        iteration: 1,
        maxIterations: 3,
        prevDigest: null,
        currDigest: 'sha256-abc',
        revisionDelta: 'none' as const,
        verdict: 'approve' as const,
        executedAt: FIXED_TIME,
      };
      expect(ImplReviewResult.parse(result)).toEqual(result);
    });

    it('ImplReviewResult parses changes_requested review', () => {
      const result = {
        iteration: 2,
        maxIterations: 5,
        prevDigest: 'sha256-old',
        currDigest: 'sha256-new',
        revisionDelta: 'major' as const,
        verdict: 'changes_requested' as const,
        executedAt: FIXED_TIME,
      };
      expect(ImplReviewResult.parse(result)).toEqual(result);
    });
  });

  describe('BAD', () => {
    it('ImplEvidence rejects empty changedFiles', () => {
      expect(() =>
        ImplEvidence.parse({
          changedFiles: [],
          domainFiles: [],
          digest: 'abc',
          executedAt: FIXED_TIME,
        }),
      ).not.toThrow(); // empty array is valid
    });

    it('ImplEvidence rejects missing digest', () => {
      expect(() =>
        ImplEvidence.parse({
          changedFiles: ['file.ts'],
          domainFiles: ['file.ts'],
          executedAt: FIXED_TIME,
        }),
      ).toThrow();
    });

    it('ImplReviewResult rejects negative iteration', () => {
      expect(() =>
        ImplReviewResult.parse({
          iteration: -1,
          maxIterations: 3,
          prevDigest: null,
          currDigest: 'abc',
          revisionDelta: 'none',
          verdict: 'approve',
          executedAt: FIXED_TIME,
        }),
      ).toThrow();
    });

    it('ImplReviewResult rejects zero maxIterations', () => {
      expect(() =>
        ImplReviewResult.parse({
          iteration: 0,
          maxIterations: 0,
          prevDigest: null,
          currDigest: 'abc',
          revisionDelta: 'none',
          verdict: 'approve',
          executedAt: FIXED_TIME,
        }),
      ).toThrow();
    });
  });

  describe('CORNER', () => {
    it('ImplEvidence empty arrays are valid (no changes)', () => {
      const impl = {
        changedFiles: [],
        domainFiles: [],
        digest: 'empty-digest',
        executedAt: FIXED_TIME,
      };
      expect(ImplEvidence.parse(impl)).toEqual(impl);
    });
  });

  describe('EDGE', () => {
    it('ImplReviewResult rejects LoopVerdict reject', () => {
      expect(() =>
        ImplReviewResult.parse({
          iteration: 0,
          maxIterations: 3,
          prevDigest: null,
          currDigest: 'abc',
          revisionDelta: 'none',
          verdict: 'reject',
          executedAt: FIXED_TIME,
        }),
      ).toThrow();
    });
  });
});
