#!/usr/bin/env node
/**
 * @module scripts/assert-main-release-tag
 * @description Fails closed unless the current checkout is safe to tag for release.
 *
 * This is the PRE-TAG evidence phase: the tag must not exist yet. The CI
 * POST-TAG phase lives in `scripts/verify-release-tag.js`; both share the pure
 * decisions in `scripts/release-preflight.js`.
 *
 * Usage:
 *   npm run release:assert-main-tag -- v1.2.0-rc.4
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  evaluateReleasePreTag,
  releaseVersionOf,
  validateReleaseTagName,
} from './release-preflight.js';

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

const tagError = validateReleaseTagName(tag);
if (tagError) {
  fail(tagError);
}

const version = releaseVersionOf(tag);

git(['fetch', 'origin', 'main', '--tags']);

const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
const versionFile = readFileSync(join(REPO_ROOT, 'VERSION'), 'utf-8').trim();
const changelog = readFileSync(join(REPO_ROOT, 'CHANGELOG.md'), 'utf-8');

let existingRemote = '';
try {
  existingRemote = git(['ls-remote', '--tags', 'origin', tag], { allowFailure: true });
} catch {
  existingRemote = '';
}

const failures = evaluateReleasePreTag({
  tag,
  branch: git(['branch', '--show-current']),
  clean: git(['status', '--porcelain']) === '',
  head: git(['rev-parse', 'HEAD']),
  originMain: git(['rev-parse', 'origin/main']),
  localTagExists: git(['tag', '--list', tag]) !== '',
  remoteTagExists: existingRemote !== '',
  packageVersion: packageJson.version,
  versionFile,
  changelogHasReleaseSection: changelog.includes(`## [${version}] - `),
});

if (failures.length > 0) {
  fail(failures.join('; '));
}

console.log(`Safe to tag ${tag} at ${git(['rev-parse', 'HEAD'])}.`);
