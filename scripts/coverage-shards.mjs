/**
 * @module scripts/coverage-shards
 * @description Shared authority for distributed CI coverage execution.
 *
 * The CI coverage gate keeps the canonical `unit` and `integration` Vitest
 * projects, the canonical coverage include/exclude scope, two instrumented
 * workers per runner, and the four global 80 % thresholds. Only the execution
 * topology changes: each project runs on its own runner, and the merge job
 * combines the native Vitest coverage blobs.
 *
 * This module owns the shard identity, manifest schema, path normalization and
 * completeness validation. Shard runs collect data; only the merge job (and
 * this validator) may declare the combined result complete. Missing, extra,
 * duplicated, foreign or coverage-less shard artifacts are violations.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const COVERAGE_SHARD_SCHEMA = 'flowguard-coverage-shard/v1';

/** One entry per instrumented runner. Order defines the canonical artifact set. */
export const COVERAGE_SHARDS = Object.freeze([
  Object.freeze({ name: 'unit', project: 'unit' }),
  Object.freeze({ name: 'integration', project: 'integration' }),
]);

export const COVERAGE_SHARD_NAMES = Object.freeze(COVERAGE_SHARDS.map((shard) => shard.name));

/** Upper bound for instrumented workers; unchanged from the monolithic CI run. */
export const COVERAGE_MAX_WORKERS = 2;

/** Typed failure for coverage shard and merge boundaries. */
export class CoverageShardError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'CoverageShardError';
    this.code = code;
  }
}

/** Resolve the repository root from this module location. */
export function resolveRepoRoot() {
  return resolve(import.meta.dirname, '..');
}

/**
 * Normalize a Vitest-reported test path to a repository-relative POSIX path.
 * Throws for empty values and paths outside the repository.
 *
 * @param {string} value
 * @param {string} repoRoot
 */
export function normalizeCoveragePath(value, repoRoot) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CoverageShardError(
      'COVERAGE_PATH_INVALID',
      `Coverage path must be a non-empty string, received ${JSON.stringify(value)}`,
    );
  }
  const absolute = isAbsolute(value) ? resolve(value) : resolve(repoRoot, value);
  const repoRelative = relative(repoRoot, absolute);
  if (repoRelative === '' || repoRelative.startsWith('..') || isAbsolute(repoRelative)) {
    throw new CoverageShardError(
      'COVERAGE_PATH_OUTSIDE_REPO',
      `Coverage path is outside the repository: ${value}`,
    );
  }
  return repoRelative.split(sep).join('/');
}

/** SHA-256 digest for a blob or manifest file. */
export function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/** Read the installed Vitest version from its package metadata. */
export function readVitestVersion(repoRoot) {
  return JSON.parse(readFileSync(resolve(repoRoot, 'node_modules/vitest/package.json'), 'utf8'))
    .version;
}

/** Return the shard descriptor for a canonical shard name. */
export function coverageShard(name) {
  const shard = COVERAGE_SHARDS.find((candidate) => candidate.name === name);
  if (!shard) {
    throw new CoverageShardError(
      'COVERAGE_SHARD_UNKNOWN',
      `Unknown coverage shard ${JSON.stringify(name)}; expected one of ${COVERAGE_SHARD_NAMES.join(', ')}`,
    );
  }
  return shard;
}

/** Project name for a canonical shard name. */
export function coverageProject(name) {
  return coverageShard(name).project;
}

/**
 * Resolve the identity that binds every shard and the merge to one commit and
 * workflow execution. Local runs fall back to the checked-out commit and
 * literal `local` run identifiers so the same fail-closed path is exercised.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {(args: string[]) => string} [gitHead]
 */
export function resolveCoverageIdentity(env = process.env, gitHead) {
  const commit = (env.GITHUB_SHA ?? '').trim() || (gitHead?.() ?? '').trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new CoverageShardError(
      'COVERAGE_IDENTITY_INVALID',
      'Coverage identity requires GITHUB_SHA or a resolvable checked-out commit',
    );
  }
  const runId = (env.GITHUB_RUN_ID ?? '').trim() || 'local';
  const runAttempt = (env.GITHUB_RUN_ATTEMPT ?? '').trim() || '1';
  if (!/^(?:local|[0-9]+)$/.test(runId)) {
    throw new CoverageShardError(
      'COVERAGE_IDENTITY_INVALID',
      `Coverage run id must be numeric or "local", received ${JSON.stringify(runId)}`,
    );
  }
  if (!/^[1-9][0-9]*$/.test(runAttempt)) {
    throw new CoverageShardError(
      'COVERAGE_IDENTITY_INVALID',
      `Coverage run attempt must be a positive integer, received ${JSON.stringify(runAttempt)}`,
    );
  }
  return { commit, runId, runAttempt };
}

