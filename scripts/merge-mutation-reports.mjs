#!/usr/bin/env node

/**
 * Merge disjoint mutation shard reports into the canonical profile report.
 *
 * The merge is the admission boundary: it fails closed unless every planned
 * target appears exactly once, each shard used the canonical measurement
 * settings, and the only shard-specific overrides are the mutate subset and a
 * disabled per-shard break threshold. The merged report then passes through
 * `verify-mutation-admission.mjs` with the unchanged profile thresholds.
 *
 * Usage:
 *   node scripts/merge-mutation-reports.mjs --profile base --shard-count 8 \
 *     --input-dir reports/mutation/shards --output reports/mutation/mutation.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadShardPlan, mutationTargetOf } from './mutation-shard-plan.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

function fail(message) {
  throw new Error(`[merge-mutation-reports] ${message}`);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sorted(values) {
  return [...values].sort();
}

function sameSet(left, right) {
  return sameJson(sorted(left), sorted(right));
}

function requireField(condition, shardIndex, message) {
  if (!condition) fail(`shard ${shardIndex}: ${message}`);
}

function validateShardReport({ report, config, shard, shardIndex }) {
  requireField(isPlainObject(report), shardIndex, 'report must be an object');
  requireField(typeof report.schemaVersion === 'string', shardIndex, 'schemaVersion is missing');
  requireField(isPlainObject(report.thresholds), shardIndex, 'thresholds are missing');
  requireField(isPlainObject(report.files), shardIndex, 'files are missing');
  requireField(isPlainObject(report.config), shardIndex, 'config is missing');

  requireField(
    report.thresholds.high === config.thresholds.high &&
      report.thresholds.low === config.thresholds.low &&
      report.thresholds.break === 0,
    shardIndex,
    'thresholds must keep high/low and disable only break',
  );
  const reportConfig = report.config;
  requireField(
    isPlainObject(reportConfig.thresholds) &&
      reportConfig.thresholds.high === config.thresholds.high &&
      reportConfig.thresholds.low === config.thresholds.low &&
      reportConfig.thresholds.break === 0,
    shardIndex,
    'config.thresholds must keep high/low and disable only break',
  );
  requireField(
    Array.isArray(reportConfig.mutate) && sameSet(reportConfig.mutate, shard.selectors),
    shardIndex,
    'config.mutate must equal the planned shard selectors',
  );

  for (const field of [
    'testRunner',
    'coverageAnalysis',
    'ignoreStatic',
    'checkers',
    'tsconfigFile',
    'vitest',
    'reporters',
    'jsonReporter',
  ]) {
    requireField(
      sameJson(reportConfig[field], config[field]),
      shardIndex,
      `config.${field} differs from the canonical profile`,
    );
  }
  requireField(
    sameJson(reportConfig.mutator?.excludedMutations, config.mutator?.excludedMutations),
    shardIndex,
    'config.mutator.excludedMutations differs from the canonical profile',
  );
  for (const field of ['packageManager', 'concurrency', 'dryRunTimeoutMinutes']) {
    if (config[field] !== undefined) {
      requireField(
        sameJson(reportConfig[field], config[field]),
        shardIndex,
        `config.${field} differs from the canonical profile`,
      );
    }
  }

  const reportTargets = Object.keys(report.files);
  requireField(
    sameSet(reportTargets, shard.targets),
    shardIndex,
    `files must contain exactly the planned targets (planned ${shard.targets.length}, reported ${reportTargets.length})`,
  );
}

function mergeTestFiles(reports) {
  const withTestFiles = reports.filter((report) => report.testFiles !== undefined);
  if (withTestFiles.length === 0) return undefined;
  if (withTestFiles.length !== reports.length) {
    fail('every shard must report testFiles when one shard does');
  }
  for (const report of withTestFiles) {
    if (!isPlainObject(report.testFiles)) fail('testFiles must be an object');
  }
  const expected = Object.keys(withTestFiles[0].testFiles);
  for (const [index, report] of withTestFiles.entries()) {
    if (!sameSet(Object.keys(report.testFiles), expected)) {
      fail(`shard ${index}: testFiles key set differs from shard 0`);
    }
  }
  return withTestFiles[0].testFiles;
}

/**
 * @param {{ config: Record<string, unknown>, plan: { shards: Array<{ index: number,
 *   selectors: string[], targets: string[] }> }, reports: readonly Record<string,
 *   unknown>[], projectRoot?: string }} input
 * @returns {Record<string, unknown>}
 */
