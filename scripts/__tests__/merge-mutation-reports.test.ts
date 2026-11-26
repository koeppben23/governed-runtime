import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { mergeShardReports } from '../merge-mutation-reports.mjs';
import { loadShardPlan, planMutationShards } from '../mutation-shard-plan.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MERGE_SCRIPT = join(REPO_ROOT, 'scripts', 'merge-mutation-reports.mjs');
const VERIFY_SCRIPT = join(REPO_ROOT, 'scripts', 'verify-mutation-admission.mjs');

interface Mutant {
  readonly id: string;
  readonly mutatorName: string;
  readonly status: string;
  readonly location: {
    readonly start: { readonly line: number; readonly column: number };
    readonly end: { readonly line: number; readonly column: number };
  };
}

interface FileEntry {
  readonly language: string;
  readonly source: string;
  readonly mutants: Mutant[];
}

interface TestFileEntry {
  readonly tests: Array<{
    readonly id: string;
    readonly name: string;
    readonly location: { readonly start: { readonly line: number; readonly column: number } };
  }>;
}

interface Report {
  [key: string]: unknown;
  readonly schemaVersion: string;
  readonly projectRoot?: string;
  readonly thresholds: { high: number; low: number; break: number };
  readonly config: Record<string, unknown>;
  readonly files: Record<string, FileEntry>;
  readonly testFiles?: Record<string, TestFileEntry>;
}

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new TypeError(`missing item ${index}`);
  return item;
}

const CONFIG = {
  packageManager: 'npm',
  testRunner: 'vitest',
  reporters: ['json'],
  coverageAnalysis: 'perTest',
  concurrency: 4,
  dryRunTimeoutMinutes: 45,
  checkers: ['typescript'],
  tsconfigFile: 'tsconfig.json',
  vitest: { pool: 'forks', configFile: 'vitest.stryker.config.ts', related: false },
  mutate: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'],
  mutator: { excludedMutations: ['StringLiteral', 'ArrayDeclaration', 'Regex'] },
  ignoreStatic: true,
  thresholds: { high: 85, low: 80, break: 80 },
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
};

const TEST_FILE: TestFileEntry = {
  tests: [{ id: '0', name: 'a', location: { start: { line: 1, column: 1 } } }],
};

const TEST_FILES: Record<string, TestFileEntry> = {
  'src/a.test.ts': TEST_FILE,
};

function mutant(status = 'Killed'): Mutant {
  return {
    id: '1',
    mutatorName: 'EqualityOperator',
    status,
    location: {
      start: { line: 1, column: 1 },
      end: { line: 1, column: 2 },
    },
  };
}

function fileEntry(status = 'Killed'): FileEntry {
  return { language: 'typescript', source: '', mutants: [mutant(status)] };
}

function reportFor(
  shard: { index: number; selectors: string[]; targets: string[] },
  overrides: Partial<Report> = {},
): Report {
  const files = Object.fromEntries(shard.targets.map((target) => [target, fileEntry()]));
  return {
    schemaVersion: '1.0',
    projectRoot: '/repo',
    thresholds: { ...CONFIG.thresholds, break: 0 },
    config: {
      ...CONFIG,
      mutate: shard.selectors,
      thresholds: { ...CONFIG.thresholds, break: 0 },
    },
    files,
    testFiles: TEST_FILES,
    ...overrides,
  };
}

function happyPlan(selectors = CONFIG.mutate, shardCount = 2) {
  return planMutationShards({
    selectors,
    weights: new Map(selectors.map((selector) => [selector.replace(/:\d+-\d+$/, ''), 100])),
    shardCount,
  });
}