/**
 * Parse `vitest list --filesOnly --json` output into project inventories.
 *
 * @param {string} stdout
 * @param {string[]} projects
 * @param {string} repoRoot
 * @returns {Record<string, Set<string>>}
 */
export function parseCoverageInventory(stdout, projects, repoRoot) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new CoverageShardError(
      'COVERAGE_INVENTORY_INVALID',
      'vitest list did not return valid JSON',
      { cause: error },
    );
  }
  if (!Array.isArray(parsed)) {
    throw new CoverageShardError(
      'COVERAGE_INVENTORY_INVALID',
      'vitest list returned a non-array inventory',
    );
  }
  const inventories = Object.fromEntries(projects.map((project) => [project, new Set()]));
  for (const entry of parsed) {
    if (!entry || typeof entry.file !== 'string' || typeof entry.projectName !== 'string') {
      throw new CoverageShardError(
        'COVERAGE_INVENTORY_INVALID',
        `vitest list entry is malformed: ${JSON.stringify(entry)}`,
      );
    }
    const files = inventories[entry.projectName];
    if (!files) {
      throw new CoverageShardError(
        'COVERAGE_INVENTORY_INVALID',
        `vitest list returned unexpected project ${JSON.stringify(entry.projectName)}`,
      );
    }
    files.add(normalizeCoveragePath(entry.file, repoRoot));
  }
  for (const [project, files] of Object.entries(inventories)) {
    if (files.size === 0) {
      throw new CoverageShardError(
        'COVERAGE_INVENTORY_EMPTY',
        `vitest list returned no files for project ${project}`,
      );
    }
  }
  return inventories;
}

/**
 * Parse the JSON reporter output of one shard.
 *
 * @param {string} stdout
 * @param {number} exitStatus
 * @param {string} repoRoot
 */
export function parseShardResults(stdout, exitStatus, repoRoot) {
  if (exitStatus !== 0) {
    throw new CoverageShardError(
      'COVERAGE_SHARD_TESTS_FAILED',
      `Coverage shard tests failed with exit status ${exitStatus}`,
    );
  }
  let report;
  try {
    report = JSON.parse(stdout);
  } catch (error) {
    throw new CoverageShardError(
      'COVERAGE_SHARD_RESULTS_INVALID',
      'Coverage shard JSON report is not valid JSON',
      { cause: error },
    );
  }
  if (report?.success !== true) {
    throw new CoverageShardError(
      'COVERAGE_SHARD_TESTS_FAILED',
      'Coverage shard JSON report does not record success',
    );
  }
  const testResults = Array.isArray(report.testResults) ? report.testResults : [];
  if (testResults.length === 0) {
    throw new CoverageShardError(
      'COVERAGE_SHARD_EMPTY',
      'Coverage shard JSON report contains no test files',
    );
  }
  const files = testResults.map((result) => normalizeCoveragePath(result?.name, repoRoot));
  const testCount = report.numTotalTests;
  return { files, testCount };
}

/**
 * Validate the collected file list of one shard against the expected project
 * inventory. Used by the shard runner before it writes a manifest.
 *
 * @param {{ shard: string, files: string[], expectedFiles: Set<string> }} input
 */
export function validateShardInventory({ shard, files, expectedFiles }) {
  const violations = [];
  const project = coverageProject(shard);
  const unique = new Set(files);
  if (unique.size !== files.length) {
    violations.push(`${shard}: duplicate executed test file entries`);
  }
  for (const file of files) {
    if (!expectedFiles.has(file)) {
      violations.push(`${shard}: executed file is not in the ${project} inventory: ${file}`);
    }
  }
  for (const file of expectedFiles) {
    if (!unique.has(file)) {
      violations.push(`${shard}: expected ${project} test file did not execute: ${file}`);
    }
  }
  return violations;
}

