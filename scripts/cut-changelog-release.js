#!/usr/bin/env node
/**
 * @module scripts/cut-changelog-release
 * @description Replaces [Unreleased] heading with a dated version section
 * and inserts a fresh [Unreleased] heading above it.
 *
 * Usage:
 *   node scripts/cut-changelog-release.js
 *
 * Reads VERSION file for the version number. The current date is used
 * as the release date. Must be run AFTER VERSION is bumped.
 *
 * Run as part of: npm version (preversion hook) or release workflow.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

const versionFile = join(REPO_ROOT, 'VERSION');
const changelogFile = join(REPO_ROOT, 'CHANGELOG.md');

const version = readFileSync(versionFile, 'utf-8').trim();
const today = new Date().toISOString().slice(0, 10);

let changelog = readFileSync(changelogFile, 'utf-8');

const unreleased = '## [Unreleased]\n';
const marker = `## [${version}] - ${today}`;

if (!changelog.includes(unreleased)) {
  console.log(`No [Unreleased] section found. Already cut?`);
  process.exit(0);
}

if (changelog.includes(marker)) {
  console.log(`Section ${marker} already exists. Skipping.`);
  process.exit(0);
}

// Replace first occurrence of [Unreleased] with version section
changelog = changelog.replace(unreleased, `${marker}\n`);

// Insert fresh [Unreleased] heading above the new version section
changelog = changelog.replace(marker, `## [Unreleased]\n\n\n${marker}`);

writeFileSync(changelogFile, changelog, 'utf-8');
console.log(`CHANGELOG: cut ${marker}, inserted fresh [Unreleased].`);
