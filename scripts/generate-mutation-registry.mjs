#!/usr/bin/env node

/**
 * generate-mutation-registry.mjs
 *
 * Development-tool generator for the `admittedSelectors` projection in
 * `scripts/mutation-profile-registry.json`.
 *
 * Authority: the immutable admission records in
 * `src/architecture/__tests__/mutation-admission-records.ts`. The generator
 * derives every selector list from those records; the profile mapping comes
 * from the registry's own stable `configFile` fields, never from the generated
 * projection itself.
 *
 * Independence: this tool only proves records -> registry reproducibility. The
 * architecture guard A11 (`mutation-scope.test.ts`) stays untouched and
 * independently closes the active inventory <-> immutable records <-> registry
 * triangle. A generated registry is therefore never its own evidence.
 *
 * Usage:
 *   node scripts/generate-mutation-registry.mjs --check
 *   node scripts/generate-mutation-registry.mjs --write
 *
 * Options:
 *   --check             Fail when the committed projection differs (default CI mode).
 *   --write             Regenerate the projection in place.
 *   --registry <path>   Override the registry path (tests/diagnostics only).
 *
 * Toolchain: the TypeScript records module is imported through Node's type
 * stripping, so this is a development tool for the pinned toolchain
 * (`.node-version`, `devEngines` >= 22.22.2). The published `engines` range is
 * the consumer contract and is deliberately not widened by this script.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const DEFAULT_REGISTRY_PATH = resolve(REPO_ROOT, 'scripts/mutation-profile-registry.json');
const RECORDS_MODULE_PATH = resolve(
  REPO_ROOT,
  'src/architecture/__tests__/mutation-admission-records.ts',
);

const TOOLCHAIN_RECOVERY =
  'Use the pinned development toolchain (Node >= 22.22.2, see .node-version); ' +
  'the published engines range is the consumer contract, not the dev contract.';

function fail(message, recovery) {
  console.error(`[generate-mutation-registry] ERROR: ${message}`);
  if (recovery !== undefined) console.error(`[generate-mutation-registry] ${recovery}`);
  process.exit(1);
}

/**
 * Derive the per-profile admitted selector lists from admission records.
 *
 * @param {{ profiles: Record<string, { configFile: string }> }} registry
 * @param {Record<string, { config: string }>} recordsBySelector
 * @returns {Record<string, string[]>}
 */
export function computeAdmittedSelectors(registry, recordsBySelector) {
  const profiles = registry.profiles ?? {};
  const profileByConfig = new Map();
  for (const [profile, entry] of Object.entries(profiles)) {
    if (typeof entry?.configFile !== 'string' || entry.configFile.length === 0) {
      throw new Error(`profile '${profile}' declares no configFile`);
    }
    if (profileByConfig.has(entry.configFile)) {
      throw new Error(
        `profiles '${profileByConfig.get(entry.configFile)}' and '${profile}' share configFile '${entry.configFile}'`,
      );
    }
    profileByConfig.set(entry.configFile, profile);
  }

  const byProfile = new Map(Object.keys(profiles).map((profile) => [profile, []]));
  for (const selector of Object.keys(recordsBySelector).sort()) {
    const config = recordsBySelector[selector]?.config;
    const profile = profileByConfig.get(config);
    if (profile === undefined) {
      throw new Error(
        `admission record '${selector}' declares config '${config}' that maps to no registry profile`,
      );
    }
    byProfile.get(profile).push(selector);
  }

  const expected = {};
  for (const [profile, selectors] of byProfile) {
    expected[profile] = selectors.sort();
  }
  return expected;
}

/**
 * Compare a registry against the generated projection.
 *
 * @returns {string[]} human-readable drift problems (empty when closed).
 */
export function findRegistryDrift(registry, expected) {
  const profiles = registry.profiles ?? {};
  const problems = [];

  for (const [profile, selectors] of Object.entries(expected)) {
    const declared = profiles[profile]?.admittedSelectors;
    if (!Array.isArray(declared)) {
      problems.push(`${profile}: registry declares no admittedSelectors array`);
      continue;
    }
    if (new Set(declared).size !== declared.length) {
      problems.push(`${profile}: admittedSelectors contains duplicates`);
    }
    if ([...declared].sort().join('\n') !== selectors.join('\n')) {
      const declaredSet = new Set(declared);
      const expectedSet = new Set(selectors);
      for (const selector of selectors) {
        if (!declaredSet.has(selector)) problems.push(`${profile}: missing selector ${selector}`);
      }
      for (const selector of declared) {
        if (!expectedSet.has(selector)) problems.push(`${profile}: stale selector ${selector}`);
      }
    }
  }
  for (const profile of Object.keys(profiles)) {
    if (!(profile in expected)) {
      problems.push(`${profile}: registry profile without admission records`);
    }
  }
  return problems;
}

/** Apply the generated projection to a registry copy. */
export function applyAdmittedSelectors(registry, expected) {
  const next = structuredClone(registry);
  for (const [profile, selectors] of Object.entries(expected)) {
    next.profiles[profile].admittedSelectors = selectors;
  }
  return next;
}

function parseArguments(argv) {
  const options = { mode: null, registryPath: DEFAULT_REGISTRY_PATH };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--check') options.mode = 'check';
    else if (argument === '--write') options.mode = 'write';
    else if (argument === '--registry') {
      const value = argv[++index];
      if (value === undefined) fail('--registry requires a path argument');
      options.registryPath = resolve(value);
    } else {
      fail(`unsupported argument '${argument}'`, 'Supported: --check, --write, --registry <path>.');
    }
  }
  if (options.mode === null) {
    fail('exactly one mode is required', 'Use --check or --write.');
  }
  return options;
}

function readRegistry(registryPath) {
  try {
    return JSON.parse(readFileSync(registryPath, 'utf8'));
  } catch (error) {
    fail(
      `cannot read registry at ${registryPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function loadRecords() {
  let module;
  try {
    module = await import(pathToFileURL(RECORDS_MODULE_PATH).href);
  } catch (error) {
    if (error?.code === 'ERR_UNKNOWN_FILE_EXTENSION') {
      fail(
        `the runtime cannot import ${RECORDS_MODULE_PATH} (type stripping unavailable)`,
        TOOLCHAIN_RECOVERY,
      );
    }
    throw error;
  }
  const recordsBySelector = {};
  for (const selector of module.admissionRecordSelectors()) {
    recordsBySelector[selector] = module.admissionRecord(selector);
  }
  return recordsBySelector;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const registry = readRegistry(options.registryPath);
  const recordsBySelector = await loadRecords();
  const expected = computeAdmittedSelectors(registry, recordsBySelector);

  if (options.mode === 'check') {
    const problems = findRegistryDrift(registry, expected);
    if (problems.length > 0) {
      fail(`registry projection drift detected in ${options.registryPath}:`, problems.join('\n  '));
    }
    const selectorCount = Object.values(expected).reduce(
      (sum, selectors) => sum + selectors.length,
      0,
    );
    console.log(
      `[generate-mutation-registry] registry projection OK (${Object.keys(expected).length} profile(s), ${selectorCount} admitted selector(s))`,
    );
    return;
  }

  writeFileSync(
    options.registryPath,
    `${JSON.stringify(applyAdmittedSelectors(registry, expected), null, 2)}\n`,
    'utf8',
  );
  console.log(`[generate-mutation-registry] wrote ${options.registryPath}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
