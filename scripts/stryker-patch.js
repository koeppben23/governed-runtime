/**
 * Pre-flight patches for @stryker-mutator/vitest-runner 10.0.0.
 *
 * This version of the runner hardcodes worker threads, which breaks tests that
 * call process.chdir(), and builds Vitest 5 test filters with space-separated
 * names. Vitest 5 uses ` > ` between nested suite names, so that filter skips
 * every selected nested test.
 *
 * This script runs only before mutation testing. It deliberately fails for an
 * unsupported dependency or artifact shape instead of silently patching an
 * unknown Stryker release.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const RUNNER_ROOT = resolve(__dirname, '../node_modules/@stryker-mutator/vitest-runner');
const RUNNER_PACKAGE = resolve(RUNNER_ROOT, 'package.json');
const VITEST_PACKAGE = resolve(__dirname, '../node_modules/vitest/package.json');

const POOL_PATCH = {
  label: 'Vitest pool configuration',
  target: resolve(RUNNER_ROOT, 'dist/src/vitest-test-runner.js'),
  search: "pool: 'threads'",
  replacement: "pool: 'forks'",
  expectedCount: 2,
};

const VITEST_5_NAME_PATCHES = [
  {
    label: 'Vitest 5 test name separator',
    target: resolve(RUNNER_ROOT, 'dist/src/test-helpers.js'),
    search: "nameParts.join(' ')",
    replacement: "nameParts.join(' > ')",
    expectedCount: 1,
  },
  {
    label: 'Vitest 5 setup test name separator',
    target: resolve(RUNNER_ROOT, 'dist/src/stryker-setup.js'),
    search: "nameParts.join(' ')",
    replacement: "nameParts.join(' > ')",
    expectedCount: 1,
  },
];

function fail(message) {
  console.error(`[stryker-patch] ERROR: ${message}`);
  process.exit(1);
}

function readText(target, label) {
  try {
    return readFileSync(target, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') {
      fail(`${label} not found at ${target}. Is @stryker-mutator/vitest-runner installed?`);
    }
    fail(`Cannot read ${label} at ${target}: ${err?.message ?? err}`);
  }
}

function readPackageVersion(target, packageName) {
  let packageJson;
  try {
    packageJson = JSON.parse(readText(target, `${packageName} package.json`));
  } catch (err) {
    fail(`Cannot parse ${packageName} package.json at ${target}: ${err?.message ?? err}`);
  }
  if (typeof packageJson.version !== 'string') {
    fail(`${packageName} package.json at ${target} has no version string.`);
  }
  return packageJson.version;
}

function majorVersion(version, packageName) {
  const match = /^(\d+)\.\d+\.\d+(?:[-+].*)?$/.exec(version);
  if (!match) {
    fail(`${packageName} version '${version}' is not a supported semantic version.`);
  }
  return Number(match[1]);
}

function countOccurrences(source, fragment) {
  return source.split(fragment).length - 1;
}

function planPatch(patch) {
  const source = readText(patch.target, patch.label);
  const searchCount = countOccurrences(source, patch.search);
  const replacementCount = countOccurrences(source, patch.replacement);

  if (searchCount === patch.expectedCount && replacementCount === 0) {
    return { ...patch, source, needsWrite: true };
  }
  if (searchCount === 0 && replacementCount === patch.expectedCount) {
    return { ...patch, source, needsWrite: false };
  }

  fail(
    `${patch.label} at ${patch.target} has an unexpected shape: expected ` +
      `${patch.expectedCount} '${patch.search}' or '${patch.replacement}' occurrences, ` +
      `found ${searchCount} and ${replacementCount}.`,
  );
}

function writePatch(patch) {
  if (!patch.needsWrite) {
    console.log(`[stryker-patch] ${patch.label} already patched.`);
    return;
  }

  try {
    writeFileSync(patch.target, patch.source.replaceAll(patch.search, patch.replacement), 'utf8');
  } catch (err) {
    fail(`Cannot write ${patch.label} at ${patch.target}: ${err?.message ?? err}`);
  }
  console.log(
    `[stryker-patch] Patched ${patch.label}: '${patch.search}' -> '${patch.replacement}'.`,
  );
}

const runnerVersion = readPackageVersion(RUNNER_PACKAGE, '@stryker-mutator/vitest-runner');
if (runnerVersion !== '10.0.0') {
  fail(
    `@stryker-mutator/vitest-runner@${runnerVersion} is unsupported. ` +
      'This pre-flight patch supports exactly version 10.0.0.',
  );
}

const vitestVersion = readPackageVersion(VITEST_PACKAGE, 'vitest');
const vitestMajor = majorVersion(vitestVersion, 'vitest');
if (vitestMajor < 2 || vitestMajor > 5) {
  fail(
    `vitest@${vitestVersion} is unsupported. ` +
      'This pre-flight patch supports Vitest majors 2 through 5.',
  );
}

const patches = vitestMajor === 5 ? [POOL_PATCH, ...VITEST_5_NAME_PATCHES] : [POOL_PATCH];
const plannedPatches = patches.map(planPatch);
plannedPatches.forEach(writePatch);

if (vitestMajor < 5) {
  console.log(`[stryker-patch] Vitest ${vitestVersion} does not require the name separator patch.`);
}
