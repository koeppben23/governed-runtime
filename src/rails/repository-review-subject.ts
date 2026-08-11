/** Repository-change review subject materialization from canonical adapter changes. */

import type { FrozenReviewSubject } from '../state/evidence.js';
import { blocked } from '../config/reasons.js';
import type { RailBlocked } from './types.js';
import {
  filterRepositoryChanges,
  parseCanonicalRepositoryChanges,
  projectRepositoryReviewerMaterial,
  repositoryChangePaths,
} from '../adapters/repository-change.js';
import {
  hashCanonicalRepositorySubject,
  hashCanonicalReviewContent,
  normalizeReviewContent,
} from '../shared/review-subject.js';

export interface ResolvedRepositorySubjectInput {
  readonly source:
    | { readonly kind: 'pull_request'; readonly pullRequestNumber: number }
    | { readonly kind: 'branch'; readonly branch: string; readonly requestedBase?: string };
  readonly baseRepository?: {
    readonly host: string;
    readonly owner: string;
    readonly name: string;
  };
  readonly headRepository?: {
    readonly host: string;
    readonly owner: string;
    readonly name: string;
  };
  readonly baseSha: string;
  readonly headSha: string;
}

export function prepareResolvedRepositoryContent(
  content: string,
  source: ResolvedRepositorySubjectInput,
  targetPaths?: readonly string[],
):
  | {
      readonly content: string;
      readonly reviewedContentDigest: string;
      readonly reviewSubject: FrozenReviewSubject;
    }
  | RailBlocked {
  const canonicalChanges = parseCanonicalRepositoryChanges(normalizeReviewContent(content));
  if (!canonicalChanges) {
    return blocked('COMMAND_BLOCKED', {
      command: '/review',
      reason: 'Resolved repository diff could not be parsed into canonical repository changes.',
    });
  }
  const filteredChanges = filterRepositoryChanges(canonicalChanges, targetPaths);
  if (!filteredChanges) {
    return blocked('COMMAND_BLOCKED', {
      command: '/review',
      reason:
        'targetPaths must be non-empty repository paths present in the resolved repository diff.',
    });
  }
  const reviewerMaterial = projectRepositoryReviewerMaterial(filteredChanges);
  const materialDigest = hashCanonicalReviewContent(reviewerMaterial);
  const changedPaths = repositoryChangePaths(filteredChanges);
  if (changedPaths.length === 0) {
    return blocked('COMMAND_BLOCKED', {
      command: '/review',
      reason: 'Resolved repository diff contains no repository paths.',
    });
  }
  const reviewSubject: FrozenReviewSubject = {
    kind: 'repository_change',
    source: source.source,
    ...(source.baseRepository && { baseRepository: source.baseRepository }),
    ...(source.headRepository && { headRepository: source.headRepository }),
    baseSha: source.baseSha,
    headSha: source.headSha,
    changedPaths,
    materialDigest,
    subjectDigest: hashCanonicalRepositorySubject({
      baseRepository: source.baseRepository,
      headRepository: source.headRepository,
      baseSha: source.baseSha,
      headSha: source.headSha,
      changedPaths,
      materialDigest,
    }),
  };
  return { content: reviewerMaterial, reviewedContentDigest: materialDigest, reviewSubject };
}
