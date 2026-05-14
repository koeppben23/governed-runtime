#!/usr/bin/env node
/**
 * @module scripts/assert-main-release-tag
 * @description Fails closed unless the current checkout is safe to tag for release.
 *
 * Usage:
 *   npm run release:assert-main-tag -- v1.2.0-rc.4
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

const tag = process.argv[2]?.trim();

function fail(message) {
  console.error(`release:assert-main-tag failed: ${message}`);
  process.exit(1);
}

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', options.allowFailure ? 'ignore' : 'pipe'],
  }).trim();
}

if (!tag || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(tag)) {
  fail('tag argument must look like v1.2.0 or v1.2.0-rc.4');
}

const version = tag.slice(1);
const branch = git(['branch', '--show-current']);
if (branch !== 'main') {
  fail(`release tags must be created from main, current branch is ${branch || '(detached)'}`);
}

const status = git(['status', '--porcelain']);
if (status) {
  fail('working tree must be clean before tagging');
}

git(['fetch', 'origin', 'main', '--tags']);

const head = git(['rev-parse', 'HEAD']);
const originMain = git(['rev-parse', 'origin/main']);
if (head !== originMain) {
  fail('HEAD must equal origin/main before tagging');
}

const existingLocal = git(['tag', '--list', tag]);
if (existingLocal) {
  fail(`local tag already exists: ${tag}`);
}

let existingRemote = '';
try {
  existingRemote = git(['ls-remote', '--tags', 'origin', tag], { allowFailure: true });
} catch {
  existingRemote = '';
}

if (existingRemote) {
  fail(`remote tag already exists: ${tag}`);
}

const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
const versionFile = readFileSync(join(REPO_ROOT, 'VERSION'), 'utf-8').trim();

if (packageJson.version !== version || versionFile !== version) {
  fail(`package.json and VERSION must both equal ${version}`);
}

const changelog = readFileSync(join(REPO_ROOT, 'CHANGELOG.md'), 'utf-8');
if (!changelog.includes(`## [${version}] - `)) {
  fail(`CHANGELOG.md must contain a dated [${version}] release section`);
}

console.log(`Safe to tag ${tag} at ${head}.`);
