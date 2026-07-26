/**
 * @module integration/tools/review-obligation-classification
 * @description Resolves the path evidence required before challenge obligations are created.
 */

import type { SessionState } from '../../state/schema.js';
import { loadBranchChangedFiles, loadPrChangedFiles } from '../../adapters/gh-cli.js';

export type ChallengeClassificationEvidence =
  | { kind: 'not_required' }
  | { kind: 'available'; changedFiles: readonly string[] }
  | { kind: 'unavailable'; reason: string };

export interface ChallengePathOptions {
  targetPaths?: string[];
  branch?: string;
  base?: string;
  prNumber?: number;
}

function resolveAutoPaths(
  worktree: string | undefined,
  options: ChallengePathOptions,
): string[] | null {
  if (options.branch && worktree) {
    const files = loadBranchChangedFiles(options.branch, options.base, worktree);
    if (files.length > 0) return files;
  }
  if (options.prNumber !== undefined) {
    const files = loadPrChangedFiles(options.prNumber);
    if (files.length > 0) return files;
  }
  return null;
}

export async function resolveChallengeClassificationEvidence(
  state: SessionState,
  worktree: string | undefined,
  options?: ChallengePathOptions,
): Promise<ChallengeClassificationEvidence> {
  if (!state.policySnapshot?.challengePolicy) return { kind: 'not_required' };

  if (options?.targetPaths && options.targetPaths.length > 0) {
    return { kind: 'available', changedFiles: options.targetPaths };
  }

  const autoPaths = resolveAutoPaths(worktree, options ?? {});
  if (autoPaths) return { kind: 'available', changedFiles: autoPaths };

  return {
    kind: 'unavailable',
    reason:
      'No canonical target-path evidence is available for this pre-implementation review obligation.',
  };
}
