/**
 * @module architecture/file-size.test
 * @description Clean Code "Extract, Don't Accumulate" enforcement: the file-size
 * budget documented in CONTRIBUTING.md / docs/project-governance.md is a hard
 * gate, not a suggestion. Production source files must stay within the blocker
 * threshold; test files get a higher, separate threshold (suites are allowed to
 * be broader before splitting).
 *
 * Mechanism mirrors the other architecture guards: a pure detector over the
 * source tree, plus proving fixtures. Counting matches the documented budget
 * (raw newline count per file).
 *
 * Thresholds are the single runtime source of truth for the budget — the docs
 * reference these numbers.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC_ROOT = join(process.cwd(), 'src');

/** Production source file blocker threshold (LOC). Exceeding this fails the build. */
export const PROD_FILE_LOC_BLOCKER = 750;
/**
 * Test file blocker threshold (LOC). Test suites are allowed to be broader than
 * production modules before they must split; the repo's established convention
 * is to split god test files above 2000 LOC (1500 is advisory).
 */
export const TEST_FILE_LOC_BLOCKER = 2000;

interface SourceFile {
  readonly rel: string;
  readonly loc: number;
  readonly isTest: boolean;
}

function countLoc(content: string): number {
  // Match the documented budget: raw line count.
  return content.split('\n').length;
}

function collectFiles(dir: string, acc: SourceFile[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      collectFiles(full, acc);
      continue;
    }
    if (!entry.isFile() || !full.endsWith('.ts')) continue;
    const rel = relative(SRC_ROOT, full).split(sep).join('/');
    const isTest =
      full.endsWith('.test.ts') ||
      full.endsWith('.spec.ts') ||
      rel.split('/').includes('__tests__');
    acc.push({ rel, loc: countLoc(readFileSync(full, 'utf8')), isTest });
  }
}

function findOversizedFiles(
  files: readonly SourceFile[],
): Array<{ rel: string; loc: number; limit: number }> {
  const out: Array<{ rel: string; loc: number; limit: number }> = [];
  for (const f of files) {
    const limit = f.isTest ? TEST_FILE_LOC_BLOCKER : PROD_FILE_LOC_BLOCKER;
    if (f.loc > limit) out.push({ rel: f.rel, loc: f.loc, limit });
  }
  return out;
}

describe("file-size budget (Clean Code: Extract, Don't Accumulate)", () => {
  const files: SourceFile[] = [];
  collectFiles(SRC_ROOT, files);

  it(`no production file exceeds ${PROD_FILE_LOC_BLOCKER} LOC and no test file exceeds ${TEST_FILE_LOC_BLOCKER} LOC`, () => {
    const oversized = findOversizedFiles(files);
    if (oversized.length > 0) {
      console.error('File-size budget violations (split along domain boundaries):', oversized);
    }
    expect(oversized).toEqual([]);
  });

  describe('negative fixture — proves the detector fires', () => {
    it('flags a production file over the blocker threshold', () => {
      const fixture: SourceFile[] = [
        { rel: 'integration/huge.ts', loc: PROD_FILE_LOC_BLOCKER + 1, isTest: false },
      ];
      const oversized = findOversizedFiles(fixture);
      expect(oversized).toHaveLength(1);
      expect(oversized[0]!.limit).toBe(PROD_FILE_LOC_BLOCKER);
    });

    it('uses the higher threshold for test files', () => {
      const fixture: SourceFile[] = [
        // Between the prod and test thresholds: allowed because it is a test file.
        { rel: 'integration/big.test.ts', loc: PROD_FILE_LOC_BLOCKER + 100, isTest: true },
      ];
      expect(findOversizedFiles(fixture)).toEqual([]);
    });
  });
});
