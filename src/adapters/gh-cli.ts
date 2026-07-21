/**
 * @module gh-cli
 * @description Adapter for GitHub CLI (`gh`) interactions.
 *
 * This module lives in `adapters/` which is allowed to import Node builtins.
 * `rails/` imports from here instead of using `node:child_process` directly.
 */

import { execFileSync } from 'node:child_process';
import { getAdapterLogger } from '../logging/adapter-logger.js';
import { GitError } from './git.js';

/**
 * Check if `gh` CLI is available and authenticated.
 * Result is cached once per process — the check is synchronous with a 3s timeout.
 */
let _ghCliAvailable: boolean | null = null;

export function hasGhCli(): boolean {
  if (_ghCliAvailable !== null) return _ghCliAvailable;
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'ignore', timeout: 3000 });
    _ghCliAvailable = true;
  } catch {
    _ghCliAvailable = false;
    getAdapterLogger().warn('gh-cli', 'GitHub CLI not available or not authenticated');
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
    throw new GitError('GIT_NOT_FOUND', `PR #${prNumber} not found or has no diff`);
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
    throw new GitError(
      'GIT_COMMAND_FAILED',
      `Branch '${branch}' has no changes relative to ${base}`,
    );
  }
  return out;
}

// ─── Immutable Branch Review Source ──────────────────────────────────────────

export interface ResolvedBranchReviewSource {
  readonly branch: string;
  readonly baseBranch: string;
  readonly resolvedBranchSha: string;
  readonly resolvedBaseSha: string;
}

/**
 * Resolve both the branch head and detected base branch to full commit SHAs.
 * Fails closed: throws GitError if either ref cannot be resolved.
 */
export function resolveBranchReviewSource(branch: string): ResolvedBranchReviewSource {
  const baseBranch = detectBaseBranch();
  const headSha = execFileSync(
    'git',
    ['rev-parse', '--verify', '--end-of-options', `${branch}^{commit}`],
    { encoding: 'utf-8', stdio: 'pipe', timeout: 5000 },
  ).trim();
  const baseSha = execFileSync(
    'git',
    ['rev-parse', '--verify', '--end-of-options', `${baseBranch}^{commit}`],
    { encoding: 'utf-8', stdio: 'pipe', timeout: 5000 },
  ).trim();
  return { branch, baseBranch, resolvedBranchSha: headSha, resolvedBaseSha: baseSha };
}

/**
 * Load the diff between two resolved commit SHAs.
 * Uses immutable refs — no branch name interpolation.
 */
export function loadResolvedBranchDiff(headSha: string, baseSha: string): string {
  const out = execFileSync('git', ['diff', `${baseSha}...${headSha}`], {
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: 15000,
  });
  if (!out || out.trim() === '') {
    throw new GitError('GIT_COMMAND_FAILED', 'Empty diff between resolved commits');
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
    getAdapterLogger().warn('gh-cli', 'Cannot detect origin/HEAD, trying main branch fallback');
  }
  try {
    execFileSync('git', ['rev-parse', '--verify', 'main'], { stdio: 'ignore', timeout: 3000 });
    return 'main';
  } catch {
    getAdapterLogger().warn('gh-cli', 'main branch not found, trying master branch fallback');
  }
  try {
    execFileSync('git', ['rev-parse', '--verify', 'master'], { stdio: 'ignore', timeout: 3000 });
    return 'master';
  } catch {
    getAdapterLogger().error('gh-cli', 'Cannot determine base branch for diff');
    throw new GitError('GIT_COMMAND_FAILED', 'Cannot determine base branch for diff');
  }
}
