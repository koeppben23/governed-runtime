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

import { isAbsolute, normalize } from 'node:path';

import { changedFiles, hashWorktreeFiles } from '../adapters/git.js';
import { isVerificationCandidateBound } from '../state/candidate-identity.js';
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

/**
 * Exact worktree paths FlowGuard itself wrote for the session's validation
 * attempts.
 *
 * `run_specific` structured candidates execute `<command> <outputArgument>`
 * where the argument carries `.flowguard/reports/{attemptId}/...`; the report
 * file is tool-owned evidence, not governed implementation bytes. Without this
 * narrow boundary:
 * - baseline reports (pre-implementation `/check` at VALIDATION, written
 *   AFTER hydrate and therefore not baseline dirt) would be frozen into
 *   `implementation.changedFiles` and classified as project surfaces,
 * - the post-check re-attestation would count the report of the very check
 *   that just passed as subject drift.
 *
 * The boundary is deliberately derived — not pattern-matched:
 * - baseline attempts count only for the CURRENT approved plan (an earlier
 *   plan version's checks are not part of this delivery),
 * - implementation attempts count for every recorded generation, so the
 *   boundary is identical at the `/implement` freeze and at the later
 *   re-attestation (a superseded generation's report must not resurface as
 *   drift after a re-record),
 * - only candidates whose id still hashes their complete definition
 *   (an edited definition cannot smuggle an exclusion),
 * - only the deterministic `resultPatternTemplate` substitution, never a
 *   wildcard or directory prefix.
 */
export function flowguardReportArtifacts(state: SessionState): readonly string[] {
  const candidates = new Map(
    (state.verificationCandidates ?? []).map((candidate) => [candidate.candidateId, candidate]),
  );
  const planDigest = state.plan?.current.digest;
  const artifacts = new Set<string>();
  for (const attempt of state.validationAttempts) {
    if (!attemptIsToolOwnedEvidence(attempt, planDigest)) continue;
    const candidateId = attempt.result.candidateId;
    if (candidateId === undefined) continue;
    const candidate = candidates.get(candidateId);
    if (candidate === undefined) continue;
    const template = runSpecificResultPattern(candidate);
    if (template === null) continue;
    const path = safeArtifactPath(template, attempt.attemptId);
    if (path !== null) artifacts.add(path);
  }
  return [...artifacts];
}

function attemptIsToolOwnedEvidence(
  attempt: SessionState['validationAttempts'][number],
  planDigest: string | undefined,
): boolean {
  if (attempt.scope === 'implementation') return true;
  return planDigest !== undefined && attempt.planDigest === planDigest;
}

/** The frozen report pattern, only from a still-bound run_specific candidate. */
function runSpecificResultPattern(
  candidate: NonNullable<SessionState['verificationCandidates']>[number],
): string | null {
  if (candidate.assertionCapability !== 'structured') return null;
  if (candidate.assertionReport.collection !== 'run_specific') return null;
  if (!isVerificationCandidateBound(candidate)) return null;
  return candidate.assertionReport.resultPatternTemplate;
}

/** Substitute the attempt id and reject anything outside the worktree. */
function safeArtifactPath(template: string, attemptId: string): string | null {
  const path = normalize(template.replace(/\{attemptId\}/g, attemptId));
  return isAbsolute(path) || path.startsWith('..') ? null : path;
}

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
  /** Exact tool-generated paths that are not governed implementation bytes. */
  readonly ignoredArtifacts?: readonly string[];
}): Promise<ImplementationSubjectReattestation> {
  const rawFiles = await changedFiles(input.worktree);
  const scoped = await scopeImplementationFiles(input.worktree, rawFiles, input.baseline);
  const ignored = new Set((input.ignoredArtifacts ?? []).map((path) => normalize(path)));
  const currentFiles =
    scoped.kind === 'ok'
      ? scoped.subject.files.filter((file) => !ignored.has(normalize(file)))
      : [];

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
