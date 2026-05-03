/**
 * @module gh-cli
 * @description Adapter for GitHub CLI (`gh`) interactions.
 *
 * This module lives in `adapters/` which is allowed to import Node builtins.
 * `rails/` imports from here instead of using `node:child_process` directly.
 */

import { execFileSync } from 'node:child_process';

/**
 * Check if `gh` CLI is available and authenticated.
 * Result is cached once per process — the check is synchronous with a 5s timeout.
 */
let _ghCliAvailable: boolean | null = null;

export function hasGhCli(): boolean {
  if (_ghCliAvailable !== null) return _ghCliAvailable;
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'ignore', timeout: 3000 });
    _ghCliAvailable = true;
  } catch {
    _ghCliAvailable = false;
  }
  return _ghCliAvailable;
}

/**
 * Load PR diff via `gh` CLI.
 * Requires `gh` CLI installed and authenticated.
 * Returns the raw diff string.
 * Throws if PR not found or gh fails.
 */
export function loadPrDiff(prNumber: number): string {
  const out = execFileSync(
    'gh',
    ['pr', 'view', String(prNumber), '--json', 'diff', '--jq', '.diff'],
    {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 15000,
    },
  );
  if (!out || out.trim() === 'null') {
    throw new Error(`PR #${prNumber} not found or has no diff`);
  }
  return out;
}

/**
 * Load branch diff via `gh` CLI (compares branch against base branch).
 * Requires `gh` CLI installed and authenticated.
 * Returns the raw diff string.
 * Throws if branch not found or gh fails.
 */
export function loadBranchDiff(branch: string): string {
  const base = detectBaseBranch();
  const out = execFileSync('git', ['diff', `${base}...${branch}`], {
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: 15000,
  });
  if (!out || out.trim() === '') {
    throw new Error(`Branch '${branch}' has no changes relative to ${base}`);
  }
  return out;
}

function detectBaseBranch(): string {
  try {
    return execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 3000,
    })
      .trim()
      .replace('refs/remotes/', '');
  } catch {
    /* fallback */
  }
  try {
    execFileSync('git', ['rev-parse', '--verify', 'main'], { stdio: 'ignore', timeout: 3000 });
    return 'main';
  } catch {
    /* fallback */
  }
  try {
    execFileSync('git', ['rev-parse', '--verify', 'master'], { stdio: 'ignore', timeout: 3000 });
    return 'master';
  } catch {
    throw new Error('Cannot determine base branch for diff');
  }
}
