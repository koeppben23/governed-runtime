/**
 * @module evidence-candidate
 * @description Immutable ImplementationCandidate — the canonical identity of one
 *              repository base plus one exact resulting change set.
 *
 *              Every implementation evidence record binds to exactly one candidate.
 *              No changed path, diff, or content identity may be borrowed from
 *              another worktree moment.
 *
 * @version v1
 */

import { z } from 'zod';
import { RepositoryPathSchema, type RepositoryPath } from './evidence-review.js';
import { canonicalJsonStringify } from '../shared/canonical-json.js';
import { hashText } from '../shared/hashing.js';

/**
 * An immutable repository candidate from which changed paths, diff and content
 * identity are all derived.
 *
 * - `baseHeadSha`: HEAD at capture time, or null for an initial repository without HEAD.
 * - `changedPaths`: canonical set of task-owned changed paths (deduplicated, sorted).
 * - `contentDigest`: identifies the final contents of every repository path
 *   participating in the candidate (hash of sorted `{path, state, blobDigest}` entries).
 * - `diffDigest`: exact transformation representation (hash of the complete
 *   binary-capable diff).
 * - `candidateDigest`: canonical lifecycle identity — structural binding of snapshot,
 *   inventory, content identity and diff identity.
 *
 * Self-consistency: the candidateDigest field MUST equal the result of
 * `computeCandidateDigest()` over the candidate's own fields. This is enforced
 * at the Zod schema boundary so no caller can submit a pre-computed digest
 * that is inconsistent with its structural identity.
 */
export const ImplementationCandidate = z
  .object({
    version: z.literal(1),
    baseHeadSha: z
      .string()
      .regex(/^[0-9a-f]{40}$/i)
      .nullable(),
    changedPaths: z.array(RepositoryPathSchema).transform((paths) => [...new Set(paths)].sort()),
    contentDigest: z.string().min(1),
    diffDigest: z.string().min(1),
    candidateDigest: z.string().min(1),
  })
  .strict()
  .readonly()
  .superRefine((candidate, ctx) => {
    const expected = computeCandidateDigest({
      baseHeadSha: candidate.baseHeadSha,
      changedPaths: candidate.changedPaths,
      contentDigest: candidate.contentDigest,
      diffDigest: candidate.diffDigest,
    });
    if (candidate.candidateDigest !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `candidateDigest does not match computed identity. Expected ${expected}, got ${candidate.candidateDigest}`,
        path: ['candidateDigest'],
      });
    }
  });
export type ImplementationCandidate = z.infer<typeof ImplementationCandidate>;

/**
 * Compute the canonical candidate digest from structural candidate identity.
 *
 * Uses the central canonical JSON authority so two byte-identical candidates
 * always produce the same digest. The digest binds: version, baseHeadSha,
 * changedPaths (deduped, sorted), contentDigest and diffDigest.
 */
export function computeCandidateDigest(input: {
  baseHeadSha: string | null;
  changedPaths: readonly RepositoryPath[];
  contentDigest: string;
  diffDigest: string;
}): string {
  const sortedPaths = [...new Set(input.changedPaths)].sort();
  return hashText(
    canonicalJsonStringify({
      version: 1,
      baseHeadSha: input.baseHeadSha,
      changedPaths: sortedPaths,
      contentDigest: input.contentDigest,
      diffDigest: input.diffDigest,
    }),
  );
}

/**
 * Structural equality of two implementation candidates.
 *
 * Prefer `expected.candidateDigest === actual.candidateDigest` after schema
 * validation. This helper performs the same comparison but also validates
 * both inputs through the schema first.
 */
export function sameImplementationCandidate(
  expected: ImplementationCandidate,
  actual: ImplementationCandidate,
): boolean {
  return expected.candidateDigest === actual.candidateDigest;
}

// ─── Content Digest Computation ────────────────────────────────────────────────

/**
 * Compute the canonical content digest from a set of changed path entries.
 *
 * Each entry maps a path to its state (`present` | `deleted`) and optional
 * git blob hash. The digest hashes the canonical JSON representation of the
 * sorted entries, so two candidates with the same final file contents always
 * produce the same contentDigest.
 */
export function computeContentDigest(
  entries: readonly {
    path: RepositoryPath;
    state: 'present' | 'deleted';
    blobDigest: string | null;
  }[],
): string {
  const canonical = [...entries]
    .map((e) => ({
      path: e.path,
      state: e.state,
      blobDigest: e.blobDigest,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return hashText(canonicalJsonStringify(canonical));
}
