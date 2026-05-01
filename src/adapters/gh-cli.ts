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
 * Returns true if `gh` exists and `gh auth status` succeeds.
 */
export function hasGhCli(): boolean {
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
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
  const out = execFileSync('gh', ['pr', 'diff', branch], {
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: 15000,
  });
  if (!out || out.trim() === '') {
    throw new Error(`Branch '${branch}' has no diff or does not exist`);
  }
  return out;
}