/**
 * Build the immutable shard manifest written next to the Vitest blob.
 *
 * @param {{
 *   shard: string,
 *   identity: { commit: string, runId: string, runAttempt: string },
 *   files: string[],
 *   testCount: number,
 *   blobPath: string,
 *   blobBytes: number,
 *   vitestVersion: string,
 *   nodeVersion: string,
 * }} input
 */
export function createShardManifest(input) {
  const shard = coverageShard(input.shard);
  const files = [...input.files].sort();
  if (files.length === 0) {
    throw new CoverageShardError('COVERAGE_SHARD_EMPTY', `${shard.name}: no executed test files`);
  }
  if (new Set(files).size !== files.length) {
    throw new CoverageShardError(
      'COVERAGE_SHARD_DUPLICATE',
      `${shard.name}: duplicate executed test files`,
    );
  }
  if (!Number.isInteger(input.testCount) || input.testCount < files.length) {
    throw new CoverageShardError(
      'COVERAGE_SHARD_COUNT_INVALID',
      `${shard.name}: test count ${input.testCount} is not a positive integer covering ${files.length} files`,
    );
  }
  return {
    schema: COVERAGE_SHARD_SCHEMA,
    shard: shard.name,
    project: shard.project,
    identity: { ...input.identity },
    vitest: { version: input.vitestVersion, node: input.nodeVersion },
    blob: {
      file: input.blobPath.split(/[\\/]/).at(-1),
      sha256: sha256File(input.blobPath),
      bytes: input.blobBytes,
    },
    results: {
      fileCount: files.length,
      testCount: input.testCount,
      files,
    },
  };
}

/**
 * Authoritative completeness validation across all shard artifacts.
 *
 * `blobFacts` carries what the merge job independently read from each blob:
 * its Vitest version, whether it contains coverage data, and the file names it
 * recorded. A blob that is present but carries no coverage is not acceptable.
 *
 * @param {{
 *   manifests: unknown[],
 *   blobFacts: Map<string, { version?: string, hasCoverage?: boolean, files?: string[], sha256?: string, bytes?: number }>,
 *   expectedFilesByProject: Record<string, Set<string>>,
 *   identity: { commit: string, runId: string, runAttempt: string },
 *   installedVitestVersion: string,
 * }} input
 */
