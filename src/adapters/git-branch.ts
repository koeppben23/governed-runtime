/**
 * @module adapters/git-branch
 * @description Branch, HEAD, working-tree cleanliness, and remote metadata
 * probes. Every probe fails soft to null/false unless a typed strict variant
 * is explicitly documented otherwise.
 *
 * @version v1
 */

import { git, GitError, logWarn } from './git-command.js';
import { resolveRoot } from './git-repo.js';

/**
 * Get the current branch name.
 *
 * @returns Branch name, or null for detached HEAD.
 */
export async function currentBranch(worktree: string): Promise<string | null> {
  try {
    const branch = await git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']);
    // Detached HEAD returns literal "HEAD"
    return branch === 'HEAD' ? null : branch;
  } catch {
    logWarn('git', 'Failed to resolve current branch', { worktree });
    return null;
  }
}

/**
 * Check if the worktree is clean (no staged, unstaged, or untracked changes).
 * Useful for pre-implementation baseline checks.
 */
export async function isClean(worktree: string): Promise<boolean> {
  const status = await git(worktree, ['status', '--porcelain']);
  return status === '';
}

/**
 * Get the current HEAD commit hash (short form).
 * Returns null if no commits exist.
 */
export async function headCommit(worktree: string): Promise<string | null> {
  try {
    return await git(worktree, ['rev-parse', '--short', 'HEAD']);
  } catch {
    logWarn('git', 'Failed to resolve HEAD commit', { worktree });
    return null;
  }
}

/** Get the current HEAD commit hash in its full immutable form. */
export async function headCommitFull(worktree: string): Promise<string | null> {
  try {
    return await git(worktree, ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}']);
  } catch {
    logWarn('git', 'Failed to resolve full HEAD commit', { worktree });
    return null;
  }
}

/**
 * Resolve HEAD as an immutable commit without collapsing infrastructure failures.
 * A missing HEAD in an otherwise valid repository is represented by `null`; all
 * other typed Git failures propagate to the freeze authority.
 */
export async function headCommitFullStrict(worktree: string): Promise<string | null> {
  await resolveRoot(worktree);
  try {
    return await git(worktree, ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}']);
  } catch (err) {
    if (
      err instanceof GitError &&
      err.code === 'GIT_COMMAND_FAILED' &&
      isMissingHeadFailure(err.message)
    ) {
      return null;
    }
    throw err;
  }
}

function isMissingHeadFailure(message: string): boolean {
  return /needed a single revision|unknown revision|does not have any commits yet/i.test(message);
}

/**
 * Get the default branch name for the repository.
 *
 * Strategy:
 * 1. Try `git symbolic-ref refs/remotes/origin/HEAD` (set after clone)
 * 2. Fall back to null if no remote HEAD is configured
 *
 * Returns the branch name only (e.g., "main"), not the full ref.
 * Returns null if the default branch cannot be determined.
 */
export async function defaultBranch(worktree: string): Promise<string | null> {
  try {
    const ref = await git(worktree, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
    // ref is "refs/remotes/origin/main" — extract last segment
    const parts = ref.split('/');
    return parts[parts.length - 1] || null;
  } catch {
    logWarn('git', 'Failed to resolve default branch', { worktree });
    return null;
  }
}

/**
 * Get the remote "origin" URL for the repository.
 *
 * Returns null if:
 * - No remote named "origin" exists
 * - The directory is not a git repository
 * - Git is not available
 *
 * Used by the workspace registry to derive the canonical repository fingerprint.
 */
export async function remoteOriginUrl(worktree: string): Promise<string | null> {
  try {
    const url = await git(worktree, ['remote', 'get-url', 'origin']);
    return url || null;
  } catch {
    logWarn('git', 'Failed to resolve remote origin URL', { worktree });
    return null;
  }
}
