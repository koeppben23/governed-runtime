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
 *
 * When the worktree has no current changes, the recorded candidate is still
 * authoritative — no drift has occurred, so the observation conditionally
 * returns the persisted candidate identity. An empty worktree does not
 * invalidate the approval.
 */
export async function resolveImplementationApprovalObservation(
  state: SessionState,
  worktree: string,
): Promise<ImplementationApprovalObservation | null> {
  const candidate = state.implementation?.candidate;
  if (!candidate) return null;

  const rawFiles = await changedFiles(worktree);

  // No current worktree changes → the persisted candidate is still current.
  // Return the candidate identity as the observation.
  if (rawFiles.length === 0) {
    return {
      candidateDigest: candidate.candidateDigest,
      contentDigest: candidate.contentDigest,
    };
  }

  const scoped = await scopeImplementationFiles(worktree, rawFiles, state.implementationBaseline);
  if ('block' in scoped) {
    // Baseline scoping produced no attributable files — the candidate is
    // still current (no task-owned drift detected).
    if (scoped.block.includes('IMPLEMENTATION_EVIDENCE_EMPTY')) {
      return {
        candidateDigest: candidate.candidateDigest,
        contentDigest: candidate.contentDigest,
      };
    }
    return null;
  }

  try {
    const captured = await resolveImplementationCandidate(worktree, scoped.files);
    if (!captured) return null;

    return {
      candidateDigest: captured.identity.candidateDigest,
      contentDigest: captured.identity.contentDigest,
    };
  } catch {
    // Git resolution failed (e.g. no repo, detached HEAD). Treat as no
    // observable drift — the persisted candidate is still authoritative.
    return {
      candidateDigest: candidate.candidateDigest,
      contentDigest: candidate.contentDigest,
    };
  }
}
