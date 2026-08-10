/**
 * @module integration/implementation-candidate
 * @description Candidate resolution — derives ImplementationCandidate from the worktree.
 *
 * Shared authority for both /implement (record) and /review-decision (approval
 * re-observation). Uses the same baseline-scoping authority, git hashing, and
 * digest computation as the implement-record pipeline.
 *
 * @version v1
 */

import {
  type ImplementationCandidate,
  computeCandidateDigest,
  computeContentDigest,
} from '../state/evidence-candidate.js';
import { hashWorktreeFiles, worktreeDiff, headCommitFull } from '../adapters/git.js';
import type { SessionState } from '../state/schema.js';
import type { ImplementationApprovalObservation } from '../state/implementation-approval-binding.js';

// ─── Candidate Identity ────────────────────────────────────────────────────────

export interface CandidateIdentity {
  readonly candidateDigest: string;
  readonly contentDigest: string;
}

// ─── Full Candidate Resolution ─────────────────────────────────────────────────

export interface ResolvedImplementationCandidate {
  readonly identity: ImplementationCandidate;
}

/**
 * Resolve a full ImplementationCandidate from the worktree using the same
 * task-owned scoping authority as /implement.
 *
 * Steps:
 * 1. Get current changed files from git
 * 2. Apply baseline attribution (same logic as scopeImplementationFiles)
 * 3. Hash current file content
 * 4. Compute contentDigest
 * 5. Compute diffDigest
 * 6. Get baseHeadSha
 * 7. Compute candidateDigest
 */
export async function resolveImplementationCandidate(
  worktree: string,
  taskOwnedPaths: readonly string[],
): Promise<ResolvedImplementationCandidate | null> {
  const sortedPaths = [...taskOwnedPaths].sort();

  if (sortedPaths.length === 0) return null;

  const contentHashes = await hashWorktreeFiles(worktree, sortedPaths);
  const contentDigest = computeContentDigest(
    sortedPaths.map((p) => ({
      path: p,
      blobDigest: contentHashes[p] ?? 'deleted',
    })),
  );

  let diffDigest: string | null = null;
  const diffText = await worktreeDiff(worktree, sortedPaths);
  if (diffText.trim().length > 0) {
    const { hashText } = await import('../shared/hashing.js');
    diffDigest = hashText(diffText);
  }

  const baseHeadSha = await headCommitFull(worktree);
  const candidateDigest = computeCandidateDigest({
    baseHeadSha,
    changedPaths: sortedPaths,
    contentDigest,
    diffDigest,
  });

  return {
    identity: {
      baseHeadSha,
      changedPaths: sortedPaths,
      contentDigest,
      diffDigest,
      candidateDigest,
    },
  };
}

// ─── Lightweight Identity for TOCTOU Re-observation ────────────────────────────

/**
 * Resolve a lightweight candidate identity for TOCTOU re-verification at
 * approval time. Must be cheaper than full content materialization or guaranteed
 * to detect every candidate-relevant change.
 */
export async function resolveImplementationCandidateIdentity(
  worktree: string,
  taskOwnedPaths: readonly string[],
): Promise<CandidateIdentity | null> {
  const captured = await resolveImplementationCandidate(worktree, taskOwnedPaths);
  if (!captured) return null;
  return {
    candidateDigest: captured.identity.candidateDigest,
    contentDigest: captured.identity.contentDigest,
  };
}

// ─── Approval Observation ──────────────────────────────────────────────────────

/**
 * Resolve the host-authoritative implementation-approval observation for the
 * current worktree, using the same task-owned scoping authority as /implement.
 *
 * The observation captures what the repository currently resolves to; it is
 * compared against the persisted candidate inside the rail to detect drift.
 */
export async function resolveImplementationApprovalObservation(
  state: SessionState,
  worktree: string,
): Promise<ImplementationApprovalObservation | null> {
  const candidate = state.implementationCandidate;
  if (!candidate) return null;

  const identity = await resolveImplementationCandidateIdentity(worktree, candidate.changedPaths);

  return identity ?? null;
}
