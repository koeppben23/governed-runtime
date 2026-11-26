#!/usr/bin/env node
/**
 * @module scripts/coverage-merge
 * @description Merge the instrumented CI coverage shards and enforce the one
 * canonical coverage gate.
 *
 * Completeness is fail-closed before Vitest runs: every canonical shard must
 * contribute exactly one manifest and one blob for the same commit, workflow
 * run and run attempt; the blobs must carry coverage data and the same file
 * inventory as their manifest. The two file sets must be disjoint and their
 * union must equal `vitest list` for the canonical projects. The merge then
 * runs the canonical config and its four global 80 % thresholds without any
 * threshold override.
 *
 * Usage:
 *   node scripts/coverage-merge.mjs --ci [--input-dir=<path>] [--reports-dir=<path>]
 */

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { relative, resolve } from 'node:path';

import {
  COVERAGE_SHARDS,
  COVERAGE_SHARD_NAMES,
  CoverageShardError,
  normalizeCoveragePath,
  parseCoverageInventory,
  readVitestVersion,
  resolveCoverageIdentity,
  resolveRepoRoot,
  sha256File,
  validateCoverageShardSet,
} from './coverage-shards.mjs';

const require = createRequire(import.meta.url);
const { parse: parseFlatted } = require('flatted');

const repoRoot = resolveRepoRoot();
const args = process.argv.slice(2);
const inputOption = args.find((value) => value.startsWith('--input-dir='));
const reportsOption = args.find((value) => value.startsWith('--reports-dir='));
const inputDir = resolve(
  repoRoot,
  inputOption ? inputOption.slice('--input-dir='.length) : 'coverage-shards',
);
const reportsDir = resolve(
  repoRoot,
  reportsOption ? reportsOption.slice('--reports-dir='.length) : 'coverage',
);

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    shell: true,
    encoding: 'utf8',
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

function reportFailure(error) {
  if (error instanceof CoverageShardError) {
    console.error(`::error::[${error.code}] ${error.message}`);
  } else {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
  }
  return 1;
}

function inspectBlob(blobPath) {
  const content = readFileSync(blobPath, 'utf8');
  let parsed;
  try {
    parsed = parseFlatted(content);
  } catch (error) {
    throw new CoverageShardError(
      'COVERAGE_BLOB_INVALID',
      `Coverage blob is not a valid Vitest blob: ${blobPath}`,
      { cause: error },
    );
  }
  const [version, files, errors, coverage] = parsed;
  if (typeof version !== 'string') {
    throw new CoverageShardError(
      'COVERAGE_BLOB_INVALID',
      `Coverage blob has no Vitest version: ${blobPath}`,
    );
  }
  if (!Array.isArray(files)) {
    throw new CoverageShardError(
      'COVERAGE_BLOB_INVALID',
      `Coverage blob has no test file list: ${blobPath}`,
    );
  }
  if (!Array.isArray(errors)) {
    throw new CoverageShardError(
      'COVERAGE_BLOB_INVALID',
      `Coverage blob has no unhandled-error list: ${blobPath}`,
    );
  }
  if (errors.length > 0) {
    throw new CoverageShardError(
      'COVERAGE_BLOB_ERRORS',
      `Coverage blob records unhandled errors: ${blobPath}`,
    );
  }
  const blobFiles = files.map((file) => {
    const name = file && typeof file === 'object' ? (file.name ?? file.filepath) : undefined;
    return normalizeCoveragePath(name, repoRoot);
  });
  return {
    version,
    files: blobFiles,
    hasCoverage:
      Boolean(coverage) &&
      typeof coverage === 'object' &&
      !Array.isArray(coverage) &&
      Object.keys(coverage).length > 0,
    sha256: sha256File(blobPath),
    bytes: statSync(blobPath).size,
  };
}

function readShardArtifact(shard) {
  const directory = resolve(inputDir, shard.name);
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    return { manifest: undefined, blobFacts: undefined };
  }
  const entries = readdirSync(directory).sort();
  const manifestPath = resolve(directory, 'manifest.json');
  if (!entries.includes('manifest.json') || !existsSync(manifestPath)) {
    throw new CoverageShardError(
      'COVERAGE_SHARD_MANIFEST_MISSING',
      `${shard.name}: manifest.json is missing from ${directory}`,
    );
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new CoverageShardError(
      'COVERAGE_SHARD_MANIFEST_INVALID',
      `${shard.name}: manifest.json is not valid JSON`,
      { cause: error },
    );
  }
  const blobFile = manifest?.blob?.file;
  if (typeof blobFile !== 'string' || !/^[A-Za-z0-9._-]+$/.test(blobFile)) {
    throw new CoverageShardError(
      'COVERAGE_SHARD_MANIFEST_INVALID',
      `${shard.name}: manifest does not name a safe blob file`,
    );
  }
  const expectedEntries = ['manifest.json', blobFile].sort();
  if (
    entries.length !== expectedEntries.length ||
    entries.some((entry, i) => entry !== expectedEntries[i])
  ) {
    throw new CoverageShardError(
      'COVERAGE_SHARD_FOREIGN_ARTIFACT',
      `${shard.name}: artifact must contain exactly manifest.json and ${blobFile}, found ${entries.join(', ')}`,
    );
  }
  const blobPath = resolve(directory, blobFile);
  return { manifest, blobFacts: inspectBlob(blobPath) };
}