export function validateCoverageShardSet(input) {
  const violations = [];
  const manifests = Array.isArray(input.manifests) ? input.manifests : [];
  const expectedProjects = new Map(COVERAGE_SHARDS.map((shard) => [shard.project, shard.name]));
  const byShard = new Map();

  if (manifests.length !== COVERAGE_SHARDS.length) {
    violations.push(
      `expected exactly ${COVERAGE_SHARDS.length} shard manifests, received ${manifests.length}`,
    );
  }

  for (const value of manifests) {
    if (!value || typeof value !== 'object') {
      violations.push('shard manifest is not an object');
      continue;
    }
    const manifest = /** @type {Record<string, any>} */ (value);
    if (manifest.schema !== COVERAGE_SHARD_SCHEMA) {
      violations.push(`unexpected shard manifest schema: ${JSON.stringify(manifest.schema)}`);
      continue;
    }
    if (!COVERAGE_SHARD_NAMES.includes(manifest.shard)) {
      violations.push(`foreign shard name: ${JSON.stringify(manifest.shard)}`);
      continue;
    }
    if (byShard.has(manifest.shard)) {
      violations.push(`duplicate shard manifest: ${manifest.shard}`);
      continue;
    }
    byShard.set(manifest.shard, manifest);
  }

  for (const shard of COVERAGE_SHARDS) {
    if (!byShard.has(shard.name)) {
      violations.push(`missing shard manifest: ${shard.name}`);
      continue;
    }
    const manifest = byShard.get(shard.name);
    if (manifest.project !== shard.project) {
      violations.push(`${shard.name}: project ${manifest.project} is not ${shard.project}`);
    }
    for (const key of ['commit', 'runId']) {
      if (manifest.identity?.[key] !== input.identity[key]) {
        violations.push(
          `${shard.name}: identity.${key} ${JSON.stringify(manifest.identity?.[key])} does not match ${JSON.stringify(input.identity[key])}`,
        );
      }
    }
    if (manifest.vitest?.version !== input.installedVitestVersion) {
      violations.push(
        `${shard.name}: Vitest ${JSON.stringify(manifest.vitest?.version)} does not match installed ${input.installedVitestVersion}`,
      );
    }

    const files = Array.isArray(manifest.results?.files) ? manifest.results.files : [];
    const expected = input.expectedFilesByProject[shard.project];
    if (!(expected instanceof Set) || expected.size === 0) {
      violations.push(`${shard.project}: expected inventory is empty or missing`);
    } else {
      if (manifest.results?.fileCount !== files.length) {
        violations.push(
          `${shard.name}: fileCount ${manifest.results?.fileCount} does not match ${files.length} files`,
        );
      }
      if (!Number.isInteger(manifest.results?.testCount) || manifest.results.testCount < 1) {
        violations.push(`${shard.name}: invalid testCount ${manifest.results?.testCount}`);
      }
      const unique = new Set(files);
      if (unique.size !== files.length) violations.push(`${shard.name}: duplicate test files`);
      for (const file of files) {
        if (typeof file !== 'string' || !expected.has(file)) {
          violations.push(`${shard.name}: unexpected test file ${JSON.stringify(file)}`);
        }
      }
      for (const file of expected) {
        if (!unique.has(file)) violations.push(`${shard.name}: missing test file ${file}`);
      }
    }

    const blob = manifest.blob;
    if (!blob || typeof blob.file !== 'string' || !/^[A-Za-z0-9._-]+$/.test(blob.file)) {
      violations.push(`${shard.name}: invalid blob file name`);
    }
    if (!/^[0-9a-f]{64}$/.test(blob?.sha256 ?? '')) {
      violations.push(`${shard.name}: invalid blob sha256`);
    }
    if (!Number.isInteger(blob?.bytes) || blob.bytes <= 0) {
      violations.push(`${shard.name}: invalid blob byte size`);
    }

    const facts = input.blobFacts.get(shard.name);
    if (!facts) {
      violations.push(`${shard.name}: blob was not inspected`);
      continue;
    }
    if (facts.version !== input.installedVitestVersion) {
      violations.push(
        `${shard.name}: blob Vitest ${JSON.stringify(facts.version)} does not match installed ${input.installedVitestVersion}`,
      );
    }
    if (facts.hasCoverage !== true) {
      violations.push(`${shard.name}: blob contains no coverage data`);
    }
    if (facts.sha256 !== blob?.sha256) {
      violations.push(`${shard.name}: blob sha256 does not match the manifest`);
    }
    if (facts.bytes !== blob?.bytes) {
      violations.push(`${shard.name}: blob size does not match the manifest`);
    }
    const blobFiles = Array.isArray(facts.files) ? facts.files : [];
    const manifestFiles = new Set(files);
    if (blobFiles.length !== files.length) {
      violations.push(
        `${shard.name}: blob recorded ${blobFiles.length} files, manifest ${files.length}`,
      );
    }
    for (const file of blobFiles) {
      if (!manifestFiles.has(file)) {
        violations.push(`${shard.name}: blob recorded unmanifested file ${file}`);
      }
    }
  }

  const observed = [...byShard.values()];
  for (let left = 0; left < observed.length; left += 1) {
    for (let right = left + 1; right < observed.length; right += 1) {
      const a = observed[left];
      const b = observed[right];
      const aFiles = new Set(Array.isArray(a.results?.files) ? a.results.files : []);
      for (const file of Array.isArray(b.results?.files) ? b.results.files : []) {
        if (aFiles.has(file)) {
          violations.push(`test file appears in both ${a.shard} and ${b.shard}: ${file}`);
        }
      }
    }
  }

  const union = new Set(observed.flatMap((manifest) => manifest.results?.files ?? []));
  const expectedUnion = new Set(
    Object.entries(input.expectedFilesByProject)
      .filter(([project]) => expectedProjects.has(project))
      .flatMap(([, files]) => [...files]),
  );
  for (const file of expectedUnion) {
    if (!union.has(file)) violations.push(`merged inventory is missing ${file}`);
  }
  for (const file of union) {
    if (!expectedUnion.has(file)) violations.push(`merged inventory has unexpected ${file}`);
  }

  return violations;
}
