/**
 * Admission verifier for mutation authority targets.
 *
 * Policy (see docs/testing-strategy.md#threshold-and-admission-rule):
 * - A targeted `--mutate` run is diagnostic only.
 * - Admission evidence is a profile full run: the aggregate score and every
 *   mutated target score must meet the profile's break threshold.
 *
 * This script reads the profile's Stryker JSON report and fails closed unless:
 * - the report exists and parses,
 * - every configured mutate target appears in the report,
 * - every target has valid mutants and meets the break threshold,
 * - the aggregate score meets the break threshold.
 *
 * `--emit-admission` prints inventory-compatible admission records (JSON) for
 * the current run; records are historical and are never rewritten by later
 * runs. The verifier is the authority for the *current* per-target threshold.
 *
 * Usage:
 *   node scripts/verify-mutation-admission.mjs --profile base
 *   node scripts/verify-mutation-admission.mjs --profile mandates --report reports/mutation/mutation.json
 *   node scripts/verify-mutation-admission.mjs --profile base --emit-admission
 *
 * All status handling is explicit: unknown mutant statuses fail the run
 * instead of being silently ignored.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

const PROFILE_CONFIG = {
  base: 'stryker.conf.json',
  'human-projection': 'stryker.human-projection.conf.json',
  'identity-jwks': 'stryker.identity-jwks.conf.json',
  mandates: 'stryker.mandates.conf.json',
};

const DETECTED_STATUSES = new Set(['Killed', 'Timeout', 'RuntimeError']);
const UNDETECTED_STATUSES = new Set(['Survived', 'NoCoverage']);
const EXCLUDED_STATUSES = new Set(['CompileError', 'Ignored']);

function fail(message) {
  console.error(`[verify-mutation-admission] ERROR: ${message}`);
  process.exit(1);
}

function parseArguments(argv) {
  const options = {
    profile: undefined,
    report: 'reports/mutation/mutation.json',
    emitAdmission: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--profile') {
      options.profile = argv[++index];
    } else if (argument === '--report') {
      options.report = argv[++index];
    } else if (argument === '--emit-admission') {
      options.emitAdmission = true;
    } else {
      fail(`unsupported argument '${argument}'`);
    }
  }
  if (options.profile === undefined) {
    fail('missing required --profile <base|human-projection|identity-jwks|mandates>');
  }
  if (!Object.hasOwn(PROFILE_CONFIG, options.profile)) {
    fail(`unknown profile '${options.profile}'`);
  }
  if (typeof options.report !== 'string' || options.report.length === 0) {
    fail('--report requires a path');
  }
  return options;
}

function targetOfSelector(selector) {
  const separator = selector.lastIndexOf(':');
  if (separator === -1) return selector;
  const suffix = selector.slice(separator + 1);
  return /^\d+-\d+$/.test(suffix) ? selector.slice(0, separator) : selector;
}

function computeMetrics(mutants) {
  const metrics = { detected: 0, undetected: 0, excluded: 0 };
  for (const mutant of mutants) {
    const status = mutant?.status;
    if (DETECTED_STATUSES.has(status)) metrics.detected++;
    else if (UNDETECTED_STATUSES.has(status)) metrics.undetected++;
    else if (EXCLUDED_STATUSES.has(status)) metrics.excluded++;
    else fail(`unknown mutant status '${String(status)}'`);
  }
  const valid = metrics.detected + metrics.undetected;
  return {
    ...metrics,
    valid,
    score: valid === 0 ? null : (metrics.detected / valid) * 100,
  };
}

function normalizeReportPath(key) {
  return key.startsWith('./') ? key.slice(2) : key;
}

const options = parseArguments(process.argv.slice(2));

const configPath = resolve(REPO_ROOT, PROFILE_CONFIG[options.profile]);
if (!existsSync(configPath)) {
  fail(`profile config not found at ${configPath}`);
}
const profileConfig = JSON.parse(readFileSync(configPath, 'utf8'));
const mutateSelectors = profileConfig.mutate ?? [];
const breakThreshold = profileConfig.thresholds?.break ?? 80;

const reportPath = resolve(process.cwd(), options.report);
if (!existsSync(reportPath)) {
  fail(
    `mutation report not found at ${reportPath}. ` +
      `Run the ${options.profile} profile full run first (targeted runs are diagnostic only).`,
  );
}
let report;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (error) {
  fail(`cannot parse mutation report at ${reportPath}: ${error?.message ?? error}`);
}
if (report?.files === null || typeof report?.files !== 'object') {
  fail(`mutation report at ${reportPath} has no 'files' object`);
}

const reportFiles = new Map();
for (const [key, value] of Object.entries(report.files)) {
  reportFiles.set(normalizeReportPath(key), value);
}

const violations = [];
const records = [];
let aggregateDetected = 0;
let aggregateValid = 0;

const seenTargets = new Set();
for (const selector of mutateSelectors) {
  const target = targetOfSelector(selector);
  seenTargets.add(target);
  const file = reportFiles.get(target);
  if (file === undefined || !Array.isArray(file.mutants)) {
    violations.push({ target, selector, problem: 'missing from report' });
    continue;
  }
  const metrics = computeMetrics(file.mutants);
  if (metrics.score === null) {
    violations.push({ target, selector, problem: 'no valid mutants' });
    continue;
  }
  aggregateDetected += metrics.detected;
  aggregateValid += metrics.valid;
  if (metrics.score < breakThreshold) {
    violations.push({
      target,
      selector,
      problem: `score ${metrics.score.toFixed(2)}% < ${breakThreshold}%`,
      score: metrics.score,
      killed: metrics.detected,
      survived: metrics.undetected,
    });
  }
  records.push({
    target,
    profile: options.profile,
    mutateSelector: selector,
    score: Number(metrics.score.toFixed(2)),
    killed: metrics.detected,
    survived: metrics.undetected,
    config: PROFILE_CONFIG[options.profile],
  });
}

const aggregateScore = aggregateValid === 0 ? null : (aggregateDetected / aggregateValid) * 100;
if (aggregateScore === null) {
  violations.push({ target: '(aggregate)', selector: '(aggregate)', problem: 'no valid mutants' });
} else if (aggregateScore < breakThreshold) {
  violations.push({
    target: '(aggregate)',
    selector: '(aggregate)',
    problem: `aggregate score ${aggregateScore.toFixed(2)}% < ${breakThreshold}%`,
  });
}

if (violations.length > 0) {
  console.error(`[verify-mutation-admission] ${violations.length} violation(s):`);
  for (const violation of violations) {
    console.error(`  - ${violation.target}: ${violation.problem}`);
  }
  process.exit(1);
}

const reportKeys = [...reportFiles.keys()].filter(
  (key) => !seenTargets.has(key) && key.includes('/') && key.endsWith('.ts'),
);

if (options.emitAdmission) {
  let commitSha = 'unknown';
  try {
    commitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim();
  } catch {}
  const verifiedAt = new Date().toISOString().slice(0, 10);
  const emitted = records.map((record) => ({
    ...record,
    admission: {
      verifiedAt,
      commitSha,
      scoreAtAdmission: record.score,
      killed: record.killed,
      survived: record.survived,
      config: record.config,
    },
  }));
  console.log(JSON.stringify(emitted, null, 2));
} else {
  console.log(
    `[verify-mutation-admission] profile=${options.profile} ` +
      `targets=${records.length} aggregate=${aggregateScore.toFixed(2)}% break=${breakThreshold}% OK`,
  );
  if (reportKeys.length > 0) {
    console.log(
      `[verify-mutation-admission] note: ${reportKeys.length} report file(s) are not profile targets`,
    );
  }
}
