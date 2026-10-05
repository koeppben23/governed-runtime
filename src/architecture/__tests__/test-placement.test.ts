/**
 * @module architecture/test-placement
 * @description Executable placement rules for the test tree.
 *
 * `isTestSourcePath()` (`../support/module-classification.ts`) is the semantic
 * authority. This guard pins the structural rules produced by the placement
 * hardening:
 *
 * 1. `__tests__/` directories exist only under classified test-support trees
 *    and contain suites only;
 * 2. every production-module suite co-locates with a non-test source file;
 * 3. every source file importing `vitest` is classified test code;
 * 4. `*.smoke.test.ts` / `*.fuzz.test.ts` select their Vitest project by
 *    suffix instead of hand-maintained per-file lists.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import { vitestConfig } from '../../../vitest.config.js';
import {
  MODULE_CLASSIFICATION_BY_NAME,
  isTestSourcePath,
} from '../support/module-classification.js';

const SRC = join(process.cwd(), 'src');

interface ProjectLike {
  readonly test?: {
    readonly name?: string;
    readonly include?: readonly string[];
    readonly exclude?: readonly string[];
  };
}

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

function collectDirectories(dir: string, directories: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      directories.push(full);
      collectDirectories(full, directories);
    }
  }
  return directories;
}

function toPosix(path: string): string {
  return path.replace(/\\/g, '/');
}

function isInTestSupportTree(relFromSrc: string): boolean {
  const top = relFromSrc.split('/')[0] ?? '';
  return MODULE_CLASSIFICATION_BY_NAME.get(top)?.kind === 'test-support';
}

function isSuite(relFromSrc: string): boolean {
  return relFromSrc.endsWith('.test.ts') || relFromSrc.endsWith('.spec.ts');
}

describe('test placement', () => {
  const inventory = collectTypeScriptFiles(SRC)
    .map((file) => toPosix(relative(SRC, file)))
    .sort();
  const testsDirectories = collectDirectories(SRC)
    .map((dir) => toPosix(relative(SRC, dir)))
    .filter((dir) => dir.split('/').includes('__tests__'));
  const suites = inventory.filter(isSuite);
  const coLocatedSuites = suites.filter(
    (rel) => !rel.split('/').includes('__tests__') && !isInTestSupportTree(rel),
  );

  it('scans a non-vacuous inventory', () => {
    expect(inventory.length).toBeGreaterThan(200);
    expect(suites.length).toBeGreaterThan(400);
    expect(coLocatedSuites.length).toBeGreaterThan(400);
    expect(testsDirectories.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps __tests__ directories inside classified test-support trees', () => {
    for (const dir of testsDirectories) {
      const top = dir.split('/')[0] ?? '';
      expect(MODULE_CLASSIFICATION_BY_NAME.get(top)?.kind, dir).toBe('test-support');
    }
  });

  it('keeps __tests__ directories suite-only', () => {
    const nonSuites = inventory.filter(
      (rel) => rel.split('/').includes('__tests__') && !isSuite(rel),
    );
    expect(nonSuites, nonSuites.join('\n')).toEqual([]);
  });

  it('co-locates every production-module suite with a non-test source file', () => {
    const violations: string[] = [];
    for (const rel of coLocatedSuites) {
      const directory = dirname(join(SRC, rel));
      const productionSiblings = readdirSync(directory).filter((name) => {
        if (!name.endsWith('.ts')) return false;
        return !isTestSourcePath(toPosix(relative(SRC, join(directory, name))));
      });
      if (productionSiblings.length === 0) violations.push(rel);
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('classifies every source that imports vitest as test code', () => {
    const offenders = inventory.filter((rel) => {
      const content = readFileSync(join(SRC, rel), 'utf8');
      const importsVitest =
        /from ['"]vitest['"]/.test(content) || /require\(['"]vitest['"]\)/.test(content);
      return importsVitest && !isTestSourcePath(rel);
    });
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('selects test-kind projects by suffix, not by per-file lists', () => {
    const testConfig = vitestConfig.test as unknown as
      { readonly projects?: readonly ProjectLike[] } | undefined;
    const configByName = new Map(
      (testConfig?.projects ?? []).map((project) => [project.test?.name, project.test]),
    );

    expect(configByName.get('smoke')?.include).toEqual(['src/**/*.smoke.test.ts']);
    expect(configByName.get('fuzz')?.include).toEqual(['src/**/*.fuzz.test.ts']);
    expect(configByName.get('unit')?.exclude).toContain('src/**/*.smoke.test.ts');
    expect(configByName.get('unit')?.exclude).toContain('src/**/*.fuzz.test.ts');
    expect(configByName.get('integration')?.exclude).toContain('src/**/*.smoke.test.ts');
    expect(configByName.get('integration')?.exclude).toContain('src/**/*.fuzz.test.ts');
  });
});
