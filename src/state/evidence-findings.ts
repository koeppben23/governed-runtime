/**
 * @module evidence-findings
 * @description Canonical structured findings and repository anchors.
 */

import { z } from 'zod';
import { canonicalJsonStringify } from '../shared/canonical-json.js';
import { normalizeRepositoryPath } from './repository-path.js';

/** Strict, normalized repository-relative path used by review anchors and scopes. */
export const RepositoryPathSchema = z.string().transform((value, context) => {
  const normalized = normalizeRepositoryPath(value);
  if (normalized !== undefined) return normalized;
  context.addIssue({ code: 'custom', message: 'Expected a repository-relative POSIX path' });
  return z.NEVER;
});
export type RepositoryPath = z.infer<typeof RepositoryPathSchema>;

/** A repository location at the frozen review base or head. */
export const RepositoryLocation = z
  .object({
    path: RepositoryPathSchema,
    revision: z.enum(['base', 'head']),
    line: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
  })
  .refine(({ line, endLine }) => endLine === undefined || (line !== undefined && endLine >= line), {
    message: 'endLine must not precede line',
    path: ['endLine'],
  })
  .readonly();
export type RepositoryLocation = z.infer<typeof RepositoryLocation>;

/** A deterministic Markdown heading path, including presentation-only text. */
export const MarkdownSectionPath = z
  .array(
    z.object({
      headingDepth: z.number().int().min(1).max(6),
      siblingIndex: z.number().int().positive(),
      headingText: z.string(),
    }),
  )
  .min(1)
  .readonly();
export type MarkdownSectionPath = z.infer<typeof MarkdownSectionPath>;

/** A digest-bound anchor within a structured artifact section. */
export const ArtifactSectionAnchor = z
  .object({
    kind: z.literal('artifact_section'),
    artifactKind: z.enum(['plan', 'adr']),
    artifactDigest: z.string().min(1),
    sectionPath: MarkdownSectionPath,
  })
  .readonly();
export type ArtifactSectionAnchor = z.infer<typeof ArtifactSectionAnchor>;

export const RepositoryLocationAnchor = z
  .object({
    kind: z.literal('repository_location'),
    location: RepositoryLocation,
  })
  .readonly();
export type RepositoryLocationAnchor = z.infer<typeof RepositoryLocationAnchor>;

/** A structured target or evidence anchor for a review finding. */
export const ReviewSubjectAnchor = z.discriminatedUnion('kind', [
  RepositoryLocationAnchor,
  ArtifactSectionAnchor,
]);
export type ReviewSubjectAnchor = z.infer<typeof ReviewSubjectAnchor>;

/** Required relation between the reviewed subject and the evidence for a finding. */
export const FindingRelation = z
  .object({
    subjectAnchors: z.array(ReviewSubjectAnchor).min(1).readonly(),
    evidenceLocations: z.array(RepositoryLocation).readonly(),
  })
  .superRefine((relation, context) => {
    const duplicate = (items: readonly unknown[]) => {
      const seen = new Set<string>();
      return items.some((item) => {
        const key = canonicalJsonStringify(item);
        if (seen.has(key)) return true;
        seen.add(key);
        return false;
      });
    };
    if (duplicate(relation.subjectAnchors)) {
      context.addIssue({
        code: 'custom',
        path: ['subjectAnchors'],
        message: 'Duplicate subject anchor',
      });
    }
    if (duplicate(relation.evidenceLocations)) {
      context.addIssue({
        code: 'custom',
        path: ['evidenceLocations'],
        message: 'Duplicate evidence location',
      });
    }
  })
  .readonly();
export type FindingRelation = z.infer<typeof FindingRelation>;

/** A relation-bound independent review finding. */
export const Finding = z
  .object({
    severity: z.enum(['critical', 'major', 'minor']),
    category: z.enum(['completeness', 'correctness', 'feasibility', 'risk', 'quality']),
    message: z.string(),
    relation: FindingRelation,
    findingId: z.string().uuid().optional(),
  })
  .readonly();
export type Finding = z.infer<typeof Finding>;
