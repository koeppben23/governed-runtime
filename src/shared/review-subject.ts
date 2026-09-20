/** Canonical subject-material normalization and digest construction. */

import { canonicalJsonStringify } from './canonical-json.js';

/**
 * Structural port for repository identity values consumed by shared digest
 * construction. The canonical schema authority stays in state/; shared must not
 * import state, so this port only mirrors the value shape. The assignability of
 * the state authority to this port is pinned at compile time outside shared
 * (`shared/review-subject.test.ts`).
 */
export type ReviewRepositoryIdentityValue =
  | Readonly<{ host: string; owner: string; name: string }>
  | Readonly<{ kind: 'local'; rootCommitDigest: string }>;
import { hashText } from './hashing.js';

export function normalizeReviewContent(content: string): string {
  return content.replace(/\r\n?/g, '\n');
}

/** Digest the normalized bytes that are persisted as peer review material. */
export function hashCanonicalReviewContent(content: string): string {
  return hashText(normalizeReviewContent(content));
}

export function reviewContentLineCount(content: string): number {
  if (content === '') return 0;
  return content.endsWith('\n')
    ? content.slice(0, -1).split('\n').length
    : content.split('\n').length;
}

export function hashCanonicalContentSubject(materialDigest: string): string {
  return hashText(canonicalJsonStringify({ version: 1, kind: 'content', materialDigest }));
}

export function hashCanonicalRepositorySubject(input: {
  readonly baseRepository: ReviewRepositoryIdentityValue;
  readonly headRepository?: ReviewRepositoryIdentityValue;
  readonly baseSha: string;
  readonly headSha: string;
  readonly changedPaths: readonly string[];
  readonly materialDigest: string;
}): string {
  return hashText(
    canonicalJsonStringify({
      version: 1,
      kind: 'repository_change',
      ...input,
      changedPaths: [...new Set(input.changedPaths)].sort(),
    }),
  );
}
