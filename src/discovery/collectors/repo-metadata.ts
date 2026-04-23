/**
 * @module discovery/collectors/repo-metadata
 * @description Collector: repository metadata from git.
 *
 * Gathers:
 * - defaultBranch (from remote origin HEAD)
 * - headCommit (short SHA)
 * - isDirty (worktree cleanliness)
 * - worktreePath (absolute path)
 * - canonicalRemote (origin URL)
 * - fingerprint (24-hex)
 *
 * All data is factual (directly observed from git), classification = "fact".
 *
 * @version v1
 */

import type { CollectorInput, CollectorOutput, RepoMetadata } from '../types.js';
import * as git from '../../adapters/git.js';

/**
 * Collect repository metadata.
 *
 * Uses git adapter functions that already exist:
 * - defaultBranch(), headCommit(), isClean(), remoteOriginUrl()
 *
 * worktreePath and fingerprint come from CollectorInput (already resolved).
 */
export async function collectRepoMetadata(
  input: CollectorInput,
): Promise<CollectorOutput<RepoMetadata>> {
  try {
    const [branch, commit, clean, remote] = await Promise.all([
      git.defaultBranch(input.worktreePath),
      git.headCommit(input.worktreePath),
      git.isClean(input.worktreePath),
      git.remoteOriginUrl(input.worktreePath),
    ]);

    return {
      status: 'complete',
      data: {
        defaultBranch: branch,
        headCommit: commit,
        isDirty: !clean,
        worktreePath: input.worktreePath,
        canonicalRemote: remote,
        fingerprint: input.fingerprint,
      },
    };
  } catch {
    // Partial: return what we can with safe defaults
    return {
      status: 'partial',
      data: {
        defaultBranch: null,
        headCommit: null,
        isDirty: true,
        worktreePath: input.worktreePath,
        canonicalRemote: null,
        fingerprint: input.fingerprint,
      },
    };
  }
}
