/**
 * @module architecture/support/test-source-excludes
 * @description Declarative coverage projection of the canonical
 * `isTestSourcePath()` classification (`module-classification.ts`).
 *
 * This module is NOT a second classification authority. It only projects the
 * canonical test-source classes into the glob language Vitest coverage
 * understands. `coverage-scope-parity.test.ts` proves the projection equals the
 * classification over the real `src/` inventory and over the synthetic class
 * cases, and that `vitest.config.ts` uses this projection.
 */

/** Coverage globs for every test-source class owned by `isTestSourcePath()`. */
export const TEST_SOURCE_EXCLUDES = [
  'src/**/*.test.ts',
  'src/**/*.spec.ts',
  'src/**/__tests__/**',
  'src/**/__fixtures__/**',
  'src/**/*-test-helpers.ts',
  'src/**/test-helpers.ts',
  'src/**/*-test-fixtures.ts',
  'src/**/evidence-test-constants.ts',
  'src/fixtures.ts',
  'src/fixtures/**',
  'src/test-policy.ts',
  'src/architecture/**',
  'src/documentation/**',
  'src/security/**',
] as const;

/** Convert one repository-relative glob into an anchored regular expression. */
function globToRegExp(pattern: string): RegExp {
  let source = '';
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index] ?? '';
    if (char === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') {
        source += '(?:[^/]+/)*';
        index += 3;
      } else {
        source += '.*';
        index += 2;
      }
      continue;
    }
    if (char === '*') {
      source += '[^/]*';
      index += 1;
      continue;
    }
    source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    index += 1;
  }
  return new RegExp(`^${source}$`);
}

const EXCLUDE_MATCHERS: readonly RegExp[] = TEST_SOURCE_EXCLUDES.map(globToRegExp);

/**
 * Parity helper for the coverage projection. Input is the same
 * `src/`-relative path contract as `isTestSourcePath()`.
 */
export function isCoverageExcluded(relativeFromSrc: string): boolean {
  const repoPath = `src/${relativeFromSrc.replace(/\\/g, '/')}`;
  return EXCLUDE_MATCHERS.some((matcher) => matcher.test(repoPath));
}
