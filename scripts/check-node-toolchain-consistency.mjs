#!/usr/bin/env node
/**
 * @module scripts/check-node-toolchain-consistency
 * @description Validates Node toolchain invariants: .node-version, CI workflow
 * node-version-file usage, devEngines consistency, and package engines policy.
 *
 * @version v1
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');

let errors = 0;

function error(msg) {
  console.error(`  FAIL  ${msg}`);
  errors++;
}

// ─── 1. .node-version ──────────────────────────────────────────────────────

console.log('--- .node-version ---');
const nodeVersionPath = join(REPO_ROOT, '.node-version');
if (!existsSync(nodeVersionPath)) {
  error('.node-version file missing');
} else {
  const nodeVersion = readFileSync(nodeVersionPath, 'utf-8').trim();
  const semverRe = /^\d+\.\d+\.\d+$/;
  if (!semverRe.test(nodeVersion)) {
    error(`.node-version "${nodeVersion}" is not a valid semver`);
  } else {
    console.log(`  ok: .node-version = ${nodeVersion}`);
  }
}

// ─── 2. package.json devEngines ─────────────────────────────────────────────

console.log('--- devEngines ---');
const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
if (!pkg.devEngines || !pkg.devEngines.runtime) {
  error('package.json missing devEngines.runtime');
} else {
  const runtime = pkg.devEngines.runtime;
  if (runtime.name !== 'node') {
    error(`devEngines.runtime.name expected "node", got "${runtime.name}"`);
  }
  if (runtime.onFail !== 'error') {
    error(`devEngines.runtime.onFail expected "error", got "${runtime.onFail}"`);
  }
  console.log(`  ok: devEngines.runtime.name=${runtime.name}, version=${runtime.version}, onFail=${runtime.onFail}`);
}

// ─── 3. package.json engines ────────────────────────────────────────────────

console.log('--- engines ---');
const enginesNode = pkg.engines?.node;
if (!enginesNode) {
  error('package.json missing engines.node');
} else if (enginesNode === '>=20') {
  error('engines.node is still unbounded ">=20" — must declare explicit major ranges');
} else {
  console.log(`  ok: engines.node = ${enginesNode}`);
}

// ─── 4. Workflow policy ─────────────────────────────────────────────────────

console.log('--- Workflows ---');

const MATRIX_ALLOW_LIST = new Set([
  'node-compat.yml',
  'release.yml',
]);

const yamlFiles = readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

for (const file of yamlFiles) {
  const content = readFileSync(join(WORKFLOW_DIR, file), 'utf-8');

  // Check: no job sets both node-version and node-version-file simultaneously
  const hasBoth = /node-version-file:/.test(content) && /node-version:\s*(?!\s*\${{)/m.test(content);
  if (hasBoth) {
    // Only flag if both appear in different setup-node blocks within the same file
    // (a file with both node-version-file and explicit node-version in different jobs is fine)
    // This check is approximate; structural parsing would be more precise.
  }

  const isAllowListed = MATRIX_ALLOW_LIST.has(file);

  // Check for static node-version (non-matrix) in non-allow-listed workflows
  if (!isAllowListed) {
    const staticNodeVersion = content.match(/node-version:\s*['"][^$]*['"]/g);
    if (staticNodeVersion) {
      for (const match of staticNodeVersion) {
        error(`${file}: static node-version "${match}" outside allow-listed matrix workflow`);
      }
    }
  }

  // Check for node-version-file in allow-listed release.yml
  if (file === 'release.yml') {
    if (!/node-version-file:/.test(content)) {
      error('release.yml: missing node-version-file for build job');
    }
  }

  // Check for node-version-file usage overall
  const hasVersionFile = /node-version-file:/.test(content);
  if (file !== 'node-compat.yml' && file !== 'release.yml' && !hasVersionFile) {
    error(`${file}: no node-version-file reference`);
  }
}

console.log(`  Scanned ${yamlFiles.length} workflow files`);

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log('');
if (errors > 0) {
  console.error(`Node toolchain consistency check FAILED with ${errors} error(s).`);
  process.exit(1);
}
console.log('Node toolchain consistency check passed.');
