/**
 * Legacy mutation ratchet.
 *
 * `scripts/mutation-legacy-baseline.json` freezes the legacy mutation
 * exceptions (targets without an admission record). The architecture test A12
 * keeps the active legacy set exactly equal to that baseline, so the baseline
 * can shrink when a target is admitted, but it can never grow silently.
 *
 * A12 alone cannot prevent a change that grows the baseline and the active
 * legacy set at the same time. This checker closes that gap by comparing the
 * committed baseline against the baseline at the PR base revision: the new
 * baseline must be a subset of the old one. A baseline introduced by the base
 * revision itself (first landing) has nothing to compare against and is
 * accepted; A12 still pins it to the active legacy set.
 *
 * Usage:
 *   node scripts/check-legacy-ratchet.mjs --base origin/develop
 *   node scripts/check-legacy-ratchet.mjs --head-file head.json --base-file base.json
 *
 * `--base-file`/`--head-file` exist for tests. Without `--base`, the checker
 * uses the merge base with `origin/develop`.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const BASELINE_PATH = 'scripts/mutation-legacy-baseline.json';

function fail(message) {
  console.error(`[check-legacy-ratchet] ERROR: ${message}`);
  process.exit(1);
}

function parseArguments(argv) {
  const options = { base: undefined, baseFile: undefined, headFile: undefined };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--base') options.base = argv[++index];
    else if (argument === '--base-file') options.baseFile = argv[++index];
    else if (argument === '--head-file') options.headFile = argv[++index];
    else fail(`unsupported argument '${argument}'`);
  }
  for (const [name, value] of Object.entries(options)) {
    if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
      fail(`--${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} requires a value`);
    }
  }
  return options;
}

function parseBaseline(bytes, label) {
  let parsed;
  try {
    parsed = JSON.parse(bytes);
  } catch (error) {
    fail(`cannot parse ${label}: ${error?.message ?? error}`);
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    parsed.version !== 1 ||
    !Array.isArray(parsed.legacySelectors)
  ) {
    fail(`${label} must have shape { version: 1, legacySelectors: [...] }`);
  }
  const keys = [];
  for (const entry of parsed.legacySelectors) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof entry.profile !== 'string' ||
      entry.profile.length === 0 ||
      typeof entry.mutateSelector !== 'string' ||
      entry.mutateSelector.length === 0
    ) {
      fail(`${label} contains an entry without profile/mutateSelector`);
    }
    keys.push(`${entry.profile}\n${entry.mutateSelector}`);
  }
  const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index);
  if (duplicates.length > 0) {
    fail(
      `${label} contains duplicate entries: ${duplicates
        .map((key) => key.replace('\n', ': '))
        .join(', ')}`,
    );
  }
  return { keys: new Set(keys), count: keys.length };
}

function readHeadBaseline(options) {
  const path = options.headFile ?? resolve(REPO_ROOT, BASELINE_PATH);
  if (!existsSync(path)) fail(`head baseline not found at ${path}`);
  return { label: `head baseline ${path}`, ...parseBaseline(readFileSync(path, 'utf-8'), path) };
}

function resolveBaseRef(options) {
  if (options.base !== undefined) return options.base;
  const result = spawnSync('git', ['merge-base', 'HEAD', 'origin/develop'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0 || result.stdout.trim().length === 0) {
    fail(
      'no --base given and no merge base with origin/develop is available; ' +
        'pass --base <ref> explicitly',
    );
  }
  return result.stdout.trim();
}

function readBaseBaseline(options) {
  if (options.baseFile !== undefined) {
    if (!existsSync(options.baseFile)) return null;
    return {
      label: `base baseline ${options.baseFile}`,
      ...parseBaseline(readFileSync(options.baseFile, 'utf-8'), options.baseFile),
    };
  }
  const base = resolveBaseRef(options);
  const verify = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${base}^{commit}`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (verify.status !== 0) fail(`base revision '${base}' does not resolve to a commit`);
  const present = spawnSync('git', ['cat-file', '-e', `${base}:${BASELINE_PATH}`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (present.status !== 0) {
    console.log(
      `[check-legacy-ratchet] baseline introduced in this change (no ${BASELINE_PATH} at ${base}); ` +
        'A12 pins it to the active legacy set',
    );
    return null;
  }
  const shown = spawnSync('git', ['show', `${base}:${BASELINE_PATH}`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (shown.status !== 0) fail(`cannot read ${BASELINE_PATH} at ${base}: ${shown.stderr.trim()}`);
  return {
    label: `base baseline at ${base}`,
    ...parseBaseline(shown.stdout, `${base}:${BASELINE_PATH}`),
  };
}

const options = parseArguments(process.argv.slice(2));
const head = readHeadBaseline(options);
const base = readBaseBaseline(options);

if (base !== null) {
  const additions = [...head.keys].filter((key) => !base.keys.has(key));
  if (additions.length > 0) {
    fail(
      `legacy baseline grew by ${additions.length} entr${additions.length === 1 ? 'y' : 'ies'}: ` +
        `${additions.map((key) => key.replace('\n', ': ')).join(', ')}. ` +
        'Admit the targets or make the baseline change a deliberate, reviewed decision.',
    );
  }
  console.log(
    `[check-legacy-ratchet] head=${head.count} base=${base.count} removed=${base.count - head.count} OK`,
  );
} else {
  console.log(`[check-legacy-ratchet] head=${head.count} introduction OK`);
}
