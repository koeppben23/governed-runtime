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
export function loadBranchDiff(branch: string, cwd?: string): string {
  const base = detectBaseBranch(branch, cwd);
  const out = execFileSync('git', ['diff', `${base.ref}...${branch}`], {
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: 15000,
    cwd,
  });
  if (!out || out.trim() === '') {
    throw new GitError(
      'GIT_COMMAND_FAILED',
      `Branch '${branch}' has no changes relative to ${base.label}`,
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
 * Resolve both the branch head and base to full commit SHAs.
 *
 * When `explicitBase` is provided (e.g. `/review branch=X base=Y`), it is used
 * verbatim as the base ref — this is the deterministic, user-controlled path.
 * Otherwise the base is auto-detected via detectBaseBranch() (best-effort).
 *
 * All git operations are scoped to `cwd` (the project worktree) so that
 * ref resolution does not silently operate against the wrong repository.
 *
 * Fails closed: throws GitError if either ref cannot be resolved. The returned
 * `baseBranch` is an honest label of the base actually used (a ref name, an
 * explicit user value, or "(merge-base with HEAD)") — never a mislabeled
 * mainline when a fallback was taken.
 */
export function resolveBranchReviewSource(
  branch: string,
  explicitBase?: string,
  cwd?: string,
): ResolvedBranchReviewSource {
  const base =
    explicitBase !== undefined && explicitBase.trim() !== ''
      ? { label: explicitBase.trim(), ref: explicitBase.trim() }
      : detectBaseBranch(branch, cwd);

  // Fail closed with a typed, ref-naming error (contract: "throws GitError if
  // either ref cannot be resolved"). An explicit base is user-controlled and is
  // otherwise taken verbatim, so it is the most likely non-resolvable ref.
  if (!refExists(base.ref, cwd)) {
    throw new GitError(
      'GIT_NOT_FOUND',
      `Base '${base.label}' does not resolve to a commit. ` +
        'Provide an existing base with base=<ref>, or create/fetch it first.',
    );
  }
  if (!refExists(branch, cwd)) {
    throw new GitError(
      'GIT_NOT_FOUND',
      `Branch '${branch}' does not resolve to a commit. ` +
        'Check the branch name, or fetch it first.',
    );
  }

  // Defensive: refs were verified above, but resolve inside try/catch so any
  // race (ref deleted between check and use) still surfaces as a typed GitError
  // rather than a raw execFileSync exception.
  let headSha: string;
  let baseSha: string;
  try {
    headSha = execFileSync(
      'git',
      ['rev-parse', '--verify', '--end-of-options', `${branch}^{commit}`],
      { encoding: 'utf-8', stdio: 'pipe', timeout: 5000, cwd },
    ).trim();
    baseSha = execFileSync(
      'git',
      ['rev-parse', '--verify', '--end-of-options', `${base.ref}^{commit}`],
      { encoding: 'utf-8', stdio: 'pipe', timeout: 5000, cwd },
    ).trim();
  } catch (err) {
    throw new GitError(
      'GIT_COMMAND_FAILED',
      `Could not resolve branch '${branch}' or base '${base.label}' to a commit: ${String(err)}. ` +
        'Provide an explicit base with base=<ref>, or fetch the refs first.',
    );
  }

  if (baseSha === headSha) {
    throw new GitError(
      'GIT_COMMAND_FAILED',
      `Branch '${branch}' has no commits ahead of base '${base.label}' (identical commits); ` +
        'nothing to review. Provide an explicit base with base=<ref> or push the branch to a remote.',
    );
  }
  return { branch, baseBranch: base.label, resolvedBranchSha: headSha, resolvedBaseSha: baseSha };
}

/**
 * Load the diff between two resolved commit SHAs.
 * Uses immutable refs — no branch name interpolation.
 */
export function loadResolvedBranchDiff(headSha: string, baseSha: string, cwd?: string): string {
  const out = execFileSync('git', ['diff', `${baseSha}...${headSha}`], {
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: 15000,
    cwd,
  });
  if (!out || out.trim() === '') {
    throw new GitError('GIT_COMMAND_FAILED', 'Empty diff between resolved commits');
  }
  return out;
}

/** A resolved base: an honest human label plus a git-resolvable ref/SHA. */
interface DetectedBase {
  readonly label: string;
  readonly ref: string;
}

/** True if `ref` resolves to a commit in the repo at `cwd`. */
function refExists(ref: string, cwd?: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], {
      stdio: 'ignore',
      timeout: 3000,
      cwd,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort auto-detection of a base ref to diff `branch` against.
 *
 * Candidate ladder (fail-closed): origin/HEAD → main → master → origin/master →
 * upstream/HEAD → merge-base(branch, HEAD). If none resolve, throws a typed
 * GitError with recovery guidance. The caller can always bypass this by passing
 * an explicit base (base=<ref>).
 */
function detectBaseBranch(branch: string, cwd?: string): DetectedBase {
  try {
    const originHead = execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 3000,
      cwd,
    })
      .trim()
      .replace('refs/remotes/', '');
    return { label: originHead, ref: originHead };
  } catch {
    getAdapterLogger().warn('gh-cli', 'Cannot detect origin/HEAD, trying named-branch fallbacks');
  }

  for (const named of ['main', 'master', 'origin/master', 'upstream/HEAD']) {
    if (refExists(named, cwd)) {
      return { label: named, ref: named };
    }
  }

  // Final fallback: the merge-base of the branch and the current HEAD. This
  // gives the branch's changes relative to where it diverged, matching the
  // conventional `git merge-base` behavior. Only used when no mainline ref
  // exists (e.g. a purely local branch with no remote).
  try {
    const mergeBase = execFileSync('git', ['merge-base', '--end-of-options', branch, 'HEAD'], {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 3000,
      cwd,
    }).trim();
    if (mergeBase) {
      getAdapterLogger().warn(
        'gh-cli',
        'No mainline base found; using merge-base with HEAD as review base',
      );
      return { label: '(merge-base with HEAD)', ref: mergeBase };
    }
  } catch {
    // fall through to the typed error below
  }

  getAdapterLogger().error('gh-cli', 'Cannot determine base branch for diff');
  throw new GitError(
    'GIT_COMMAND_FAILED',
    `Cannot determine a base to diff branch '${branch}' against ` +
      '(no origin/HEAD, main, master, origin/master, upstream/HEAD, or merge-base with HEAD). ' +
      'Provide an explicit base with base=<ref>, or create/fetch a mainline branch.',
  );
}