const mergeInputDir = resolve(inputDir, '.merge-input');
let exitStatus = 0;
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
  const installedVitestVersion = readVitestVersion(repoRoot);

  const inventoryRun = run(
    'npx',
    [
      'vitest',
      'list',
      '--project',
      COVERAGE_SHARDS[0].project,
      '--project',
      COVERAGE_SHARDS[1].project,
      '--filesOnly',
      '--json',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (inventoryRun.status !== 0) {
    throw new CoverageShardError(
      'COVERAGE_INVENTORY_FAILED',
      `vitest list failed: ${inventoryRun.stderr.trim()}`,
    );
  }
  const expectedFilesByProject = parseCoverageInventory(
    inventoryRun.stdout,
    COVERAGE_SHARDS.map((shard) => shard.project),
    repoRoot,
  );

  const artifacts = new Map();
  for (const shard of COVERAGE_SHARDS) {
    artifacts.set(shard.name, readShardArtifact(shard));
  }
  const blobFacts = new Map(
    [...artifacts].flatMap(([name, artifact]) =>
      artifact.blobFacts ? [[name, artifact.blobFacts]] : [],
    ),
  );
  const violations = validateCoverageShardSet({
    manifests: COVERAGE_SHARDS.flatMap((shard) => {
      const manifest = artifacts.get(shard.name)?.manifest;
      return manifest ? [manifest] : [];
    }),
    blobFacts,
    expectedFilesByProject,
    identity,
    installedVitestVersion,
  });
  if (violations.length > 0) {
    throw new CoverageShardError('COVERAGE_SHARDS_INCOMPLETE', violations.join('\n'));
  }

  rmSync(mergeInputDir, { recursive: true, force: true });
  mkdirSync(mergeInputDir, { recursive: true });
  for (const shard of COVERAGE_SHARDS) {
    copyFileSync(
      resolve(inputDir, shard.name, artifacts.get(shard.name).manifest.blob.file),
      resolve(mergeInputDir, `${shard.name}.blob.json`),
    );
  }

  rmSync(reportsDir, { recursive: true, force: true });
  const merged = run(
    'npx',
    [
      'vitest',
      'run',
      `--merge-reports=${relative(repoRoot, mergeInputDir)}`,
      '--coverage',
      '--coverage.reporter=json-summary',
      `--coverage.reportsDirectory=${relative(repoRoot, reportsDir)}`,
    ],
    {
      stdio: 'inherit',
      env: { ...process.env, FLOWGUARD_PERF: '0' },
    },
  );
  if (merged.status !== 0) {
    throw new CoverageShardError(
      'COVERAGE_GATE_FAILED',
      `Merged coverage gate failed with exit status ${merged.status ?? 'null'}`,
    );
  }

  const summaryPath = resolve(reportsDir, 'coverage-summary.json');
  if (!existsSync(summaryPath)) {
    throw new CoverageShardError(
      'COVERAGE_SUMMARY_MISSING',
      'Merged coverage did not produce coverage-summary.json',
    );
  }
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  const metrics = ['branches', 'functions', 'lines', 'statements'];
  for (const metric of metrics) {
    const value = summary?.total?.[metric];
    if (!value || !Number.isInteger(value.total) || value.total <= 0) {
      throw new CoverageShardError(
        'COVERAGE_SUMMARY_INVALID',
        `Merged coverage summary has no valid ${metric} totals`,
      );
    }
  }
  const sourceFiles = Object.keys(summary).filter((key) => key !== 'total').length;
  if (sourceFiles === 0) {
    throw new CoverageShardError(
      'COVERAGE_SUMMARY_INVALID',
      'Merged coverage summary contains no source files',
    );
  }
  console.log(
    JSON.stringify({
      shards: COVERAGE_SHARD_NAMES,
      files: sourceFiles,
      totals: Object.fromEntries(
        metrics.map((metric) => [
          metric,
          {
            covered: summary.total[metric].covered,
            total: summary.total[metric].total,
          },
        ]),
      ),
    }),
  );
} catch (error) {
  exitStatus = reportFailure(error);
} finally {
  rmSync(mergeInputDir, { recursive: true, force: true });
}
process.exit(exitStatus);
