/**
 * @module integration/plugin-git-gate
 * @description Git prerequisite for host mutation dispatch (#852).
 *
 * The implementation evidence pipeline is git-derived: changed-file detection,
 * content hashes, and the diff artifact all read the worktree through git.
 * A host mutation in a non-Git worktree can therefore NEVER be bound into
 * recordable implementation evidence. Fail closed BEFORE the first mutating
 * host operation (write/edit/apply_patch/bash) so the agent cannot make
 * repository changes that a later `flowguard_implement()` would refuse to
 * record — and preserve the typed git diagnosis (GIT_NOT_FOUND / GIT_TIMEOUT)
 * instead of flattening every failure into NOT_GIT_REPO.
 *
 * @version v1
 */

import { buildEnforcementError } from './plugin-helpers.js';
import { GitError, isGitRepoStrict } from '../adapters/git.js';

export interface GitPrerequisiteDeps {
  getWorktreeRoot(): string | undefined;
}

/**
 * Fail closed when the governed worktree is not a git repository.
 *
 * Called for every mutating host tool BEFORE risk/discovery gates and before
 * the durable mutation dispatch is authorized, so a blocked dispatch leaves no
 * MutationEpisode and no repository mutation.
 *
 * @throws FlowGuardEnforcementError with NOT_GIT_REPO, GIT_NOT_FOUND, or
 *         GIT_TIMEOUT (typed code preserved).
 */
export async function enforceGitPrerequisiteBeforeMutation(
  deps: GitPrerequisiteDeps,
  toolName: string,
): Promise<void> {
  const worktree = deps.getWorktreeRoot();
  if (!worktree) {
    throw buildEnforcementError(
      'PLUGIN_ENFORCEMENT_UNAVAILABLE',
      `Cannot authorize host mutation '${toolName}': the governed worktree is unavailable.`,
      { tool: toolName },
    );
  }
  try {
    if (await isGitRepoStrict(worktree)) return;
  } catch (err) {
    if (err instanceof GitError) {
      throw buildEnforcementError(err.code, err.message, {
        tool: toolName,
        message: err.message,
        reason: err.message,
      });
    }
    throw err;
  }
  throw buildEnforcementError(
    'NOT_GIT_REPO',
    `Host mutation '${toolName}' is blocked: the worktree is not a git repository, so the ` +
      'resulting implementation evidence could never be recorded. Initialize git BEFORE this ' +
      'session (git init) and re-hydrate so a fresh implementation baseline is established; ' +
      'do not run git init inside the current governed session.',
    { tool: toolName, path: worktree },
  );
}
