#!/usr/bin/env node
/**
 * @module scripts/coverage-shard
 * @description Run one instrumented coverage shard on its own CI runner.
 *
 * The shard keeps the canonical Vitest project, the full project inventory,
 * two workers, `FLOWGUARD_PERF=0`, and the canonical coverage include/exclude
 * scope. Per-shard threshold checks are disabled because a single project is
 * not the gate; the merge job runs the canonical config with its four global
 * 80 % thresholds. The shard fails closed when the executed file inventory
 * differs from `vitest list`, or when the JSON report does not record success.
 *
 * Usage:
 *   node scripts/coverage-shard.mjs <unit|integration> [--output-dir=<path>]
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import {
  COVERAGE_MAX_WORKERS,
  COVERAGE_SHARD_NAMES,
  CoverageShardError,
  coverageProject,
  createShardManifest,
  parseCoverageInventory,
  parseShardResults,
  readVitestVersion,
  resolveCoverageIdentity,
  resolveRepoRoot,
  validateShardInventory,
} from './coverage-shards.mjs';

const repoRoot = resolveRepoRoot();
const request = process.argv.slice(2);
const shardName = request.find((value) => !value.startsWith('--'));
const outputOption = request.find((value) => value.startsWith('--output-dir='));

if (!shardName || !COVERAGE_SHARD_NAMES.includes(shardName)) {
  console.error(
    `::error::Usage: node scripts/coverage-shard.mjs <${COVERAGE_SHARD_NAMES.join('|')}> [--output-dir=<path>]`,
  );
  process.exit(2);
}

const project = coverageProject(shardName);
const outputDir = resolve(
  repoRoot,
  outputOption ? outputOption.slice('--output-dir='.length) : `coverage-shards/${shardName}`,
);
const reportDir = resolve(outputDir, 'report');
const blobPath = resolve(outputDir, 'vitest.blob.json');
const resultsPath = resolve(outputDir, 'vitest-results.json');
const manifestPath = resolve(outputDir, 'manifest.json');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    shell: true,
    encoding: 'utf8',
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

function fail(error) {
  if (error instanceof CoverageShardError) {
    console.error(`::error::[${error.code}] ${error.message}`);
  } else {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
  }
  process.exit(1);
}

try {
  const identity = resolveCoverageIdentity(process.env, () => {
    const head = run('git', ['rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'pipe'] });
    if (head.status !== 0) {
      throw new CoverageShardError(
        'COVERAGE_IDENTITY_INVALID',
        'GITHUB_SHA is unset and git rev-parse HEAD failed',
      );
    }
    return head.stdout.trim();
  });
  const vitestVersion = readVitestVersion(repoRoot);

  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(reportDir, { recursive: true });

  const coverageOverrides = ['branches', 'lines', 'functions', 'statements'].flatMap((metric) => [
    `--coverage.thresholds.${metric}=0`,
  ]);
  const args = [
    'vitest',
    'run',
    '--project',
    project,
    '--coverage',
    `--maxWorkers=${COVERAGE_MAX_WORKERS}`,
    '--coverage.reporter=json-summary',
    `--coverage.reportsDirectory=${relative(repoRoot, reportDir)}`,
    ...coverageOverrides,
    '--reporter=blob',
    '--reporter=json',
    `--outputFile.blob=${relative(repoRoot, blobPath)}`,
    `--outputFile.json=${relative(repoRoot, resultsPath)}`,
  ];

  const testRun = run('npx', args, {
    stdio: 'inherit',
    env: { ...process.env, FLOWGUARD_PERF: '0' },
  });
  if (testRun.status !== 0) {
    throw new CoverageShardError(
      'COVERAGE_SHARD_TESTS_FAILED',
      `Coverage shard ${shardName} failed with exit status ${testRun.status ?? 'null'}`,
    );
  }

  const inventoryRun = run(
    'npx',
    ['vitest', 'list', '--project', project, '--filesOnly', '--json'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (inventoryRun.status !== 0) {
    throw new CoverageShardError(
      'COVERAGE_INVENTORY_FAILED',
      `vitest list failed for ${project}: ${inventoryRun.stderr.trim()}`,
    );
  }
  const expectedFiles = parseCoverageInventory(inventoryRun.stdout, [project], repoRoot)[project];

  const results = parseShardResults(
    readFileSync(resultsPath, 'utf8'),
    testRun.status ?? 1,
    repoRoot,
  );
  const violations = validateShardInventory({
    shard: shardName,
    files: results.files,
    expectedFiles,
  });
  if (violations.length > 0) {
    throw new CoverageShardError('COVERAGE_SHARD_INCOMPLETE', violations.join('\n'));
  }

  const manifest = createShardManifest({
    shard: shardName,
    identity,
    files: results.files,
    testCount: results.testCount,
    blobPath,
    blobBytes: statSync(blobPath).size,
    vitestVersion,
    nodeVersion: process.version,
  });
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);

  // The shard report is not a gate; the merge job owns the only coverage
  // report. Keep the uploaded artifact to exactly the manifest and blob.
  rmSync(resultsPath, { force: true });
  rmSync(reportDir, { recursive: true, force: true });

  console.log(
    JSON.stringify({
      shard: shardName,
      project,
      files: manifest.results.fileCount,
      tests: manifest.results.testCount,
      blob: manifest.blob.file,
      blobBytes: manifest.blob.bytes,
      blobSha256: manifest.blob.sha256,
      vitest: manifest.vitest.version,
    }),
  );
} catch (error) {
  fail(error);
}
