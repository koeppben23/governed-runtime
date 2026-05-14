#!/usr/bin/env node
/**
 * @module scripts/prepare-release
 * @description Prepares release files without committing, tagging, or pushing.
 *
 * Usage:
 *   npm run release:prepare -- 1.2.0-rc.4
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

const version = process.argv[2]?.trim();
const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function fail(message) {
  console.error(`release:prepare failed: ${message}`);
  process.exit(1);
}

function run(script) {
  execFileSync(process.execPath, [join(REPO_ROOT, 'scripts', script)], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
}

if (!version) {
  fail('missing version argument, for example: npm run release:prepare -- 1.2.0-rc.4');
}

if (!semverPattern.test(version)) {
  fail(`version must be a semantic version, got: ${version}`);
}

writeFileSync(join(REPO_ROOT, 'VERSION'), `${version}\n`, 'utf-8');
run('sync-version.js');

const lockFile = join(REPO_ROOT, 'package-lock.json');
const lock = JSON.parse(readFileSync(lockFile, 'utf-8'));

if (lock.name !== '@flowguard/core' || lock.packages?.['']?.name !== '@flowguard/core') {
  fail('package-lock.json root package is not @flowguard/core');
}

lock.version = version;
lock.packages[''].version = version;
writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`, 'utf-8');

run('cut-changelog-release.js');
run('generate-docs.js');

console.log(`Prepared release ${version}. Commit these changes through a PR before tagging.`);
