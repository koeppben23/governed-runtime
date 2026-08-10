/**
 * @module evidence-candidate.test
 * @description Tests for ImplementationCandidate schema and helpers.
 */

import { describe, it, expect } from 'vitest';
import {
  ImplementationCandidate,
  computeCandidateDigest,
  computeContentDigest,
  sameImplementationCandidate,
} from './evidence-candidate.js';
import type { RepositoryPath } from './evidence-review.js';

describe('evidence-candidate', () => {
  describe('HAPPY', () => {
    it('parses valid candidate', () => {
      const candidate = {
        version: 1 as const,
        baseHeadSha: 'a1b2c3d4e5f6789012345678abcdef0123456789',
        changedPaths: ['src/auth.ts', 'src/auth.test.ts'],
        contentDigest: 'content-sha256',
        diffDigest: 'diff-sha256',
        candidateDigest: 'candidate-sha256',
      };
      expect(ImplementationCandidate.parse(candidate)).toEqual(candidate);
    });

    it('parses candidate with null baseHeadSha (no HEAD)', () => {
      const candidate = {
        version: 1 as const,
        baseHeadSha: null,
        changedPaths: ['src/new.ts'],
        contentDigest: 'content-sha256',
        diffDigest: 'diff-sha256',
        candidateDigest: 'candidate-sha256',
      };
      expect(ImplementationCandidate.parse(candidate)).toEqual(candidate);
    });

    it('canonical changedPaths are normalized', () => {
      const candidate = {
        version: 1 as const,
        baseHeadSha: 'a1b2c3d4e5f6789012345678abcdef0123456789',
        changedPaths: ['src/b.ts', 'src/a.ts'],
        contentDigest: 'x',
        diffDigest: 'y',
        candidateDigest: 'z',
      };
      const parsed = ImplementationCandidate.parse(candidate);
      expect(parsed.changedPaths).toEqual(['src/b.ts', 'src/a.ts']);
    });

    it('computeCandidateDigest is deterministic', () => {
      const a = computeCandidateDigest({
        baseHeadSha: 'a1b2c3d4e5f6789012345678abcdef0123456789',
        changedPaths: ['src/b.ts', 'src/a.ts'] as RepositoryPath[],
        contentDigest: 'content',
        diffDigest: 'diff',
      });
      const b = computeCandidateDigest({
        baseHeadSha: 'a1b2c3d4e5f6789012345678abcdef0123456789',
        changedPaths: ['src/a.ts', 'src/b.ts'] as RepositoryPath[],
        contentDigest: 'content',
        diffDigest: 'diff',
      });
      expect(a).toBe(b);
    });

    it('computeCandidateDigest changes with different contentDigest', () => {
      const a = computeCandidateDigest({
        baseHeadSha: 'a1b2c3d4e5f6789012345678abcdef0123456789',
        changedPaths: ['src/a.ts'] as RepositoryPath[],
        contentDigest: 'content-v1',
        diffDigest: 'diff',
      });
      const b = computeCandidateDigest({
        baseHeadSha: 'a1b2c3d4e5f6789012345678abcdef0123456789',
        changedPaths: ['src/a.ts'] as RepositoryPath[],
        contentDigest: 'content-v2',
        diffDigest: 'diff',
      });
      expect(a).not.toBe(b);
    });

    it('computeCandidateDigest changes with different diffDigest', () => {
      const a = computeCandidateDigest({
        baseHeadSha: 'a1b2c3d4e5f6789012345678abcdef0123456789',
        changedPaths: ['src/a.ts'] as RepositoryPath[],
        contentDigest: 'content',
        diffDigest: 'diff-v1',
      });
      const b = computeCandidateDigest({
        baseHeadSha: 'a1b2c3d4e5f6789012345678abcdef0123456789',
        changedPaths: ['src/a.ts'] as RepositoryPath[],
        contentDigest: 'content',
        diffDigest: 'diff-v2',
      });
      expect(a).not.toBe(b);
    });

    it('computeCandidateDigest changes with different baseHeadSha', () => {
      const a = computeCandidateDigest({
        baseHeadSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        changedPaths: ['src/a.ts'] as RepositoryPath[],
        contentDigest: 'content',
        diffDigest: 'diff',
      });
      const b = computeCandidateDigest({
        baseHeadSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        changedPaths: ['src/a.ts'] as RepositoryPath[],
        contentDigest: 'content',
        diffDigest: 'diff',
      });
      expect(a).not.toBe(b);
    });

    it('computeContentDigest is deterministic', () => {
      const entries = [
        { path: 'src/b.ts' as RepositoryPath, state: 'present' as const, blobDigest: 'hash-b' },
        { path: 'src/a.ts' as RepositoryPath, state: 'present' as const, blobDigest: 'hash-a' },
      ];
      const a = computeContentDigest(entries);
      const b = computeContentDigest([...entries].reverse());
      expect(a).toBe(b);
    });

    it('computeContentDigest handles deleted state', () => {
      const entries = [
        { path: 'src/removed.ts' as RepositoryPath, state: 'deleted' as const, blobDigest: null },
        {
          path: 'src/modified.ts' as RepositoryPath,
          state: 'present' as const,
          blobDigest: 'hash-mod',
        },
      ];
      const digest = computeContentDigest(entries);
      expect(digest).toBeTruthy();
      expect(digest.length).toBe(64);
    });

    it('sameImplementationCandidate returns true for equal candidates', () => {
      const candidate = {
        version: 1 as const,
        baseHeadSha: 'a1b2c3d4e5f6789012345678abcdef0123456789',
        changedPaths: ['src/a.ts'] as readonly RepositoryPath[],
        contentDigest: 'content',
        diffDigest: 'diff',
        candidateDigest: 'same-digest',
      };
      expect(sameImplementationCandidate(candidate, candidate)).toBe(true);
    });

    it('sameImplementationCandidate returns false for different candidates', () => {
      const a = {
        version: 1 as const,
        baseHeadSha: 'a1b2c3d4e5f6789012345678abcdef0123456789',
        changedPaths: ['src/a.ts'] as readonly RepositoryPath[],
        contentDigest: 'content',
        diffDigest: 'diff',
        candidateDigest: 'digest-a',
      };
      const b = {
        version: 1 as const,
        baseHeadSha: 'a1b2c3d4e5f6789012345678abcdef0123456789',
        changedPaths: ['src/a.ts'] as readonly RepositoryPath[],
        contentDigest: 'content',
        diffDigest: 'diff',
        candidateDigest: 'digest-b',
      };
      expect(sameImplementationCandidate(a, b)).toBe(false);
    });

    it('artifact diff path does not affect candidateDigest', () => {
      const digest = computeCandidateDigest({
        baseHeadSha: 'a1b2c3d4e5f6789012345678abcdef0123456789',
        changedPaths: ['src/a.ts'] as RepositoryPath[],
        contentDigest: 'content',
        diffDigest: 'diff',
      });
      expect(digest).toHaveLength(64);
    });
  });

  describe('BAD', () => {
    it('rejects missing candidateDigest', () => {
      expect(() =>
        ImplementationCandidate.parse({
          version: 1,
          baseHeadSha: 'a1b2c3d4e5f6789012345678abcdef0123456789',
          changedPaths: ['src/a.ts'],
          contentDigest: 'content',
          diffDigest: 'diff',
        }),
      ).toThrow();
    });

    it('rejects missing snapshot', () => {
      expect(() =>
        ImplementationCandidate.parse({
          version: 1,
          changedPaths: ['src/a.ts'],
          contentDigest: 'content',
          diffDigest: 'diff',
          candidateDigest: 'digest',
        }),
      ).toThrow();
    });

    it('rejects absolute path', () => {
      expect(() =>
        ImplementationCandidate.parse({
          version: 1,
          baseHeadSha: 'a1b2c3d4e5f6789012345678abcdef0123456789',
          changedPaths: ['/absolute/path.ts'],
          contentDigest: 'content',
          diffDigest: 'diff',
          candidateDigest: 'digest',
        }),
      ).toThrow();
    });

    it('rejects root escape path', () => {
      expect(() =>
        ImplementationCandidate.parse({
          version: 1,
          baseHeadSha: 'a1b2c3d4e5f6789012345678abcdef0123456789',
          changedPaths: ['../../../escape.ts'],
          contentDigest: 'content',
          diffDigest: 'diff',
          candidateDigest: 'digest',
        }),
      ).toThrow();
    });

    it('rejects version != 1', () => {
      expect(() =>
        ImplementationCandidate.parse({
          version: 2,
          baseHeadSha: 'a1b2c3d4e5f6789012345678abcdef0123456789',
          changedPaths: ['src/a.ts'],
          contentDigest: 'content',
          diffDigest: 'diff',
          candidateDigest: 'digest',
        }),
      ).toThrow();
    });
  });

  describe('CORNER', () => {
    it('empty changedPaths is valid', () => {
      const candidate = {
        version: 1 as const,
        baseHeadSha: 'a1b2c3d4e5f6789012345678abcdef0123456789',
        changedPaths: [] as readonly RepositoryPath[],
        contentDigest: 'empty',
        diffDigest: 'empty',
        candidateDigest: 'empty-digest',
      };
      expect(ImplementationCandidate.parse(candidate)).toEqual(candidate);
    });
  });
});
