/**
 * @module architecture/production-build-boundary
 * @description Build-projection guard for the source-class authority.
 *
 * `isTestSourcePath()` (`module-classification.ts`) is the semantic authority
 * for what counts as test code. `tsconfig.json` is its declarative projection
 * for the production compiler graph: internal test support must never be
 * emitted to `dist/` or shipped in the npm tarball, while `src/testing.ts`
 * stays a production entry point for the public `@flowguard/core/testing` API.
 *
 * The guard builds the ACTUAL production program with the TypeScript compiler
 * API, so `exclude` strings alone are not the contract: TypeScript re-adds an
 * excluded file to the program when production imports it, and this guard then
 * fails. `tsconfig.test.json` is asserted as the counter-proof that internal
 * test-only does not mean untypechecked.
 *
 * @version v1
 */

import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { isTestSourcePath } from './module-classification.js';
import { repoRelative } from './repo-path.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
const SRC_ROOT = join(REPO_ROOT, 'src');

/** The internal test-support files that must never enter the production graph. */
const INTERNAL_TEST_SUPPORT = [
  'src/audit/__fixtures__/rfc3161.ts',
  'src/audit/audit-test-helpers.ts',
  'src/discovery/discovery-test-fixtures.ts',
  'src/discovery/verification-planner-test-helpers.ts',
  'src/fixtures.ts',
  'src/integration/plugin-audit-test-helpers.ts',
  'src/integration/review/enforcement/test-helpers.ts',
  'src/integration/test-helpers.ts',
  'src/integration/tools/review-validation-test-helpers.ts',
  'src/rails/review-decision-test-helpers.ts',
  'src/state/evidence-test-constants.ts',
  'src/test-policy.ts',
] as const;

function parseConfig(fileName: string): ts.ParsedCommandLine {
  const configPath = join(REPO_ROOT, fileName);
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) {
    const message = ts.flattenDiagnosticMessageText(read.error.messageText, ' ');
    throw new Error(`Cannot read ${fileName}: ${message}`);
  }
  return ts.parseJsonConfigFileContent(read.config, ts.sys, REPO_ROOT);
}

function isUnderSrc(fileName: string): boolean {
  return fileName.startsWith(`${SRC_ROOT}${sep}`);
}

describe('production/test distribution boundary', () => {
  it('every internal test-support file exists and is classified as test code', () => {
    expect(INTERNAL_TEST_SUPPORT).toHaveLength(12);
    for (const rel of INTERNAL_TEST_SUPPORT) {
      expect(existsSync(join(REPO_ROOT, rel)), rel).toBe(true);
      expect(isTestSourcePath(rel.slice('src/'.length)), rel).toBe(true);
    }
  });

  it('keeps internal test support out of the production program graph', () => {
    const parsed = parseConfig('tsconfig.json');
    const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
    const srcSources = program.getSourceFiles().filter((source) => isUnderSrc(source.fileName));

    // Non-vacuum: the production program really is the production graph.
    expect(srcSources.length).toBeGreaterThan(100);
    expect(program.getSourceFile(join(SRC_ROOT, 'testing.ts')), 'src/testing.ts').toBeDefined();

    // Transitive inclusion: TypeScript re-adds an excluded file when production
    // imports it, so a forbidden production import fails here.
    const violations = srcSources
      .filter((source) => !source.isDeclarationFile)
      .map((source) => repoRelative(SRC_ROOT, source.fileName))
      .filter((rel) => isTestSourcePath(rel));
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('keeps the public @flowguard/core/testing entry in the production config', () => {
    const parsed = parseConfig('tsconfig.json');
    const files = parsed.fileNames.map((fileName) => repoRelative(REPO_ROOT, fileName));
    expect(files).toContain('src/testing.ts');
  });

  it('typechecks internal test support through tsconfig.test.json', () => {
    const parsed = parseConfig('tsconfig.test.json');
    const files = new Set(parsed.fileNames.map((fileName) => repoRelative(REPO_ROOT, fileName)));
    for (const rel of INTERNAL_TEST_SUPPORT) {
      expect(files, `${rel} missing from tsconfig.test.json`).toContain(rel);
    }
  });
});
