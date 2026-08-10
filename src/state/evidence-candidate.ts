/**
 * @module evidence-candidate
 * @description ImplementationCandidate — canonical identity for one exact implementation change set.
 *
 * candidateDigest = lifecycle identity (binds Risk, Review, Approval)
 * contentDigest  = resulting file-content identity (binds Validation, Execution Evidence)
 *
 * Two candidates with identical file content but different provenance (e.g. base SHA,
 * patch identity, or changed-path set) always produce different candidateDigest values
 * even when contentDigest is identical. Review and Approval authority MUST be re-earned.
 *
 * @version v1
 */

import { z } from 'zod';
import { hashText } from '../shared/hashing.js';
import { canonicalJsonStringify } from '../shared/canonical-json.js';

// ─── Digest Computation ────────────────────────────────────────────────────────

/**
 * Compute the lifecycle candidate digest from structural candidate fields.
 *
 * Domain-separated from contentDigest: two candidates with identical file content
 * but different base or changed-path identity produce distinct candidateDigest
 * values. This is the digest that Review, Risk, and Approval authorities bind to.
 */
export function computeCandidateDigest(identity: {
  baseHeadSha: string | null;
  changedPaths: readonly string[];
  contentDigest: string;
  diffDigest: string | null;
}): string {
  const payload = canonicalJsonStringify({
    baseHeadSha: identity.baseHeadSha ?? null,
    changedPaths: [...identity.changedPaths].sort(),
    contentDigest: identity.contentDigest,
    diffDigest: identity.diffDigest ?? null,
  });
  return hashText(payload);
}

/**
 * Compute content digest from sorted {path, blobDigest} entries.
 *
 * Only file content matters; two candidates whose changed files resolve to
 * identical blobs produce the same contentDigest regardless of base or path order.
 */
export function computeContentDigest(
  entries: readonly { path: string; blobDigest: string }[],
): string {
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  const payload = canonicalJsonStringify(
    sorted.map((e) => ({ path: e.path, blobDigest: e.blobDigest })),
  );
  return hashText(payload);
}

// ─── ImplementationCandidate ────────────────────────────────────────────────────

export const ImplementationCandidate = z
  .object({
    /** Hash of the current commit before implementation (HEAD), or null for detached/unborn. */
    baseHeadSha: z
      .string()
      .regex(/^[0-9a-f]{40}$/i)
      .nullable(),
    /** Canonical set of task-owned changed paths (sorted, deduplicated). */
    changedPaths: z.array(z.string().min(1)).transform((paths) => [...new Set(paths)].sort()),
    /** Content digest over final file states (path + git blob hash). */
    contentDigest: z.string().min(1),
    /** Digest of captured unified diff, or null when no diff was captured. */
    diffDigest: z.string().min(1).nullable(),
    /** Self-consistent lifecycle digest — computed from (baseHeadSha, changedPaths, contentDigest, diffDigest). */
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
        message: `candidateDigest does not match computed identity: got ${candidate.candidateDigest}, expected ${expected}`,
        path: ['candidateDigest'],
      });
    }
  });

export type ImplementationCandidate = z.infer<typeof ImplementationCandidate>;
