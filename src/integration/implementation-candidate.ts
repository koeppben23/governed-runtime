/**
 * @module integration/implementation-candidate
 * @description Single resolver for an immutable worktree candidate.
 *
 *              Resolves changed paths, final contents, and a complete diff from
 *              one worktree moment. Callers downstream never independently
 *              recompute candidate identity.
 *
 * @version v1
 */

import {
  changedFiles,
  captureCandidateDiff,
  hashWorktreeFiles,
  headCommitFull,
} from '../adapters/git.js';
import type { ImplementationCandidate } from '../state/evidence-candidate.js';
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

/**
 * Classify a list of candidate paths into tracked and untracked.
 *
 * Uses a single `git ls-files -- <paths>` call (not one per path) to
 * determine which paths exist in the index/HEAD. Paths not in the output
 * are untracked; paths present are tracted (modified, deleted, staged).
 */
async function classifyCandidatePaths(
  worktree: string,
  paths: readonly string[],
): Promise<{ trackedPaths: string[]; untrackedPaths: string[] }> {
  const trackedPaths: string[] = [];
  const untrackedPaths: string[] = [];

  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);

  try {
    const { stdout } = await execFileAsync('git', ['ls-files', '--', ...paths], {
      cwd: worktree,
      timeout: 5_000,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
    const tracked = new Set(stdout.split('\n').filter(Boolean));
    for (const p of paths) {
      if (tracked.has(p)) {
        trackedPaths.push(p);
      } else {
        untrackedPaths.push(p);
      }
    }
  } catch {
    // If ls-files fails entirely (e.g. no git repo), treat all as untracked
    for (const p of paths) {
      untrackedPaths.push(p);
    }
  }

  return { trackedPaths, untrackedPaths };
}

/**
 * Resolve a full implementation candidate from the current worktree.
 *
 * Captures the complete candidate state (base HEAD, changed paths, file
 * hashes, complete binary-capable diff) and returns the identity together
 * with the exact diff bytes.
 */
export async function resolveImplementationCandidate(
  worktree: string,
): Promise<CapturedImplementationCandidate | null> {
  const files = await changedFiles(worktree);
  if (files.length === 0) return null;

  const baseHeadSha = await headCommitFull(worktree);

  const changedPaths: RepositoryPath[] = [...files].sort();

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

  const { trackedPaths, untrackedPaths } = await classifyCandidatePaths(worktree, changedPaths);

  const candidateDiffBytes = await captureCandidateDiff(worktree, trackedPaths, untrackedPaths);
  const diffDigest = hashBuffer(candidateDiffBytes);

  const candidateDigest = computeCandidateDigest({
    baseHeadSha,
    changedPaths,
    contentDigest,
    diffDigest,
  });

  const identity: ImplementationCandidate = {
    version: 1,
    baseHeadSha,
    changedPaths,
    contentDigest,
    diffDigest,
    candidateDigest,
  };

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
): Promise<CandidateIdentity | null> {
  const captured = await resolveImplementationCandidate(worktree);
  if (!captured) return null;
  return { candidateDigest: captured.identity.candidateDigest };
}
