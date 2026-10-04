/**
 * @module evidence-findings
 * @description Canonical structured findings and repository anchors.
 */

import { z } from 'zod';
import { canonicalJsonStringify } from '../shared/canonical-json.js';
import { classifyRepositoryPath } from './repository-path.js';

/** Strict, normalized repository-relative path used by review anchors and scopes. */
export const RepositoryPathSchema = z.string().transform((value, context) => {
  const classification = classifyRepositoryPath(value);
  if (classification.kind === 'valid') return classification.normalizedPath;
  context.addIssue({ code: 'custom', message: 'Expected a repository-relative POSIX path' });
  return z.NEVER;
});
export type RepositoryPath = z.infer<typeof RepositoryPathSchema>;

/** Canonical finding severity vocabulary. Declared once and referenced by every projection. */
export const FindingSeverity = z.enum(['critical', 'major', 'minor']);
export type FindingSeverity = z.infer<typeof FindingSeverity>;

/** Canonical finding category vocabulary. Declared once and referenced by every projection. */
export const FindingCategory = z.enum([
  'completeness',
  'correctness',
  'feasibility',
  'risk',
  'quality',
]);
export type FindingCategory = z.infer<typeof FindingCategory>;

/** Canonical reviewed-artifact kind vocabulary (plan/ADR anchors). */
export const ArtifactKind = z.enum(['plan', 'adr']);
export type ArtifactKind = z.infer<typeof ArtifactKind>;

/** Canonical frozen repository revision vocabulary. */
export const ReviewRevision = z.enum(['base', 'head']);
export type ReviewRevision = z.infer<typeof ReviewRevision>;

/** A repository location at the frozen review base or head. */
export const RepositoryLocation = z
  .object({
    path: RepositoryPathSchema,
    revision: ReviewRevision,
    line: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
  })
  .refine(({ line, endLine }) => endLine === undefined || (line !== undefined && endLine >= line), {
    message: 'endLine must not precede line',
    path: ['endLine'],
  })
  .strict()
  .readonly();
export type RepositoryLocation = z.infer<typeof RepositoryLocation>;

/** A deterministic Markdown heading path, including presentation-only text. */
export const MarkdownSectionPath = z
  .array(
    z
      .object({
        headingDepth: z.number().int().min(1).max(6),
        siblingIndex: z.number().int().positive(),
        headingText: z.string(),
      })
      .strict(),
  )
  .min(1)
  .readonly();
export type MarkdownSectionPath = z.infer<typeof MarkdownSectionPath>;

/** A digest-bound anchor within a structured artifact section. */
export const ArtifactSectionAnchor = z
  .object({
    kind: z.literal('artifact_section'),
    artifactKind: ArtifactKind,
    artifactDigest: z.string().min(1),
    sectionPath: MarkdownSectionPath,
  })
  .strict()
  .readonly();
export type ArtifactSectionAnchor = z.infer<typeof ArtifactSectionAnchor>;

export const RepositoryLocationAnchor = z
  .object({
    kind: z.literal('repository_location'),
    location: RepositoryLocation,
  })
  .strict()
  .readonly();
export type RepositoryLocationAnchor = z.infer<typeof RepositoryLocationAnchor>;

const SafeUrlComponent = z
  .string()
  .min(1)
  .refine(
    (value) => {
      try {
        const parsed = new URL(value);
        return (
          parsed.origin === value &&
          parsed.protocol === 'https:' &&
          parsed.username === '' &&
          parsed.password === ''
        );
      } catch {
        return false;
      }
    },
    { message: 'Expected an HTTPS origin without credentials, query, or fragment' },
  );

const SafeUrlPathname = z
  .string()
  .startsWith('/')
  .refine((value) => !value.includes('?') && !value.includes('#'), {
    message: 'Expected a pathname without query or fragment',
  });

/** Safe, display-only URL components for externally supplied reviewed content. */
export const SafeReviewUrlMetadata = z
  .object({
    requested: z
      .object({ origin: SafeUrlComponent, pathname: SafeUrlPathname })
      .strict()
      .readonly(),
    resolved: z
      .object({ origin: SafeUrlComponent, pathname: SafeUrlPathname })
      .strict()
      .readonly()
      .optional(),
  })
  .strict()
  .readonly();
export type SafeReviewUrlMetadata = z.infer<typeof SafeReviewUrlMetadata>;

/** A digest-bound anchor for content reviewed outside the repository. */
export const ContentSubjectAnchor = z
  .object({
    kind: z.literal('content'),
    subjectDigest: z.string().min(1),
    range: z
      .object({
        startLine: z.number().int().positive(),
        endLine: z.number().int().positive().optional(),
      })
      .strict()
      .refine(({ startLine, endLine }) => endLine === undefined || endLine >= startLine, {
        message: 'endLine must not precede startLine',
        path: ['endLine'],
      })
      .readonly()
      .optional(),
  })
  .strict()
  .readonly();
export type ContentSubjectAnchor = z.infer<typeof ContentSubjectAnchor>;

/**
 * A digest-bound anchor for an implementation review subject. It proves ONLY
 * the subject relationship (this finding concerns that exact implementation)
 * — it is never repository evidence: no path, line, revision, or diffDigest
 * belongs here. Repository citations are evidenceLocations, admissible only
 * with an authoritative attempt-bound observation; the diff digest belongs to
 * `ImplementationRef` in the challenge evidence model.
 */
export const ImplementationSubjectAnchor = z
  .object({
    kind: z.literal('implementation'),
    implementationDigest: z.string().min(1),
  })
  .strict()
  .readonly();
export type ImplementationSubjectAnchor = z.infer<typeof ImplementationSubjectAnchor>;

/** A structured target or evidence anchor for a review finding. */
export const ReviewSubjectAnchor = z.discriminatedUnion('kind', [
  RepositoryLocationAnchor,
  ArtifactSectionAnchor,
  ContentSubjectAnchor,
  ImplementationSubjectAnchor,
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
  .strict()
  .readonly();
export type FindingRelation = z.infer<typeof FindingRelation>;

/** A relation-bound independent review finding. */
export const Finding = z
  .object({
    severity: FindingSeverity,
    category: FindingCategory,
    message: z.string(),
    relation: FindingRelation,
    findingId: z.string().uuid().optional(),
  })
  .strict()
  .readonly();
export type Finding = z.infer<typeof Finding>;
