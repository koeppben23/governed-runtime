/**
 * @module evidence-review-subject
 * @description Immutable reviewed-subject and review-scope schemas.
 */

import { z } from 'zod';
import {
  MarkdownSectionPath,
  RepositoryPathSchema,
  SafeReviewUrlMetadata,
} from './evidence-findings.js';

const Sha256Digest = z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/i);
/** Canonical Git object id (commit, tree, blob). */
export const GitSha = z.string().regex(/^[a-f0-9]{40,64}$/i);
export type GitSha = z.infer<typeof GitSha>;

export const RepositoryIdentity = z
  .object({
    host: z.string().min(1),
    owner: z.string().min(1),
    name: z.string().min(1),
  })
  .strict()
  .readonly();
export type RepositoryIdentity = z.infer<typeof RepositoryIdentity>;

export const LocalRepositoryIdentity = z
  .object({ kind: z.literal('local'), rootCommitDigest: Sha256Digest })
  .strict()
  .readonly();
export type LocalRepositoryIdentity = z.infer<typeof LocalRepositoryIdentity>;

export const ReviewRepositoryIdentity = z.union([RepositoryIdentity, LocalRepositoryIdentity]);
export type ReviewRepositoryIdentity = z.infer<typeof ReviewRepositoryIdentity>;

const PullRequestSource = z
  .object({
    kind: z.literal('pull_request'),
    pullRequestNumber: z.number().int().positive(),
  })
  .strict()
  .readonly();

const BranchSource = z
  .object({
    kind: z.literal('branch'),
    branch: z.string().min(1),
    requestedBase: z.string().min(1).optional(),
  })
  .strict()
  .readonly();

const RepositorySubjectSource = z.discriminatedUnion('kind', [PullRequestSource, BranchSource]);

const InlineContentSource = z
  .object({ kind: z.literal('inline'), mediaType: z.enum(['text', 'diff', 'patch']) })
  .strict()
  .readonly();

const UrlContentSource = z
  .object({ kind: z.literal('url'), url: SafeReviewUrlMetadata })
  .strict()
  .readonly();

const ContentSubjectSource = z.discriminatedUnion('kind', [InlineContentSource, UrlContentSource]);

export const FrozenReviewSubject = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('repository_change'),
        source: RepositorySubjectSource,
        baseRepository: ReviewRepositoryIdentity,
        headRepository: ReviewRepositoryIdentity.optional(),
        baseSha: GitSha,
        headSha: GitSha,
        changedPaths: z.array(RepositoryPathSchema).min(1).readonly(),
        materialDigest: Sha256Digest,
        subjectDigest: Sha256Digest,
      })
      .strict()
      .readonly(),
    z
      .object({
        kind: z.literal('content'),
        source: ContentSubjectSource,
        materialDigest: Sha256Digest,
        subjectDigest: Sha256Digest,
        lineCount: z.number().int().nonnegative(),
      })
      .strict()
      .readonly(),
  ])
  .readonly();
export type FrozenReviewSubject = z.infer<typeof FrozenReviewSubject>;

export const ReviewSubjectScope = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('repository_change'),
      paths: z.array(RepositoryPathSchema).min(1).readonly(),
      revisions: z
        .array(z.enum(['base', 'head']))
        .min(1)
        .readonly(),
    })
    .readonly(),
  z
    .object({
      kind: z.literal('content'),
      subjectDigest: z.string().min(1),
      lineCount: z.number().int().nonnegative(),
    })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.literal('artifact'),
      artifact: z
        .object({
          kind: z.enum(['plan', 'adr']),
          digest: z.string().min(1),
          sectionPaths: z.array(MarkdownSectionPath).min(1).readonly(),
        })
        .readonly(),
    })
    .readonly(),
  z
    .object({
      kind: z.literal('implementation'),
      implementationDigest: z.string().min(1),
    })
    .strict()
    .readonly(),
  z.object({ kind: z.literal('unavailable'), reason: z.string().min(1) }).readonly(),
]);
export type ReviewSubjectScope = z.infer<typeof ReviewSubjectScope>;
