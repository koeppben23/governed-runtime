import { describe, expect, it } from 'vitest';
import {
  canonicalRepoRelativePath,
  normalizeRepoRelativePath,
  matchesRepositoryGlob,
} from './repo-path.js';

describe('canonical repository-relative path identity', () => {
  it.each(['src/file.ts', '././src/file.ts', 'src/tmp/../file.ts', 'src\\file.ts', 'src/file.ts/'])(
    'compares in-worktree alias %s canonically',
    (path) => {
      expect(canonicalRepoRelativePath(path)).toBe('src/file.ts');
    },
  );
  it.each([
    '',
    '.',
    '..',
    '../file.ts',
    'src/../../file.ts',
    '/file.ts',
    '\\file.ts',
    'C:/file.ts',
    'c:file.ts',
    'a\0b',
  ])('rejects non-relative identity %s', (path) => {
    expect(canonicalRepoRelativePath(path)).toBeNull();
  });
  it('does not change presentation-only normalization semantics', () => {
    expect(normalizeRepoRelativePath('././src/../file.ts')).toBe('./src/../file.ts');
  });
});

describe('repository glob segment boundaries', () => {
  it.each([
    ['a*b', 'ab', true],
    ['a*b', 'axb', true],
    ['a*b', 'a/x/b', false],
    ['*', '', true],
    ['a*', '', false],
    ['', '', true],
    ['a', '', false],
    ['', 'a', false],
    ['ab', 'cb', false],
    ['a*b', 'a', false],
    ['**/file', 'file', true],
    ['src/**/file', 'src/file', true],
    ['src/**/file', 'src/a/b/file', true],
    ['src/*/file', 'src/file', false],
    ['src/*/file', 'src/a/b/file', false],
    ['**', 'src/file', true],
    ['src/**', 'other', false],
  ] as const)('matches %s against %s: %s', (pattern, value, expected) => {
    expect(matchesRepositoryGlob(pattern, value)).toBe(expected);
  });
});
