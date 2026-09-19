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
 * `*-test-helpers.ts` is deliberately pinned at the normalization layer only:
 * its semantic classification is owned by `dependency-rules.test.ts`
 * (`isTestScaffoldingFile`) and `mutation-authority-inventory.ts`
 * (`isProductionSource`), not by `isTestSourcePath`. Extending the latter is a
 * classification-semantics change outside this portability contract.
 *
 * @version v1
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

  it('normalizes test-helper paths without changing classification semantics', () => {
    const helper = 'integration/plugin-audit-test-helpers.ts';
    expect(normalizeRepoPath('integration\\plugin-audit-test-helpers.ts')).toBe(helper);
    // Semantic ownership of this class lives in the dependency-rule
    // scaffolding classifier and the mutation production predicate.
    expect(isTestSourcePath(helper)).toBe(false);
  });
});
