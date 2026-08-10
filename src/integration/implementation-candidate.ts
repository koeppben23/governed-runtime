/**
 * @module integration/implementation-candidate
 * @description Single resolver for an immutable worktree candidate.
 *
 *              Resolves task-owned changed paths (after baseline attribution),
 *              final contents, and a complete diff from one worktree moment.
 *              Callers downstream never independently recompute candidate identity.
 *
 * @version v2
 */

import {
  changedFiles,
  captureCandidateDiff,
  hashWorktreeFiles,
  headCommitFull,
  trackedPaths,
} from '../adapters/git.js';
import type { ImplementationCandidate } from '../state/evidence-candidate.js';
import { ImplementationCandidate as ImplementationCandidateSchema } from '../state/evidence-candidate.js';
import type { RepositoryPath } from '../state/evidence-review.js';
import { computeCandidateDigest, computeContentDigest } from '../state/evidence-candidate.js';
import { hashBuffer } from '../shared/hashing.js';

/** The resolved candidate alongside the exact diff bytes used for diffDigest. */
export interface CapturedImplementationCandidate {
  identity: ImplementationCandidate;
  candidateDiffBytes: Buffer;
}

/** Candidate resolution with lightweight identity-only output for re-verification. */
export interface CandidateIdentity {
  candidateDigest: string;
}

/** Input for candidate resolution allowing task-owned path scoping. */
export interface ResolveCandidateInput {
  worktree: string;
  /** Optional set of task-owned paths. When provided, only these paths
   *  participate in the candidate; all other worktree changes are excluded. */
  taskOwnedPaths?: readonly string[];
}

/**
 * Resolve a full implementation candidate from the current worktree.
 *
 * When `taskOwnedPaths` is provided, the candidate represents exactly those
 * paths — baseline attribution happens BEFORE candidate identity is computed.
 *
 * Captures the complete candidate state (base HEAD, changed paths, file
 * hashes, complete binary-capable diff) and returns the identity together
 * with the exact diff bytes.
 */
export async function resolveImplementationCandidate(
  worktree: string,
  taskOwnedPaths?: readonly string[],
): Promise<CapturedImplementationCandidate | null> {
  const candidatePaths =
    taskOwnedPaths !== undefined ? [...taskOwnedPaths] : await changedFiles(worktree);

  if (candidatePaths.length === 0) return null;

  const baseHeadSha = await headCommitFull(worktree);

  const changedPaths: RepositoryPath[] = [...candidatePaths].sort();

  const contentHashes = await hashWorktreeFiles(worktree, changedPaths);
  const contentEntries = changedPaths.map((path) => {
    const blobDigest = contentHashes[path] ?? null;
    return {
      path,
      state: blobDigest === null ? ('deleted' as const) : ('present' as const),
      blobDigest,
    };
  });
  const contentDigest = computeContentDigest(contentEntries);

  const { trackedPaths: tracked, untrackedPaths: untracked } = await trackedPaths(
    worktree,
    changedPaths,
  );

  const candidateDiffBytes = await captureCandidateDiff(worktree, tracked, untracked);
  const diffDigest = hashBuffer(candidateDiffBytes);

  const candidateDigest = computeCandidateDigest({
    baseHeadSha,
    changedPaths,
    contentDigest,
    diffDigest,
  });

  const identity = ImplementationCandidateSchema.parse({
    version: 1,
    baseHeadSha,
    changedPaths,
    contentDigest,
    diffDigest,
    candidateDigest,
  });

  return { identity, candidateDiffBytes };
}

/**
 * Resolve a lightweight candidate identity for TOCTOU re-verification.
 *
 * Uses the full resolver for correctness. Must be cheaper than full content
 * materialization or guaranteed to detect every candidate-relevant change.
 */
export async function resolveImplementationCandidateIdentity(
  worktree: string,
  taskOwnedPaths?: readonly string[],
): Promise<CandidateIdentity | null> {
  const captured = await resolveImplementationCandidate(worktree, taskOwnedPaths);
  if (!captured) return null;
  return { candidateDigest: captured.identity.candidateDigest };
}
