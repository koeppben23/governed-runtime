/**
 * @module evidence-impl.test
 * @description Tests for evidence-impl module (v2 — candidate-bound evidence).
 * Extracted from evidence-split.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { ImplEvidence, ImplReviewResult } from './evidence-impl.js';
import { FIXED_TIME } from './evidence-test-constants.js';
import { ImplementationCandidate, computeCandidateDigest } from './evidence-candidate.js';
import type { RepositoryPath } from './evidence-review.js';

function makeTestCandidate(overrides?: {
  baseHeadSha?: string | null;
  changedPaths?: readonly string[];
  contentDigest?: string;
  diffDigest?: string;
}): ImplementationCandidate {
  const baseHeadSha = overrides?.baseHeadSha ?? 'a1b2c3d4e5f6789012345678abcdef0123456789';
  const changedPaths = (overrides?.changedPaths ?? [
    'src/auth.ts',
    'src/auth.test.ts',
  ]) as unknown as RepositoryPath[];
  const contentDigest = overrides?.contentDigest ?? 'content-sha256';
  const diffDigest = overrides?.diffDigest ?? 'diff-sha256';
  const candidateDigest = computeCandidateDigest({
    baseHeadSha,
    changedPaths,
    contentDigest,
    diffDigest,
  });
  return {
    version: 1,
    baseHeadSha,
    changedPaths,
    contentDigest,
    diffDigest,
    candidateDigest,
  };
}

const CANDIDATE = makeTestCandidate();

describe('evidence-impl', () => {
  describe('HAPPY', () => {
    it('ImplEvidence parses valid implementation with candidate', () => {
      const impl = {
        candidate: CANDIDATE,
        domainFiles: ['src/auth.ts'],
        executedAt: FIXED_TIME,
      };
      const parsed = ImplEvidence.parse(impl);
      expect(parsed.candidate.candidateDigest).toBe(CANDIDATE.candidateDigest);
      expect(parsed.domainFiles).toEqual(['src/auth.ts']);
      expect(parsed.executedAt).toBe(FIXED_TIME);
    });

    it('ImplReviewResult parses converged review', () => {
      const result = {
        iteration: 1,
        maxIterations: 3,
        prevDigest: null,
        currDigest: 'candidate-sha256',
        revisionDelta: 'none' as const,
        verdict: 'accept' as const,
        executedAt: FIXED_TIME,
      };
      expect(ImplReviewResult.parse(result)).toEqual(result);
    });

    it('ImplReviewResult parses changes_requested review', () => {
      const result = {
        iteration: 2,
        maxIterations: 5,
        prevDigest: 'candidate-old',
        currDigest: 'candidate-new',
        revisionDelta: 'major' as const,
        verdict: 'changes_requested' as const,
        executedAt: FIXED_TIME,
      };
      expect(ImplReviewResult.parse(result)).toEqual(result);
    });
  });

  describe('BAD', () => {
    it('ImplEvidence rejects missing candidate', () => {
      expect(() =>
        ImplEvidence.parse({
          domainFiles: ['file.ts'],
          executedAt: FIXED_TIME,
        }),
      ).toThrow();
    });

    it('ImplEvidence rejects extra field', () => {
      expect(() =>
        ImplEvidence.parse({
          candidate: CANDIDATE,
          domainFiles: ['file.ts'],
          executedAt: FIXED_TIME,
          changedFiles: ['file.ts'],
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
          verdict: 'accept',
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
          verdict: 'accept',
          executedAt: FIXED_TIME,
        }),
      ).toThrow();
    });
  });

  describe('CORNER', () => {
    it('ImplEvidence empty domainFiles is valid', () => {
      const impl = {
        candidate: CANDIDATE,
        domainFiles: [],
        executedAt: FIXED_TIME,
      };
      const parsed = ImplEvidence.parse(impl);
      expect(parsed.domainFiles).toEqual([]);
      expect(parsed.candidate.candidateDigest).toBe(CANDIDATE.candidateDigest);
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
