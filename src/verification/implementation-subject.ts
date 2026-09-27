/**
 * @module verification/implementation-subject
 * @description Canonical governed implementation subject: baseline scoping,
 * content-bound digest and worktree re-attestation.
 *
 * One authority for the implementation bytes a decision, approval or export
 * operates on. The digest formula is unchanged (#762): sorted paths plus each
 * file's current content hash, missing files folded in as `deleted`.
 *
 * @version v1
 */

import { changedFiles, hashWorktreeFiles } from '../adapters/git.js';
import type { SessionState } from '../state/schema.js';

/** Scoped governed implementation files plus the scoping disposition. */
export interface ScopedImplementationFiles {
  readonly files: readonly string[];
  readonly baselineScoping: 'applied' | 'unavailable';
}

export type ScopedImplementationFilesResult =
  | { readonly kind: 'ok'; readonly subject: ScopedImplementationFiles }
  | { readonly kind: 'empty'; readonly rawFiles: readonly string[] };

/**
 * Apply pre-implementation baseline scoping: subtract files that were already
 * dirty at session start AND are still unchanged (same content hash), so
 * pre-existing worktree changes are not attributed to this implementation —
 * while a pre-dirty file the task actually modified (hash changed) is KEPT,
 * never hidden. Without a baseline, record the full set and mark scoping
 * unavailable. Never hides a change: when a hash is missing the file is kept.
 */
export async function scopeImplementationFiles(
  worktree: string,
  rawFiles: readonly string[],
  baseline: SessionState['implementationBaseline'],
): Promise<ScopedImplementationFilesResult> {
  if (!baseline) {
    return rawFiles.length === 0
      ? { kind: 'empty', rawFiles }
      : { kind: 'ok', subject: { files: rawFiles, baselineScoping: 'unavailable' } };
  }

  const baselineByPath = new Map(baseline.dirtyFiles.map((d) => [d.path, d.hash]));
  const candidatesToRehash = rawFiles.filter((f) => baselineByPath.has(f));
  const currentHashes =
    candidatesToRehash.length > 0 ? await hashWorktreeFiles(worktree, candidatesToRehash) : {};
  const files = rawFiles.filter((f) => {
    if (!baselineByPath.has(f)) return true; // not pre-dirty → task change
    const before = baselineByPath.get(f) ?? null;
    const now = currentHashes[f] ?? null;
    // Scope out ONLY when both hashes are present and equal (provably unchanged
    // since session start). If either hash is missing, we cannot prove the file
    // is untouched, so we conservatively KEEP it — never hide a change.
    if (before === null || now === null) return true;
    return before !== now; // changed since baseline → keep; unchanged → drop
  });

  return files.length === 0
    ? { kind: 'empty', rawFiles }
    : { kind: 'ok', subject: { files, baselineScoping: 'applied' } };
}

/**
 * Recompute the canonical content-bound digest over the given worktree files.
 * Used by /implement recording and by post-check / approval / export
 * re-attestation, so both can never drift.
 */
export async function computeImplementationDigest(input: {
  readonly worktree: string;
  readonly files: readonly string[];
  readonly digest: (text: string) => string;
}): Promise<string> {
  const sortedFiles = [...input.files].sort();
  const contentHashes = await hashWorktreeFiles(input.worktree, sortedFiles);
  return input.digest(sortedFiles.map((f) => `${f}:${contentHashes[f] ?? 'deleted'}`).join('\n'));
}

export type ImplementationSubjectReattestation =
  | { readonly kind: 'ok'; readonly digest: string }
  | { readonly kind: 'subject_changed'; readonly expected: string; readonly actual: string };

function sameFileSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((file, index) => file === sortedRight[index]);
}

/**
 * Prove that the CURRENT governed implementation subject still equals the
 * frozen one:
 *
 * 1. re-enumerate the live git changes,
 * 2. apply the frozen implementation baseline scoping,
 * 3. require exact set equality (add, delete and rename all change the set),
 * 4. recompute the canonical content digest over the frozen set.
 *
 * Hashing the stored file list alone is not proof: a file added after the
 * freeze would never appear in it. Any mismatch fails closed and requires a
 * fresh /implement.
 */
export async function reattestImplementationSubject(input: {
  readonly worktree: string;
  readonly frozenFiles: readonly string[];
  readonly expectedDigest: string;
  readonly baseline: SessionState['implementationBaseline'];
  readonly digest: (text: string) => string;
}): Promise<ImplementationSubjectReattestation> {
  const rawFiles = await changedFiles(input.worktree);
  const scoped = await scopeImplementationFiles(input.worktree, rawFiles, input.baseline);
  const currentFiles = scoped.kind === 'ok' ? [...scoped.subject.files] : [];

  if (!sameFileSet(currentFiles, input.frozenFiles)) {
    return {
      kind: 'subject_changed',
      expected: input.expectedDigest,
      actual: `file-set:${[...currentFiles].sort().join(',')}`,
    };
  }

  const actual = await computeImplementationDigest({
    worktree: input.worktree,
    files: input.frozenFiles,
    digest: input.digest,
  });
  return actual === input.expectedDigest
    ? { kind: 'ok', digest: actual }
    : { kind: 'subject_changed', expected: input.expectedDigest, actual };
}
