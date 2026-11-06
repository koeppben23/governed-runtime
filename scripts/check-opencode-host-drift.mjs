#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const hostVersionPath = path.join(root, '.sdk-baselines', 'opencode', 'host-version.json');
const shouldTrigger = process.argv.includes('--trigger');
if (shouldTrigger) {
  console.error(
    'BLOCKED: native API updates cannot certify installed host versions. Complete the pinned V2 Desktop/CLI acceptance gates in docs/host-probes/opencode-v2/; no host update workflow is available.',
  );
  process.exit(1);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: 'utf-8',
    stdio: 'pipe',
    env: { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: '1' },
    ...options,
  });
}

function parseVersion(raw) {
  const match = raw.trim().match(/v?(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?/);
  if (!match) return null;
  return match[0].replace(/^v/, '');
}

function compareSemver(a, b) {
  const ap = a.split('.').map((part) => Number(part));
  const bp = b.split('.').map((part) => Number(part));
  for (let i = 0; i < 3; i++) {
    if (ap[i] > bp[i]) return 1;
    if (ap[i] < bp[i]) return -1;
  }
  return 0;
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(hostVersionPath)) {
  fail(`OpenCode host baseline missing: ${path.relative(root, hostVersionPath)}`);
}

const baselineVersion = readJson(hostVersionPath).version;
if (typeof baselineVersion !== 'string' || !parseVersion(baselineVersion)) {
  fail(`OpenCode host baseline version is invalid: ${baselineVersion}`);
}

const opencode = run('opencode', ['--version']);
if (opencode.status !== 0) {
  const detail = [opencode.stdout, opencode.stderr].filter(Boolean).join('\n').trim();
  fail(`opencode --version failed. Install or update OpenCode first. ${detail}`.trim());
}

const localVersion = parseVersion(opencode.stdout);
if (!localVersion) {
  fail(`Unable to parse opencode version from output: ${opencode.stdout.trim()}`);
}

const comparison = compareSemver(localVersion, baselineVersion);
if (comparison === 0) {
  console.log(`OpenCode host baseline matches local version: ${localVersion}`);
  process.exit(0);
}

if (comparison < 0) {
  fail(
    `OpenCode local host version ${localVersion} is older than validated baseline ${baselineVersion}.`,
  );
}

console.error(`OpenCode host drift detected: local ${localVersion}, baseline ${baselineVersion}.`);
console.error(
  'Recovery: complete installed V2 acceptance; update:opencode-sdk updates API declarations only and cannot accept host drift.',
);
process.exit(1);
