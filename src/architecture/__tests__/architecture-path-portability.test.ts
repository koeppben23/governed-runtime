/**
 * @module architecture/architecture-path-portability
 * @description Regression guard for the architecture path-normalization
 * boundary: filesystem representation and architecture semantics must never be
 * conflated.
 *
 * The Linux CI leg cannot observe a Windows separator bug, so this suite
 * reproduces the bug class with synthetic Windows inputs on every platform and
 * additionally proves that the real production-source scanner emits only
 * canonical repo-relative paths.
 *
 * `isTestSourcePath` is the single source-class authority for every test class,
 * including the conventional internal test-support files (`*-test-helpers.ts`,
 * `test-helpers.ts`, `*-test-fixtures.ts`, `evidence-test-constants.ts`). The
 * build, metrics, dependency-rule, and mutation projections all derive from it.
 *
 * @version v2
 */

import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { isTestSourcePath } from './module-classification.js';
import { collectProductionSources } from './production-source.js';
import { normalizeRepoPath, repoRelative } from './repo-path.js';

const SRC = resolve(import.meta.dirname, '..', '..');

describe('architecture path portability', () => {
  it('normalizes POSIX and Windows separators to canonical repo paths', () => {
    expect(normalizeRepoPath('src/a/__tests__/x.ts')).toBe('src/a/__tests__/x.ts');
    expect(normalizeRepoPath('src\\a\\__tests__\\x.ts')).toBe('src/a/__tests__/x.ts');
    expect(normalizeRepoPath('src\\a\\b.ts')).toBe('src/a/b.ts');
  });

  it('repoRelative returns canonical logical paths for filesystem paths', () => {
    const rel = repoRelative(SRC, join(SRC, 'state', '__tests__', 'probe.ts'));
    expect(rel).toBe('state/__tests__/probe.ts');
    expect(rel).not.toContain('\\');
  });

  it('isTestSourcePath accepts POSIX and Windows separators for every test class', () => {
    const testPaths = [
      'state/__tests__/probe.ts',
      'state\\__tests__\\probe.ts',
      'state/__fixtures__/probe.ts',
      'state\\__fixtures__\\probe.ts',
      'state/probe.test.ts',
      'state\\probe.test.ts',
      'state/probe.spec.ts',
      'state\\probe.spec.ts',
      'integration/plugin-audit-test-helpers.ts',
      'integration\\plugin-audit-test-helpers.ts',
      'integration/test-helpers.ts',
      'integration\\test-helpers.ts',
      'discovery/discovery-test-fixtures.ts',
      'discovery\\discovery-test-fixtures.ts',
      'state/evidence-test-constants.ts',
      'state\\evidence-test-constants.ts',
      'architecture/mutation-authority-inventory.ts',
      'architecture\\mutation-authority-inventory.ts',
    ];
    for (const path of testPaths) {
      expect(isTestSourcePath(path), path).toBe(true);
    }

    const productionPaths = [
      'state/runtime.ts',
      'state\\runtime.ts',
      // `__`-prefixed directory names are not an escape hatch: only the
      // explicit conventional names `__tests__` / `__fixtures__` qualify.
      'state/__internal__/runtime.ts',
      'state\\__internal__\\runtime.ts',
      // Ordinary helpers are production; only the `-test-` classes are test.
      'integration/plugin-helpers.ts',
      'integration\\plugin-helpers.ts',
      'integration/tools/helpers.ts',
      'integration\\tools\\helpers.ts',
    ];
    for (const path of productionPaths) {
      expect(isTestSourcePath(path), path).toBe(false);
    }
  });

  it('collectProductionSources yields only canonical repo-relative paths', () => {
    const sources = collectProductionSources(SRC);
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.every(({ rel }) => rel === normalizeRepoPath(rel))).toBe(true);
    expect(sources.some(({ rel }) => rel.includes('\\'))).toBe(false);
    expect(sources.some(({ rel }) => rel.includes('/__tests__/'))).toBe(false);
  });

  it('classifies test-helper paths as test support and keeps them canonical', () => {
    const helper = 'integration/plugin-audit-test-helpers.ts';
    expect(normalizeRepoPath('integration\\plugin-audit-test-helpers.ts')).toBe(helper);
    expect(isTestSourcePath(helper)).toBe(true);
  });
});
