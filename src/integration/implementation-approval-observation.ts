/**
 * @module integration/implementation-approval-observation
 * @description Resolves host-authoritative implementation-approval observations
 *              for the final approval live candidate recheck.
 *
 *              Uses the same baseline-scoping authority as /implement to derive
 *              current task-owned paths, then resolves a full candidate for
 *              comparison against the persisted candidate inside the rail.
 *
 *              Always resolves a real candidate from the current worktree state.
 *              Never returns the persisted candidate identity as a proxy
 *              observation — the validator detects drift via digest comparison.
 *
 *              Fail-closed: unknown/unobservable state must never be interpreted
 *              as evidence that the candidate is unchanged. When observation
 *              fails, the function returns null and the validator blocks.
 *
 * @version v3
 */

import type { SessionState } from '../state/schema.js';
import type { ImplementationApprovalObservation } from '../state/implementation-approval-binding.js';
import { resolveImplementationCandidate } from './implementation-candidate.js';
import { scopeImplementationFiles } from './tools/implement-record.js';
import { changedFiles } from '../adapters/git.js';

/**
 * Resolve the host-authoritative implementation-approval observation for the
 * current worktree.
 *
 * Always resolves a real candidate from the current worktree state and returns
 * its digests. The validator compares observedCandidate.candidateDigest against
 * the persisted candidate — a mismatch (including an empty worktree that no
 * longer has the recorded change set) correctly blocks approval.
 *
 * Observation rules:
 * - Empty worktree → resolve candidate with no task-owned paths. If the
 *   previously recorded changed files are gone, the new candidateDigest
 *   differs → validator blocks.
 * - Task-owned files resolve to same candidate → approval proceeds.
 * - Task-owned files resolve to different candidate → validator blocks.
 * - Git failure / unresolvable → null (validator blocks — unknowable is unsafe).
 *
 * Never returns the persisted candidate as a substitute for any observation.
 */
export async function resolveImplementationApprovalObservation(
  state: SessionState,
  worktree: string,
): Promise<ImplementationApprovalObservation | null> {
  const candidate = state.implementation?.candidate;
  if (!candidate) return null;

  let rawFiles: string[];
  try {
    rawFiles = await changedFiles(worktree);
  } catch {
    return null; // git unavailable → unknowable → fail-closed
  }

  // Derive the current task-owned path set using the same baseline-scoping
  // authority as /implement. An empty worktree or fully-baseline-subtracted
  // set resolves to an empty path list — the resulting candidate will have
  // a different candidateDigest than the persisted candidate (which has
  // changedPaths from the original implement record).
  let taskOwnedPaths: string[] = [];
  if (rawFiles.length > 0) {
    const scoped = await scopeImplementationFiles(worktree, rawFiles, state.implementationBaseline);
    if ('block' in scoped) {
      // IMPLEMENTATION_EVIDENCE_EMPTY means no current files are task-owned.
      // Let the path set be empty — the resulting candidate will differ from
      // the persisted candidate (which has non-empty changedPaths).
      if (!scoped.block.includes('IMPLEMENTATION_EVIDENCE_EMPTY')) {
        return null;
      }
    } else {
      taskOwnedPaths = [...scoped.files];
    }
  }

  // Resolve a real candidate from the current worktree with the derived
  // task-owned paths. Even an empty path set produces a valid candidate
  // with a real candidateDigest.
  try {
    const captured = await resolveImplementationCandidate(worktree, taskOwnedPaths);
    if (!captured) return null;

    return {
      candidateDigest: captured.identity.candidateDigest,
      contentDigest: captured.identity.contentDigest,
    };
  } catch {
    return null; // git unavailable → unknowable → fail-closed
  }
}
