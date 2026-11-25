/** The CI worker budget must not reduce test scope or swallow failing checks. */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { sha256File } from '../coverage-shards.mjs';
import { installNpxProbe } from './coverage-probe.js';

describe('coverage runner', () => {
  it.each([false, true])('keeps both projects and the coverage gate, CI=%s', (ci) => {
    const root = mkdtempSync(join(tmpdir(), 'fg-coverage-runner-'));
    try {
      const script = join(root, 'npx.cjs');
      writeFileSync(
        script,
        `console.log(JSON.stringify({args:process.argv.slice(2),perf:process.env.FLOWGUARD_PERF}));process.exit(Number(process.env.PROBE_EXIT ?? 0));`,
      );
      const command = join(root, process.platform === 'win32' ? 'npx.cmd' : 'npx');
      writeFileSync(
        command,
        process.platform === 'win32'
          ? `@"${process.execPath}" "${script}" %*\r\n`
          : `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(script).href)});\n`,
      );
      chmodSync(command, 0o755);
      const result = spawnSync(
        process.execPath,
        [resolve('scripts/coverage.mjs'), ...(ci ? ['--ci'] : [])],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${root}${delimiter}${process.env.PATH}`,
            FLOWGUARD_PERF: '1',
            PROBE_EXIT: '37',
          },
        },
      );
      expect(result.status, result.stderr).toBe(37);
      const observed = JSON.parse(result.stdout.trim());
      expect(observed).toEqual({
        args: [
          'vitest',
          'run',
          '--project',
          'unit',
          '--project',
          'integration',
          '--coverage',
          ...(ci ? ['--coverage.reporter=json-summary', '--maxWorkers=2'] : []),
        ],
        perf: '0',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('coverage shard runner', () => {
  const repoRoot = resolve('.');

  function shardEnvironment(root: string, overrides: Record<string, string> = {}) {
    const binDir = join(root, 'bin');
    mkdirSync(binDir);
    installNpxProbe(binDir);
    return {
      ...process.env,
      PATH: `${binDir}${delimiter}${process.env.PATH}`,
      FLOWGUARD_PERF: '1',
      GITHUB_SHA: 'a'.repeat(40),
      GITHUB_RUN_ID: '4242',
      GITHUB_RUN_ATTEMPT: '3',
      PROBE_REPO_ROOT: repoRoot,
      PROBE_LOG: join(root, 'probe.log'),
      PROBE_FILES: JSON.stringify(['src/example.test.ts']),
      PROBE_INVENTORY: JSON.stringify([{ file: 'src/example.test.ts', projectName: 'unit' }]),
      ...overrides,
    };
  }

  it('runs one project with two workers, collects a manifest, and removes intermediates', () => {
    const root = mkdtempSync(join(tmpdir(), 'fg-coverage-shard-'));
    try {
      const outputDir = join(root, 'unit');
      const result = spawnSync(
        process.execPath,
        [resolve('scripts/coverage-shard.mjs'), 'unit', `--output-dir=${outputDir}`],
        { encoding: 'utf8', env: shardEnvironment(root, { PROBE_SHARD_SUCCESS: '1' }) },
      );
      expect(result.status, result.stderr).toBe(0);
      const manifest = JSON.parse(readFileSync(join(outputDir, 'manifest.json'), 'utf8'));
      expect(manifest).toMatchObject({
        schema: 'flowguard-coverage-shard/v1',
        shard: 'unit',
        project: 'unit',
        identity: { commit: 'a'.repeat(40), runId: '4242', runAttempt: '3' },
        results: { fileCount: 1, testCount: 1, files: ['src/example.test.ts'] },
      });
      expect(manifest.blob.sha256).toBe(sha256File(join(outputDir, 'vitest.blob.json')));
      expect(existsSync(join(outputDir, 'vitest-results.json'))).toBe(false);
      expect(existsSync(join(outputDir, 'report'))).toBe(false);

      const invocations = readFileSync(join(root, 'probe.log'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const run = invocations.find((entry) => entry.args.includes('run'));
      expect(run.perf).toBe('0');
      expect(run.args).toEqual(
        expect.arrayContaining([
          'vitest',
          'run',
          '--project',
          'unit',
          '--coverage',
          '--maxWorkers=2',
          '--coverage.reporter=json-summary',
          '--coverage.thresholds.branches=0',
          '--coverage.thresholds.lines=0',
          '--coverage.thresholds.functions=0',
          '--coverage.thresholds.statements=0',
          '--reporter=blob',
          '--reporter=json',
        ]),
      );
      expect(run.args.some((arg: string) => arg.includes('--coverage.thresholds.lines=80'))).toBe(
        false,
      );
      expect(invocations.some((entry) => entry.args.includes('list'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed without a manifest when the shard tests fail', () => {
    const root = mkdtempSync(join(tmpdir(), 'fg-coverage-shard-fail-'));
    try {
      const outputDir = join(root, 'unit');
      const result = spawnSync(
        process.execPath,
        [resolve('scripts/coverage-shard.mjs'), 'unit', `--output-dir=${outputDir}`],
        {
          encoding: 'utf8',
          env: shardEnvironment(root, { PROBE_RUN_EXIT: '9' }),
        },
      );
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain('COVERAGE_SHARD_TESTS_FAILED');
      expect(existsSync(join(outputDir, 'manifest.json'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects an unknown shard name', () => {
    const result = spawnSync(process.execPath, [resolve('scripts/coverage-shard.mjs'), 'smoke'], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('unit|integration');
  });
});
