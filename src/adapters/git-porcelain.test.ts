/**
 * @module adapters/git-porcelain.test
 * @description Unit tests for parsePorcelainZ — the `git status --porcelain=v1 -z`
 * parser used by changedFiles. Guards against the first-path corruption
 * (e.g. " M src/..." -> "rc/...") that the previous trimmed, fixed-offset
 * newline parser produced for worktree-only changes, and covers renames,
 * untracked files, special-character paths, and empty output.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 */

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { parsePorcelainZ } from './git.js';

/** Build a NUL-delimited `-z` porcelain blob from raw records (no trailing NUL added between joins beyond the separators). */
function z(...records: string[]): string {
  // `-z` separates every field with a single NUL and has no trailing newline.
  // git emits a trailing NUL after the last record; include it to mirror reality.
  return records.join('\0') + '\0';
}

/** Normalize expected paths to the OS separator, matching parsePorcelainZ output. */
function norm(...paths: string[]): string[] {
  return paths.map((p) => path.normalize(p));
}

describe('parsePorcelainZ', () => {
  describe('HAPPY', () => {
    it('parses a worktree-only modification without losing the first char (src stays src)', () => {
      // Index column blank, worktree column M: " M <path>". This is the exact
      // shape that previously corrupted to "rc/..." via trim()+slice(3).
      const raw = z(' M src/main/java/com/example/TaskService.java');
      expect(parsePorcelainZ(raw)).toEqual(norm('src/main/java/com/example/TaskService.java'));
    });

    it('parses the exact demo three-file set with all paths intact', () => {
      const raw = z(
        ' M src/main/java/com/example/taskmanager/service/TaskService.java',
        'A  opencode.json',
        '?? src/test/java/com/example/taskmanager/controller/TaskControllerTest.java',
      );
      expect(parsePorcelainZ(raw)).toEqual(
        norm(
          'src/main/java/com/example/taskmanager/service/TaskService.java',
          'opencode.json',
          'src/test/java/com/example/taskmanager/controller/TaskControllerTest.java',
        ),
      );
    });

    it('parses staged add (index column set)', () => {
      expect(parsePorcelainZ(z('A  opencode.json'))).toEqual(norm('opencode.json'));
    });

    it('parses untracked files (??)', () => {
      expect(parsePorcelainZ(z('?? scripts/new-file.js'))).toEqual(norm('scripts/new-file.js'));
    });

    it('parses staged-and-worktree modification (MM)', () => {
      expect(parsePorcelainZ(z('MM src/state/schema.ts'))).toEqual(norm('src/state/schema.ts'));
    });
  });

  describe('CORNER', () => {
    it('parses a rename: includes BOTH new and old paths (no ` -> ` in -z)', () => {
      // -z rename: "R  <new>" then the old path as the next NUL field.
      const raw = z('R  src/new/Name.ts', 'src/old/Name.ts');
      expect(parsePorcelainZ(raw)).toEqual(norm('src/new/Name.ts', 'src/old/Name.ts'));
    });

    it('parses a copy (C) the same way as a rename', () => {
      const raw = z('C  src/copy/Dest.ts', 'src/copy/Src.ts');
      expect(parsePorcelainZ(raw)).toEqual(norm('src/copy/Dest.ts', 'src/copy/Src.ts'));
    });

    it('parses a worktree-side rename whose new path starts with s without corruption', () => {
      const raw = z('R  src/main/Service.java', 'src/main/OldService.java');
      expect(parsePorcelainZ(raw)).toEqual(
        norm('src/main/Service.java', 'src/main/OldService.java'),
      );
    });

    it('does not split a path that literally contains " -> "', () => {
      // The legacy newline parser split on ' -> '; -z + status-prefix parsing
      // treats the whole field as one path.
      const raw = z(' M src/weird -> path/file.ts');
      expect(parsePorcelainZ(raw)).toEqual(norm('src/weird -> path/file.ts'));
    });

    it('handles paths with spaces verbatim (no quoting in -z)', () => {
      const raw = z(' M src/dir with spaces/My File.ts');
      expect(parsePorcelainZ(raw)).toEqual(norm('src/dir with spaces/My File.ts'));
    });
  });

  describe('EDGE', () => {
    it('returns [] for empty output (clean tree)', () => {
      expect(parsePorcelainZ('')).toEqual([]);
    });

    it('returns [] for a blob of only NUL separators', () => {
      expect(parsePorcelainZ('\0\0')).toEqual([]);
    });

    it('skips malformed records shorter than a status+space+char', () => {
      // " M" alone (3 chars, no path) is not a valid record.
      const raw = z(' M', ' M src/real.ts');
      expect(parsePorcelainZ(raw)).toEqual(norm('src/real.ts'));
    });

    it('parses many mixed records preserving every first character', () => {
      const raw = z(
        ' M src/a.ts',
        ' D src/b.ts',
        'A  staged.ts',
        '?? untracked.ts',
        'R  src/renamed-new.ts',
        'src/renamed-old.ts',
      );
      expect(parsePorcelainZ(raw)).toEqual(
        norm(
          'src/a.ts',
          'src/b.ts',
          'staged.ts',
          'untracked.ts',
          'src/renamed-new.ts',
          'src/renamed-old.ts',
        ),
      );
    });
  });

  describe('BAD', () => {
    it('ignores a trailing empty field without emitting an empty path', () => {
      const raw = ' M src/only.ts\0';
      const result = parsePorcelainZ(raw);
      expect(result).toEqual(norm('src/only.ts'));
      expect(result).not.toContain('');
    });

    it('a rename record missing its old-path field still yields the new path', () => {
      // Truncated stream: "R  <new>" with no following old field.
      const raw = 'R  src/new-only.ts\0';
      expect(parsePorcelainZ(raw)).toEqual(norm('src/new-only.ts'));
    });
  });
});
