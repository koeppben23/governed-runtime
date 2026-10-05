/**
 * @module architecture/coverage-scope-parity
 * @description Guard proving the Vitest coverage exclusion scope is exactly the
 * canonical test-source classification `isTestSourcePath()`
 * (`module-classification.ts`).
 *
 * `test-source-excludes.ts` is only the declarative coverage projection; this
 * guard checks it over the real `src/` inventory, pins the projection actually
 * used by `vitest.config.ts`, and proves the synthetic test-source classes fire
 * in both directions. A divergence is a guard failure, not a warning.
 */

import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import { vitestConfig } from '../../../vitest.config.js';
import { TEST_SOURCE_EXCLUDES, isCoverageExcluded } from '../support/test-source-excludes.js';
import { isTestSourcePath } from './module-classification.js';

const SRC = join(process.cwd(), 'src');

function collectTypeScriptFiles(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTypeScriptFiles(full, files);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

describe('coverage scope parity', () => {
  const inventory = collectTypeScriptFiles(SRC)
    .map((file) => relative(SRC, file).replace(/\\/g, '/'))
    .sort();

  it('excludes exactly the classified test-source files', () => {
    const mismatches = inventory.filter((rel) => isCoverageExcluded(rel) !== isTestSourcePath(rel));
    expect(mismatches, mismatches.join('\n')).toEqual([]);
  });

  it('covers the full inventory non-vacuously in both directions', () => {
    const testClass = inventory.filter((rel) => isTestSourcePath(rel));
    const productionClass = inventory.filter((rel) => !isTestSourcePath(rel));
    expect(inventory.length).toBeGreaterThan(200);
    expect(testClass.length).toBeGreaterThan(100);
    expect(productionClass.length).toBeGreaterThan(100);
  });

  it('is the projection actually used by the coverage config', () => {
    expect(vitestConfig.test?.coverage?.exclude).toEqual([...TEST_SOURCE_EXCLUDES]);
  });

  describe('synthetic test-source classes', () => {
    const cases = [
      'a/b.test.ts',
      'a/b.spec.ts',
      'a/__tests__/b.ts',
      'a/__fixtures__/b.ts',
      'a/b-test-helpers.ts',
      'a/test-helpers.ts',
      'a/b-test-fixtures.ts',
      'state/evidence-test-constants.ts',
      'fixtures.ts',
      'fixtures/session-state/legacy.ts',
      'architecture/helper.ts',
      'documentation/helper.ts',
      'security/helper.ts',
    ] as const;

    it.each(cases)('%s is classified and excluded', (rel) => {
      expect(isTestSourcePath(rel)).toBe(true);
      expect(isCoverageExcluded(rel)).toBe(true);
    });
  });

  describe('synthetic production classes', () => {
    const cases = [
      'integration/plugin-helpers.ts',
      'integration/tools/helpers.ts',
      'state/schema.ts',
      'state/evidence-test-constants-extra.ts',
      'testing.ts',
      'index.ts',
      'tsa.ts',
      'config/reasons.ts',
    ] as const;

    it.each(cases)('%s is production and included', (rel) => {
      expect(isTestSourcePath(rel)).toBe(false);
      expect(isCoverageExcluded(rel)).toBe(false);
    });
  });
});
