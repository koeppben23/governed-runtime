/**
 * @module integration/implementation-approval-observation
 * @description Resolves host-authoritative implementation-approval observations
 *              for the final approval live candidate recheck.
 *
 *              Uses the same baseline-scoping authority as /implement to derive
 *              current task-owned paths, then resolves a full candidate for
 *              comparison against the persisted candidate inside the rail.
 *
 * @version v1
 */

import type { SessionState } from '../state/schema.js';
import type { ImplementationApprovalObservation } from '../state/implementation-approval-binding.js';
import { resolveImplementationCandidate } from './implementation-candidate.js';
import { scopeImplementationFiles } from './tools/implement-record.js';
import { changedFiles } from '../adapters/git.js';

/**
 * Resolve the host-authoritative implementation-approval observation for the
 * current worktree, using the same task-owned scoping authority as /implement.
 *
 * Uses baseline attribution (scopeImplementationFiles) to derive the current
 * task-owned paths from raw worktree changes, then resolves a full candidate
 * from those paths. This ensures new task-owned files created after the last
 * /implement record are observed — never limited to frozen changedPaths.
 */
export async function resolveImplementationApprovalObservation(
  state: SessionState,
  worktree: string,
): Promise<ImplementationApprovalObservation | null> {
  const candidate = state.implementation?.candidate;
  if (!candidate) return null;

  const rawFiles = await changedFiles(worktree);
  const scoped = await scopeImplementationFiles(worktree, rawFiles, state.implementationBaseline);
  if ('block' in scoped) return null;

  const captured = await resolveImplementationCandidate(worktree, scoped.files);
  if (!captured) return null;

  return {
    candidateDigest: captured.identity.candidateDigest,
    contentDigest: captured.identity.contentDigest,
  };
}
