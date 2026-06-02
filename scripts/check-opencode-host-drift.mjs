#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const hostVersionPath = path.join(root, '.sdk-baselines', 'opencode', 'host-version.json');
const shouldTrigger = process.argv.includes('--trigger');

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
  console.log(
    `OpenCode local host version ${localVersion} is older than baseline ${baselineVersion}; no update PR needed.`,
  );
  process.exit(0);
}

const recoveryCommand = `gh workflow run opencode-sdk-update.yml --ref main -f version=latest -f opencode_version=${localVersion}`;
console.error(`OpenCode host drift detected: local ${localVersion}, baseline ${baselineVersion}.`);
console.error(`Recovery: ${recoveryCommand}`);

if (!shouldTrigger) {
  process.exit(1);
}

const gh = run('gh', [
  'workflow',
  'run',
  'opencode-sdk-update.yml',
  '--ref',
  'main',
  '-f',
  'version=latest',
  '-f',
  `opencode_version=${localVersion}`,
]);

if (gh.status !== 0) {
  const detail = [gh.stdout, gh.stderr].filter(Boolean).join('\n').trim();
  fail(`failed to trigger OpenCode SDK Update workflow. ${detail}`.trim());
}

console.log(`Triggered OpenCode SDK Update workflow for opencode-ai@${localVersion}.`);
