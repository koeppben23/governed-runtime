#!/usr/bin/env node
/**
 * @module scripts/generate-build-info
 * @description Emits dist/build-info.json with the build's git identity.
 *
 * Usage:
 *   node scripts/generate-build-info.js
 *
 * Runs AFTER `tsc` in the build pipeline (clean-dist wipes dist/ and tsc
 * repopulates it). The emitted file ships because package.json `files` includes
 * `dist`. A runtime reader (src/shared/build-info.ts) and `flowguard doctor`
 * compare this stamp to detect a stale installed plugin (dist older than the
 * source it was built from).
 *
 * Fail-soft on git: if the SHA cannot be resolved (e.g. building from a tarball
 * with no .git), `gitSha` is "unknown" and `gitShaSource` records why. The
 * version is the release source of truth (VERSION file).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const DIST_DIR = join(REPO_ROOT, 'dist');
const OUT_FILE = join(DIST_DIR, 'build-info.json');

function resolveGitSha() {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return { gitSha: sha, gitShaSource: 'git' };
  } catch {
    return { gitSha: 'unknown', gitShaSource: 'unavailable' };
  }
}

const version = readFileSync(join(REPO_ROOT, 'VERSION'), 'utf-8').trim();
const { gitSha, gitShaSource } = resolveGitSha();

const buildInfo = {
  version,
  gitSha,
  gitShaSource,
  builtAt: new Date().toISOString(),
};

if (!existsSync(DIST_DIR)) {
  // dist must exist (tsc runs before this script); create defensively so the
  // script never fails the build if invoked standalone.
  mkdirSync(DIST_DIR, { recursive: true });
}
writeFileSync(OUT_FILE, JSON.stringify(buildInfo, null, 2) + '\n', 'utf-8');
console.log(`Wrote build-info: version=${version} gitSha=${gitSha} (${gitShaSource})`);
