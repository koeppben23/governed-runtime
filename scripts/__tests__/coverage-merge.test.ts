/** Fail-closed controls for the distributed coverage merge boundary. */
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createShardManifest, readVitestVersion } from '../coverage-shards.mjs';
import { installNpxProbe } from './coverage-probe.js';

const require = createRequire(import.meta.url);
const { stringify } = require('flatted') as { stringify: (value: unknown) => string };

const repoRoot = resolve('.');
const vitestVersion = readVitestVersion(repoRoot);
const identity = { commit: 'a'.repeat(40), runId: '555', runAttempt: '2' };
const unitFile = 'src/example.test.ts';
const integrationFile = 'src/integration/example.test.ts';
const defaultInventory = JSON.stringify([
  { file: unitFile, projectName: 'unit' },
  { file: integrationFile, projectName: 'integration' },
]);

type ShardOptions = { withCoverage?: boolean; files?: string[]; manifestShard?: string };

function blobContent(files: string[], withCoverage: boolean): string {
  const coverage = withCoverage
    ? Object.fromEntries(files.map((file) => [file, { statementMap: {}, s: {} }]))
    : null;
  return stringify([vitestVersion, files.map((name) => ({ name })), [], coverage, 1, {}]);
}

function writeShard(root: string, shard: 'unit' | 'integration', options: ShardOptions = {}) {
  const files = options.files ?? [shard === 'unit' ? unitFile : integrationFile];
  const directory = join(root, 'coverage-shards', shard);
  mkdirSync(directory, { recursive: true });
  const blobPath = join(directory, 'vitest.blob.json');
  writeFileSync(blobPath, blobContent(files, options.withCoverage ?? true));
  const manifest = createShardManifest({
    shard: options.manifestShard ?? shard,
    identity,
    files,
    testCount: files.length,
    blobPath,
    blobBytes: statSync(blobPath).size,
    vitestVersion,
    nodeVersion: process.version,
  });
  writeFileSync(join(directory, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
  return { directory, blobPath, manifest };
}

function runMerge(root: string, overrides: Record<string, string> = {}) {
  const binDir = join(root, 'bin');
  mkdirSync(binDir);
  installNpxProbe(binDir);
  return spawnSync(
    process.execPath,
    [
      resolve('scripts/coverage-merge.mjs'),
      '--ci',
      `--input-dir=${join(root, 'coverage-shards')}`,
      `--reports-dir=${join(root, 'coverage')}`,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH}`,
        GITHUB_SHA: identity.commit,
        GITHUB_RUN_ID: identity.runId,
        GITHUB_RUN_ATTEMPT: identity.runAttempt,
        PROBE_REPO_ROOT: repoRoot,
        PROBE_LOG: join(root, 'probe.log'),
        PROBE_INVENTORY: defaultInventory,
        PROBE_WRITE_SUMMARY: '1',
        PROBE_REPORT_DIR: join(root, 'coverage'),
        ...overrides,
      },
    },
  );
}

function probeInvocations(root: string) {
  return readFileSync(join(root, 'probe.log'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('coverage merge gate', () => {
  it('merges both complete shards and runs the canonical gate without threshold overrides', () => {
    const root = mkdtempSync(join(tmpdir(), 'fg-coverage-merge-'));
    try {
      writeShard(root, 'unit');
      writeShard(root, 'integration');
      const result = runMerge(root);
      expect(result.status, result.stderr).toBe(0);
      const summary = JSON.parse(
        readFileSync(join(root, 'coverage', 'coverage-summary.json'), 'utf8'),
      );
      expect(summary.total.lines).toMatchObject({ total: 1, covered: 1 });
      const output = JSON.parse(result.stdout.trim().split('\n').at(-1)!);
      expect(output).toMatchObject({
        shards: ['unit', 'integration'],
        files: 1,
        totals: {
          branches: { covered: 1, total: 1 },
          functions: { covered: 1, total: 1 },
          lines: { covered: 1, total: 1 },
          statements: { covered: 1, total: 1 },
        },
      });

      const invocations = probeInvocations(root);
      const merge = invocations.find((entry) =>
        entry.args.some((arg: string) => arg.startsWith('--merge-reports=')),
      );
      expect(merge.args).toEqual(expect.arrayContaining(['vitest', 'run', '--coverage']));
      expect(merge.args).toContain('--coverage.reporter=json-summary');
      expect(merge.args.some((arg: string) => arg.includes('--coverage.thresholds'))).toBe(false);
      expect(merge.perf).toBe('0');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks a missing shard before running any merge', () => {
    const root = mkdtempSync(join(tmpdir(), 'fg-coverage-missing-'));
    try {
      writeShard(root, 'unit');
      const result = runMerge(root);
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain('missing shard manifest: integration');
      expect(
        probeInvocations(root).some((entry) =>
          entry.args.some((arg: string) => arg.startsWith('--merge-reports=')),
        ),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks a duplicate shard manifest', () => {
    const root = mkdtempSync(join(tmpdir(), 'fg-coverage-duplicate-'));
    try {
      writeShard(root, 'unit');
      const duplicate = writeShard(root, 'integration', {
        manifestShard: 'unit',
        files: [unitFile],
      });
      // Point the duplicate manifest at the blob it wrote in this directory.
      const manifest = JSON.parse(readFileSync(join(duplicate.directory, 'manifest.json'), 'utf8'));
      manifest.blob.file = 'vitest.blob.json';
      writeFileSync(join(duplicate.directory, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
      const result = runMerge(root);
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain('duplicate shard manifest: unit');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks a manifest from another workflow run', () => {
    const root = mkdtempSync(join(tmpdir(), 'fg-coverage-foreign-'));
    try {
      writeShard(root, 'unit');
      writeShard(root, 'integration');
      const manifestPath = join(root, 'coverage-shards', 'unit', 'manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      manifest.identity.runId = '999';
      writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
      const result = runMerge(root);
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain('identity.runId');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows a merge-job rerun to reuse shards from the same run and commit', () => {
    const root = mkdtempSync(join(tmpdir(), 'fg-coverage-rerun-'));
    try {
      writeShard(root, 'unit');
      writeShard(root, 'integration');
      const manifestPath = join(root, 'coverage-shards', 'unit', 'manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      manifest.identity.runAttempt = '9';
      writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
      const result = runMerge(root, { GITHUB_RUN_ATTEMPT: '9' });
      expect(result.status, result.stderr).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks a blob without coverage data', () => {
    const root = mkdtempSync(join(tmpdir(), 'fg-coverage-nocov-'));
    try {
      writeShard(root, 'unit', { withCoverage: false });
      writeShard(root, 'integration');
      const result = runMerge(root);
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain('blob contains no coverage data');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks a blob whose bytes do not match the manifest digest', () => {
    const root = mkdtempSync(join(tmpdir(), 'fg-coverage-digest-'));
    try {
      const unit = writeShard(root, 'unit');
      writeShard(root, 'integration');
      writeFileSync(unit.blobPath, blobContent([unitFile, 'src/other.ts'], true));
      const result = runMerge(root);
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain('blob sha256 does not match the manifest');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks extra artifacts in a shard directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'fg-coverage-extra-'));
    try {
      const unit = writeShard(root, 'unit');
      writeShard(root, 'integration');
      writeFileSync(join(unit.directory, 'foreign.json'), '{}\n');
      const result = runMerge(root);
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain('artifact must contain exactly manifest.json');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks a shard that did not execute the full project inventory', () => {
    const root = mkdtempSync(join(tmpdir(), 'fg-coverage-inventory-'));
    try {
      writeShard(root, 'unit');
      writeShard(root, 'integration');
      const result = runMerge(root, {
        PROBE_INVENTORY: JSON.stringify([
          { file: unitFile, projectName: 'unit' },
          { file: 'src/never-ran.test.ts', projectName: 'unit' },
          { file: integrationFile, projectName: 'integration' },
        ]),
      });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain('missing test file src/never-ran.test.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks test files that appear in both shards', () => {
    const root = mkdtempSync(join(tmpdir(), 'fg-coverage-overlap-'));
    try {
      writeShard(root, 'unit', { files: [unitFile] });
      writeShard(root, 'integration', { files: [unitFile] });
      const result = runMerge(root, {
        PROBE_INVENTORY: JSON.stringify([
          { file: unitFile, projectName: 'unit' },
          { file: unitFile, projectName: 'integration' },
        ]),
      });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain('test file appears in both unit and integration');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('propagates a failed canonical coverage gate', () => {
    const root = mkdtempSync(join(tmpdir(), 'fg-coverage-gate-'));
    try {
      writeShard(root, 'unit');
      writeShard(root, 'integration');
      const result = runMerge(root, { PROBE_MERGE_EXIT: '7' });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain('COVERAGE_GATE_FAILED');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks a merge that produces no coverage summary', () => {
    const root = mkdtempSync(join(tmpdir(), 'fg-coverage-nosummary-'));
    try {
      writeShard(root, 'unit');
      writeShard(root, 'integration');
      const result = runMerge(root, { PROBE_WRITE_SUMMARY: '0' });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain('COVERAGE_SUMMARY_MISSING');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
