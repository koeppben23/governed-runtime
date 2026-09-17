/**
 * Admission verifier for mutation authority targets.
 *
 * Policy (see docs/testing-strategy.md#threshold-and-admission-rule):
 * - A targeted `--mutate` run is diagnostic only.
 * - Admission evidence is a profile full run. The profile-wide aggregate must
 *   meet the break threshold; targets named via `--require-selectors` (new
 *   admissions, typically a newly added mutate selector or range) must
 *   additionally meet the per-target break threshold. Legacy targets outside
 *   the required set are reported as a note.
 *
 * The verifier fails closed unless:
 * - the report matches the mutation-testing-elements structure
 *   (`schemaVersion`, `thresholds`, `files[path].{language,source,mutants}`,
 *   mutants with `id`, `mutatorName`, `status` and `location`),
 * - the report's file set matches the profile's mutate selectors exactly,
 * - every selector has at least one valid mutant; range selectors are scored
 *   only over mutants whose `location` lies inside the declared line range,
 * - the aggregate and all required selectors meet the break threshold,
 * - when a manifest is supplied, profile, config digest, report digest and
 *   commit bind to the current run.
 *
 * Score semantics follow the canonical Stryker metric and the repository
 * authority `src/audit/proofgraph/mutation-report.ts`:
 *   detected   = Killed + Timeout
 *   undetected = Survived + NoCoverage
 *   excluded   = CompileError + RuntimeError + Ignored + Pending
 *
 * Usage:
 *   # verify a full run and persist admission provenance
 *   node scripts/verify-mutation-admission.mjs --profile base \
 *     --write-manifest reports/mutation/admission-manifest.json
 *
 *   # verify admission against a persisted manifest
 *   node scripts/verify-mutation-admission.mjs --profile base \
 *     --manifest reports/mutation/admission-manifest.json
 *
 *   # require newly admitted selectors to meet the per-target threshold
 *   node scripts/verify-mutation-admission.mjs --profile base \
 *     --manifest reports/mutation/admission-manifest.json \
 *     --require-selectors src/machine/topology.ts
 *
 *   # emit inventory-compatible admission records (requires a manifest)
 *   node scripts/verify-mutation-admission.mjs --profile base \
 *     --manifest reports/mutation/admission-manifest.json \
 *     --require-selectors src/machine/topology.ts --emit-admission
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

const PROFILE_CONFIG = {
  base: 'stryker.conf.json',
  'human-projection': 'stryker.human-projection.conf.json',
  'identity-jwks': 'stryker.identity-jwks.conf.json',
  mandates: 'stryker.mandates.conf.json',
};

const DETECTED_STATUSES = new Set(['Killed', 'Timeout']);
const UNDETECTED_STATUSES = new Set(['Survived', 'NoCoverage']);
const EXCLUDED_STATUSES = new Set(['CompileError', 'RuntimeError', 'Ignored', 'Pending']);
const KNOWN_STATUSES = new Set([
  ...DETECTED_STATUSES,
  ...UNDETECTED_STATUSES,
  ...EXCLUDED_STATUSES,
]);

const SCHEMA_VERSION_PATTERN = /^([1-2])(\.(([1-9]\d*)|0)){0,2}$/;
const MANIFEST_VERSION = 1;
const DEFAULT_REPORT = 'reports/mutation/mutation.json';

function fail(message) {
  console.error(`[verify-mutation-admission] ERROR: ${message}`);
  process.exit(1);
}

function parseArguments(argv) {
  const options = {
    profile: undefined,
    report: DEFAULT_REPORT,
    manifest: undefined,
    writeManifest: undefined,
    emitAdmission: false,
    commit: undefined,
    requiredSelectors: [],
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--profile') options.profile = argv[++index];
    else if (argument === '--report') options.report = argv[++index];
    else if (argument === '--manifest') options.manifest = argv[++index];
    else if (argument === '--write-manifest') options.writeManifest = argv[++index];
    else if (argument === '--emit-admission') options.emitAdmission = true;
    else if (argument === '--commit') options.commit = argv[++index];
    else if (argument === '--require-selectors') {
      const value = argv[++index];
      if (typeof value !== 'string' || value.length === 0) {
        fail('--require-selectors requires a comma-separated selector list');
      }
      options.requiredSelectors.push(
        ...value
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0),
      );
    } else fail(`unsupported argument '${argument}'`);
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
  if (
    options.commit !== undefined &&
    (typeof options.commit !== 'string' || options.commit.length === 0)
  ) {
    fail('--commit requires a value');
  }
  if (
    options.manifest !== undefined &&
    (typeof options.manifest !== 'string' || options.manifest.length === 0)
  ) {
    fail('--manifest requires a path');
  }
  if (
    options.writeManifest !== undefined &&
    (typeof options.writeManifest !== 'string' || options.writeManifest.length === 0)
  ) {
    fail('--write-manifest requires a path');
  }
  if (options.emitAdmission && options.manifest === undefined) {
    fail('--emit-admission requires --manifest (provenance must bind to a verified run)');
  }
  if (options.emitAdmission && options.requiredSelectors.length === 0) {
    fail(
      '--emit-admission requires --require-selectors (only newly admitted targets get a record)',
    );
  }
  return options;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function currentCommitSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch (error) {
    fail(`cannot resolve HEAD commit: ${error?.message ?? error}`);
  }
}

function parseSelector(selector) {
  const rangeMatch = /^(.*):(\d+)-(\d+)$/.exec(selector);
  if (rangeMatch !== null) {
    return {
      target: rangeMatch[1],
      range: { start: Number(rangeMatch[2]), end: Number(rangeMatch[3]) },
    };
  }
  return { target: selector, range: undefined };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validatePosition(value, label, problems) {
  if (!isPlainObject(value) || !Number.isInteger(value.line) || !Number.isInteger(value.column)) {
    problems.push(`${label} must be a position with integer line/column`);
    return false;
  }
  if (value.line < 1 || value.column < 1) {
    problems.push(`${label} must use 1-based line/column`);
    return false;
  }
  return true;
}

function validateReportShape(report) {
  const problems = [];
  if (!isPlainObject(report)) return ['report must be an object'];

  if (
    typeof report.schemaVersion !== 'string' ||
    !SCHEMA_VERSION_PATTERN.test(report.schemaVersion)
  ) {
    problems.push('report.schemaVersion missing or unsupported');
  }
  if (!isPlainObject(report.thresholds)) {
    problems.push('report.thresholds missing');
  }
  if (!isPlainObject(report.files)) {
    problems.push('report.files missing or not an object');
    return problems;
  }

  for (const [filePath, file] of Object.entries(report.files)) {
    if (!isPlainObject(file)) {
      problems.push(`files['${filePath}'] must be an object`);
      continue;
    }
    if (typeof file.language !== 'string') problems.push(`files['${filePath}'].language missing`);
    if (typeof file.source !== 'string') problems.push(`files['${filePath}'].source missing`);
    if (!Array.isArray(file.mutants)) {
      problems.push(`files['${filePath}'].mutants missing or not an array`);
      continue;
    }
    for (const [index, mutant] of file.mutants.entries()) {
      const label = `files['${filePath}'].mutants[${index}]`;
      if (!isPlainObject(mutant)) {
        problems.push(`${label} must be an object`);
        continue;
      }
      if (typeof mutant.id !== 'string') problems.push(`${label}.id missing`);
      if (typeof mutant.mutatorName !== 'string') problems.push(`${label}.mutatorName missing`);
      if (!KNOWN_STATUSES.has(mutant.status)) {
        problems.push(`${label}.status '${String(mutant.status)}' is not a known mutant status`);
      }
      if (!isPlainObject(mutant.location)) {
        problems.push(`${label}.location missing`);
      } else {
        validatePosition(mutant.location.start, `${label}.location.start`, problems);
        validatePosition(mutant.location.end, `${label}.location.end`, problems);
      }
    }
  }
  return problems;
}

function computeMetrics(mutants) {
  const metrics = { detected: 0, undetected: 0, excluded: 0 };
  for (const mutant of mutants) {
    if (DETECTED_STATUSES.has(mutant.status)) metrics.detected++;
    else if (UNDETECTED_STATUSES.has(mutant.status)) metrics.undetected++;
    else metrics.excluded++;
  }
  const valid = metrics.detected + metrics.undetected;
  return {
    ...metrics,
    valid,
    score: valid === 0 ? null : (metrics.detected / valid) * 100,
  };
}

function isInsideRange(mutant, range) {
  return mutant.location.start.line >= range.start && mutant.location.end.line <= range.end;
}

function selectorsByTarget(selectors) {
  const byTarget = new Map();
  for (const selector of selectors) {
    const parsed = parseSelector(selector);
    const list = byTarget.get(parsed.target) ?? [];
    list.push(parsed);
    byTarget.set(parsed.target, list);
  }
  return byTarget;
}

function validateSelectorLayout(selectors) {
  const problems = [];
  for (const [target, parsedSelectors] of selectorsByTarget(selectors)) {
    const ranges = parsedSelectors.filter((entry) => entry.range !== undefined);
    const wholeFile = parsedSelectors.filter((entry) => entry.range === undefined);
    if (wholeFile.length > 1) problems.push(`${target}: duplicate whole-file selectors`);
    if (wholeFile.length > 0 && ranges.length > 0) {
      problems.push(`${target}: whole-file and range selectors must not be mixed in one profile`);
    }
    const sorted = [...ranges].sort((left, right) => left.range.start - right.range.start);
    for (let index = 1; index < sorted.length; index++) {
      if (sorted[index].range.start <= sorted[index - 1].range.end) {
        problems.push(
          `${target}: overlapping ranges ${sorted[index - 1].range.start}-${sorted[index - 1].range.end} and ${sorted[index].range.start}-${sorted[index].range.end}`,
        );
      }
    }
  }
  return problems;
}

function verifyManifest(manifestPath, options, configPath, reportBytes) {
  if (!existsSync(manifestPath)) {
    fail(`admission manifest not found at ${manifestPath}; run with --write-manifest first`);
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    fail(`cannot parse admission manifest at ${manifestPath}: ${error?.message ?? error}`);
  }
  if (!isPlainObject(manifest) || manifest.manifestVersion !== MANIFEST_VERSION) {
    fail(`admission manifest at ${manifestPath} has an unsupported shape or version`);
  }
  const problems = [];
  if (manifest.profile !== options.profile) {
    problems.push(`profile '${String(manifest.profile)}' != '${options.profile}'`);
  }
  if (manifest.configFile !== PROFILE_CONFIG[options.profile]) {
    problems.push(
      `configFile '${String(manifest.configFile)}' != '${PROFILE_CONFIG[options.profile]}'`,
    );
  }
  const configDigest = sha256(readFileSync(configPath));
  if (manifest.configDigest !== configDigest) {
    problems.push('configDigest does not match the current profile config');
  }
  const reportDigest = sha256(reportBytes);
  if (manifest.reportDigest !== reportDigest) {
    problems.push('reportDigest does not match the current report bytes');
  }
  const expectedCommit = options.commit ?? currentCommitSha();
  if (manifest.commitSha !== expectedCommit) {
    problems.push(`commitSha '${String(manifest.commitSha)}' != '${expectedCommit}'`);
  }
  if (typeof manifest.generatedAt !== 'string' || Number.isNaN(Date.parse(manifest.generatedAt))) {
    problems.push('generatedAt missing or not an ISO timestamp');
  }
  if (problems.length > 0) {
    fail(`admission manifest mismatch:\n  - ${problems.join('\n  - ')}`);
  }
  return manifest;
}

const options = parseArguments(process.argv.slice(2));

const configPath = resolve(REPO_ROOT, PROFILE_CONFIG[options.profile]);
if (!existsSync(configPath)) fail(`profile config not found at ${configPath}`);
const configBytes = readFileSync(configPath);
const profileConfig = JSON.parse(configBytes.toString('utf8'));
const mutateSelectors = profileConfig.mutate ?? [];
const breakThreshold = profileConfig.thresholds?.break ?? 80;

const selectorProblems = validateSelectorLayout(mutateSelectors);
if (selectorProblems.length > 0) {
  fail(
    `invalid ${options.profile} mutate selector layout:\n  - ${selectorProblems.join('\n  - ')}`,
  );
}

const reportPath = resolve(process.cwd(), options.report);
if (!existsSync(reportPath)) {
  fail(
    `mutation report not found at ${reportPath}. ` +
      `Run the ${options.profile} profile full run first (targeted runs are diagnostic only).`,
  );
}
const reportBytes = readFileSync(reportPath);
let report;
try {
  report = JSON.parse(reportBytes.toString('utf8'));
} catch (error) {
  fail(`cannot parse mutation report at ${reportPath}: ${error?.message ?? error}`);
}

const shapeProblems = validateReportShape(report);
if (shapeProblems.length > 0) {
  const shown = shapeProblems.slice(0, 10);
  const rest = shapeProblems.length - shown.length;
  fail(
    `mutation report at ${reportPath} does not match the report schema:\n  - ${shown.join('\n  - ')}` +
      (rest > 0 ? `\n  - ... and ${rest} more` : ''),
  );
}

const knownSelectors = new Set(mutateSelectors);
const unknownRequired = options.requiredSelectors.filter(
  (selector) => !knownSelectors.has(selector),
);
if (unknownRequired.length > 0) {
  fail(
    `--require-selectors lists selectors that are not in ${PROFILE_CONFIG[options.profile]}: ` +
      unknownRequired.join(', '),
  );
}
const requiredSelectors = new Set(options.requiredSelectors);

const reportFiles = new Map(Object.entries(report.files));
const violations = [];
const belowThreshold = [];
const records = [];
const seenTargets = new Set();
let aggregateDetected = 0;
let aggregateValid = 0;

for (const selector of mutateSelectors) {
  const { target, range } = parseSelector(selector);
  seenTargets.add(target);
  const file = reportFiles.get(target);
  if (file === undefined) {
    if (requiredSelectors.has(selector)) {
      violations.push({ selector, problem: 'missing from report (required per-target)' });
    } else {
      belowThreshold.push({ selector, score: null, killed: 0, survived: 0 });
    }
    continue;
  }
  const mutants =
    range === undefined
      ? file.mutants
      : file.mutants.filter((mutant) => isInsideRange(mutant, range));
  const metrics = computeMetrics(mutants);
  if (metrics.score === null) {
    violations.push({
      selector,
      problem:
        range === undefined ? 'no valid mutants' : 'no valid mutants inside the declared range',
    });
    continue;
  }
  aggregateDetected += metrics.detected;
  aggregateValid += metrics.valid;
  if (metrics.score < breakThreshold) {
    if (requiredSelectors.has(selector)) {
      violations.push({
        selector,
        problem: `score ${metrics.score.toFixed(2)}% < ${breakThreshold}% (required per-target)`,
      });
    } else {
      belowThreshold.push({
        selector,
        score: metrics.score,
        killed: metrics.detected,
        survived: metrics.undetected,
      });
    }
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

const extraFiles = [...reportFiles.keys()].filter((key) => !seenTargets.has(key));
if (extraFiles.length > 0) {
  violations.push({
    target: '(report)',
    selector: '(report)',
    problem: `${extraFiles.length} file(s) are not ${options.profile} targets: ${extraFiles.slice(0, 5).join(', ')}`,
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

if (belowThreshold.length > 0) {
  console.log(
    `[verify-mutation-admission] note: ${belowThreshold.length} legacy target(s) below the ` +
      `per-target threshold but within the aggregate gate (not required per-target):`,
  );
  for (const entry of belowThreshold) {
    if (entry.score === null) {
      console.log(`  - ${entry.selector}: no mutants or missing from report`);
      continue;
    }
    console.log(
      `  - ${entry.selector}: ${entry.score.toFixed(2)}% (killed ${entry.killed}, survived ${entry.survived})`,
    );
  }
}

if (violations.length > 0) {
  console.error(`[verify-mutation-admission] ${violations.length} violation(s):`);
  for (const violation of violations)
    console.error(`  - ${violation.selector}: ${violation.problem}`);
  process.exit(1);
}

let manifest = undefined;
if (options.manifest !== undefined) {
  manifest = verifyManifest(
    resolve(process.cwd(), options.manifest),
    options,
    configPath,
    reportBytes,
  );
}

if (options.writeManifest !== undefined) {
  const manifestPath = resolve(process.cwd(), options.writeManifest);
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        manifestVersion: MANIFEST_VERSION,
        profile: options.profile,
        configFile: PROFILE_CONFIG[options.profile],
        configDigest: sha256(configBytes),
        commitSha: options.commit ?? currentCommitSha(),
        reportDigest: sha256(reportBytes),
        generatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  console.log(`[verify-mutation-admission] manifest written to ${manifestPath}`);
}

if (options.emitAdmission) {
  const emitted = records
    .filter((record) => requiredSelectors.has(record.mutateSelector))
    .map((record) => ({
      ...record,
      admission: {
        verifiedAt: manifest.generatedAt.slice(0, 10),
        commitSha: manifest.commitSha,
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
}