export function mergeShardReports({ config, plan, reports, projectRoot }) {
  if (!Array.isArray(plan?.shards) || plan.shards.length === 0) {
    fail('the shard plan is empty');
  }
  if (!Array.isArray(reports) || reports.length !== plan.shards.length) {
    fail(`expected ${plan.shards.length} shard report(s), received ${reports?.length ?? 0}`);
  }
  const schemaVersion = reports[0]?.schemaVersion;
  for (const [index, report] of reports.entries()) {
    const shard = plan.shards[index];
    if (shard.index !== index) fail(`shard plan order is invalid at ${index}`);
    validateShardReport({ report, config, shard, shardIndex: index });
    if (report.schemaVersion !== schemaVersion) {
      fail(`shard ${index}: schemaVersion differs from shard 0`);
    }
  }

  const targetOrder = new Map();
  for (const selector of config.mutate) {
    const target = mutationTargetOf(selector);
    if (!targetOrder.has(target)) targetOrder.set(target, targetOrder.size);
  }
  const files = {};
  const seen = new Set();
  for (const [index, report] of reports.entries()) {
    for (const target of plan.shards[index].targets) {
      if (seen.has(target)) fail(`target '${target}' appears in more than one shard`);
      seen.add(target);
      files[target] = report.files[target];
    }
  }
  const missing = [...targetOrder.keys()].filter((target) => !seen.has(target));
  if (missing.length > 0) {
    fail(`merged report is missing ${missing.length} target(s): ${missing.slice(0, 5).join(', ')}`);
  }
  const orderedFiles = {};
  for (const target of targetOrder.keys()) orderedFiles[target] = files[target];

  const testFiles = mergeTestFiles(reports);
  const merged = {
    ...reports[0],
    ...(projectRoot === undefined ? {} : { projectRoot }),
    thresholds: { ...config.thresholds },
    config: {
      ...reports[0].config,
      mutate: [...config.mutate],
      thresholds: { ...config.thresholds },
    },
    files: orderedFiles,
  };
  if (testFiles === undefined) delete merged.testFiles;
  else merged.testFiles = testFiles;
  return merged;
}

function parseArguments(argv) {
  const options = {
    profile: undefined,
    shardCount: undefined,
    inputDir: undefined,
    output: undefined,
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--profile') options.profile = argv[++index];
    else if (argument === '--shard-count') options.shardCount = Number(argv[++index]);
    else if (argument === '--input-dir') options.inputDir = argv[++index];
    else if (argument === '--output') options.output = argv[++index];
    else fail(`unsupported argument '${argument}'`);
  }
  if (typeof options.profile !== 'string' || options.profile.length === 0) {
    fail('missing --profile');
  }
  if (!Number.isInteger(options.shardCount) || options.shardCount < 1) {
    fail('--shard-count must be a positive integer');
  }
  if (typeof options.inputDir !== 'string' || options.inputDir.length === 0) {
    fail('missing --input-dir');
  }
  if (typeof options.output !== 'string' || options.output.length === 0) {
    fail('missing --output');
  }
  return options;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const plan = loadShardPlan({
    repoRoot: REPO_ROOT,
    profile: options.profile,
    shardCount: options.shardCount,
  });
  const inputDir = resolve(REPO_ROOT, options.inputDir);
  const reports = plan.shards.map((shard) => {
    const reportPath = resolve(inputDir, `shard-${shard.index}.json`);
    if (!existsSync(reportPath)) {
      fail(`missing shard report ${reportPath}`);
    }
    try {
      return JSON.parse(readFileSync(reportPath, 'utf8'));
    } catch (error) {
      fail(`cannot parse ${reportPath}: ${error instanceof Error ? error.message : error}`);
    }
  });
  const merged = mergeShardReports({
    config: plan.config,
    plan,
    reports,
    projectRoot: REPO_ROOT,
  });
  const outputPath = resolve(REPO_ROOT, options.output);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  const mutants = Object.values(merged.files).reduce(
    (total, file) => total + file.mutants.length,
    0,
  );
  console.log(
    `[merge-mutation-reports] profile=${plan.profile} shards=${plan.shards.length} ` +
      `targets=${Object.keys(merged.files).length} mutants=${mutants} output=${options.output}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
