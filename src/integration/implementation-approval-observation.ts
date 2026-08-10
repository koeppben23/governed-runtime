/**
 * @module integration/implementation-approval-observation
 * @description Resolves host-authoritative implementation-approval observations
 *              for the final approval live candidate recheck.
 *
 *              Uses the same baseline-scoping authority as /implement to derive
 *              current task-owned paths, then resolves a full candidate for
 *              comparison against the persisted candidate inside the rail.
 *
 *              Fail-closed: unknown/unobservable state must never be interpreted
 *              as evidence that the candidate is unchanged. When observation
 *              fails, the function returns null and the validator blocks.
 *
 * @version v2
 */

import type { SessionState } from '../state/schema.js';
import type { ImplementationApprovalObservation } from '../state/implementation-approval-binding.js';
import { resolveImplementationCandidate } from './implementation-candidate.js';
import { scopeImplementationFiles } from './tools/implement-record.js';
import { changedFiles, headCommitFull } from '../adapters/git.js';

/**
 * Resolve the host-authoritative implementation-approval observation for the
 * current worktree.
 *
 * Observation rules:
 * - Empty worktree + same HEAD → provably current → returns persisted identity.
 * - Empty worktree + different HEAD → HEAD change invalidates candidate → null.
 * - Task-owned files resolve to same candidate → authoritative match.
 * - Task-owned files resolve to different candidate → authoritative mismatch.
 * - Git failure / unresolvable → null (validator blocks — unknowable is unsafe).
 *
 * Never returns the persisted candidate as a substitute for failed observation.
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

  // No worktree changes — verify HEAD is still the same.
  if (rawFiles.length === 0) {
    return verifyHeadUnchanged(candidate, worktree);
  }

  const scoped = await scopeImplementationFiles(worktree, rawFiles, state.implementationBaseline);
  if ('block' in scoped) {
    // No task-owned files attributable — verify HEAD is still the same.
    if (scoped.block.includes('IMPLEMENTATION_EVIDENCE_EMPTY')) {
      return verifyHeadUnchanged(candidate, worktree);
    }
    return null;
  }

  // Resolve a full candidate from the current task-owned paths. This
  // produces a fresh candidateDigest that may match or differ from the
  // persisted candidate — the validator decides.
  try {
    const captured = await resolveImplementationCandidate(worktree, scoped.files);
    if (!captured) return null;

    return {
      candidateDigest: captured.identity.candidateDigest,
      contentDigest: captured.identity.contentDigest,
    };
  } catch {
    return null; // git unavailable → unknowable → fail-closed
  }
}

/**
 * When the worktree has no changed files, the candidate is provably current
 * only if the repository HEAD still matches the candidate's baseHeadSha.
 *
 * A clean worktree after a commit, rebase, or HEAD switch has a different
 * repository identity — observedCandidate MUST NOT lie and claim the
 * persisted candidate is still current.
 */
async function verifyHeadUnchanged(
  candidate: NonNullable<SessionState['implementation']>['candidate'],
  worktree: string,
): Promise<ImplementationApprovalObservation | null> {
  let currentHeadSha: string | null;
  try {
    currentHeadSha = await headCommitFull(worktree);
  } catch {
    return null; // git unavailable → unknowable → fail-closed
  }

  // HEAD unchanged — candidate is provably current.
  if (currentHeadSha === candidate.baseHeadSha) {
    return {
      candidateDigest: candidate.candidateDigest,
      contentDigest: candidate.contentDigest,
    };
  }

  // HEAD changed — the repository identity has shifted. Even with a clean
  // worktree, the candidate is no longer current. Return null so the
  // validator can report IMPLEMENTATION_CANDIDATE_STALE.
  return null;
}
