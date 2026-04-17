#!/usr/bin/env node
/**
 * @module scripts/sync-version
 * @description Reads VERSION file and syncs version to package.json.
 *
 * Usage:
 *   node scripts/sync-version.js
 *
 * This script ensures package.json.version is always in sync with VERSION.
 * Run as part of: npm version (preversion hook) or manually.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

const versionFile = join(REPO_ROOT, 'VERSION');
const packageFile = join(REPO_ROOT, 'package.json');

const version = readFileSync(versionFile, 'utf-8').trim();
const pkg = JSON.parse(readFileSync(packageFile, 'utf-8'));

if (pkg.version === version) {
  console.log(`package.json version already up to date: ${version}`);
  process.exit(0);
}

pkg.version = version;
writeFileSync(packageFile, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
console.log(`Synced package.json version to ${version}`);