describe('merge mutation shard reports', () => {
  describe('HAPPY', () => {
    it('merges disjoint shards into the canonical report', () => {
      const shards = happyPlan();
      const reports = shards.map((shard) => reportFor(shard));
      const merged = mergeShardReports({ config: CONFIG, plan: { shards }, reports }) as {
        thresholds: { break: number };
        config: { mutate: string[]; thresholds: { break: number } };
        files: Record<string, FileEntry>;
        testFiles?: Record<string, TestFileEntry>;
        projectRoot?: string;
      };
      expect(Object.keys(merged.files)).toEqual(CONFIG.mutate);
      expect(merged.thresholds.break).toBe(80);
      expect(merged.config.thresholds.break).toBe(80);
      expect(merged.config.mutate).toEqual(CONFIG.mutate);
      expect(merged.testFiles).toEqual(TEST_FILES);
      expect(merged.projectRoot).toBe('/repo');
    });

    it('keeps range selectors for one target in one report entry', () => {
      const config = {
        ...CONFIG,
        mutate: ['src/a.ts:1-2', 'src/a.ts:5-6', 'src/b.ts'],
      };
      const shards = [
        { index: 0, selectors: ['src/a.ts:1-2', 'src/a.ts:5-6'], targets: ['src/a.ts'] },
        { index: 1, selectors: ['src/b.ts'], targets: ['src/b.ts'] },
      ];
      const merged = mergeShardReports({
        config,
        plan: { shards },
        reports: shards.map((shard) => reportFor(shard)),
        projectRoot: '/workspace',
      }) as { files: Record<string, FileEntry>; projectRoot?: string };
      expect(Object.keys(merged.files)).toEqual(['src/a.ts', 'src/b.ts']);
      expect(merged.projectRoot).toBe('/workspace');
    });
  });

  describe('BAD', () => {
    it('rejects a missing shard report', () => {
      const shards = happyPlan();
      expect(() =>
        mergeShardReports({
          config: CONFIG,
          plan: { shards },
          reports: [reportFor(at(shards, 0))],
        }),
      ).toThrow(/expected 2 shard report/);
    });

    it('rejects a shard that omits or adds a target', () => {
      const shards = happyPlan();
      const reports = shards.map((shard) => reportFor(shard));
      const missing = { ...at(reports, 0).files };
      delete missing[at(at(shards, 0).targets, 0)];
      expect(() =>
        mergeShardReports({
          config: CONFIG,
          plan: { shards },
          reports: [{ ...at(reports, 0), files: missing }, at(reports, 1)],
        }),
      ).toThrow(/files must contain exactly the planned targets/);
      expect(() =>
        mergeShardReports({
          config: CONFIG,
          plan: { shards },
          reports: [
            {
              ...at(reports, 0),
              files: { ...at(reports, 0).files, 'src/extra.ts': fileEntry() },
            },
            at(reports, 1),
          ],
        }),
      ).toThrow(/files must contain exactly the planned targets/);
    });

    it('rejects a target that appears in more than one shard', () => {
      const shards = [
        { index: 0, selectors: ['src/a.ts'], targets: ['src/a.ts'] },
        { index: 1, selectors: ['src/a.ts'], targets: ['src/a.ts'] },
      ];
      const config = { ...CONFIG, mutate: ['src/a.ts'] };
      expect(() =>
        mergeShardReports({
          config,
          plan: { shards },
          reports: shards.map((shard) => reportFor(shard)),
        }),
      ).toThrow(/appears in more than one shard/);
    });

    it('rejects threshold, config and schema drift', () => {
      const shards = happyPlan();
      const reports = shards.map((shard) => reportFor(shard));
      expect(() =>
        mergeShardReports({
          config: CONFIG,
          plan: { shards },
          reports: [
            { ...at(reports, 0), thresholds: { high: 84, low: 80, break: 0 } },
            at(reports, 1),
          ],
        }),
      ).toThrow(/thresholds must keep high\/low/);
      expect(() =>
        mergeShardReports({
          config: CONFIG,
          plan: { shards },
          reports: [
            {
              ...at(reports, 0),
              config: { ...at(reports, 0).config, testRunner: 'mocha' },
            },
            at(reports, 1),
          ],
        }),
      ).toThrow(/config.testRunner differs/);
      expect(() =>
        mergeShardReports({
          config: CONFIG,
          plan: { shards },
          reports: [{ ...at(reports, 0), schemaVersion: '2.0' }, at(reports, 1)],
        }),
      ).toThrow(/schemaVersion differs/);
    });

    it('rejects inconsistent test file inventories', () => {
      const shards = happyPlan();
      const reports = shards.map((shard) => reportFor(shard));
      expect(() =>
        mergeShardReports({
          config: CONFIG,
          plan: { shards },
          reports: [
            at(reports, 0),
            { ...at(reports, 1), testFiles: { 'src/b.test.ts': TEST_FILE } },
          ],
        }),
      ).toThrow(/testFiles key set differs/);
    });
  });

  describe('EDGE', () => {
    it('omits testFiles when no shard reports them', () => {
      const shards = happyPlan();
      const reports = shards.map((shard) => {
        const report = reportFor(shard);
        return { ...report, testFiles: undefined };
      });
      const merged = mergeShardReports({ config: CONFIG, plan: { shards }, reports }) as {
        testFiles?: unknown;
      };
      expect(merged.testFiles).toBeUndefined();
    });
  });

  describe('CORNER', () => {
    it('writes files in canonical mutate order even when shard order differs', () => {
      const shards = [
        { index: 0, selectors: ['src/c.ts'], targets: ['src/c.ts'] },
        { index: 1, selectors: ['src/a.ts', 'src/b.ts'], targets: ['src/a.ts', 'src/b.ts'] },
      ];
      const config = { ...CONFIG, mutate: ['src/a.ts', 'src/b.ts', 'src/c.ts'] };
      const merged = mergeShardReports({
        config,
        plan: { shards },
        reports: shards.map((shard) => reportFor(shard)),
      }) as { files: Record<string, FileEntry> };
      expect(Object.keys(merged.files)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    });
  });

  describe('E2E', () => {
    it('merges the real profile through the CLI and the admission verifier accepts it', () => {
      const plan = loadShardPlan({ repoRoot: REPO_ROOT, profile: 'base', shardCount: 8 });
      const directory = mkdtempSync(join(tmpdir(), 'fg-mutation-merge-'));
      try {
        const inputDirectory = join(directory, 'shards');
        mkdirSync(inputDirectory);
        for (const shard of plan.shards) {
          const files = Object.fromEntries(shard.targets.map((target) => [target, fileEntry()]));
          const report: Report = {
            schemaVersion: '1.0',
            projectRoot: REPO_ROOT,
            thresholds: { ...plan.config.thresholds, break: 0 },
            config: {
              ...plan.config,
              mutate: shard.selectors,
              thresholds: { ...plan.config.thresholds, break: 0 },
            },
            files,
            testFiles: {},
          };
          writeFileSync(
            join(inputDirectory, `shard-${shard.index}.json`),
            `${JSON.stringify(report, null, 2)}\n`,
            'utf8',
          );
        }
        const output = join(directory, 'mutation.json');
        const merge = spawnSync(
          process.execPath,
          [
            MERGE_SCRIPT,
            '--profile',
            'base',
            '--shard-count',
            '8',
            '--input-dir',
            inputDirectory,
            '--output',
            output,
          ],
          { cwd: REPO_ROOT, encoding: 'utf8' },
        );
        expect(merge.status, merge.stderr).toBe(0);
        const verify = spawnSync(
          process.execPath,
          [VERIFY_SCRIPT, '--profile', 'base', '--report', output],
          { cwd: REPO_ROOT, encoding: 'utf8' },
        );
        expect(verify.status, verify.stderr).toBe(0);
        expect(verify.stdout).toContain('aggregate=100.00%');
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });
});
