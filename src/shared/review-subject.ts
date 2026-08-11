/** Canonical subject-material normalization and digest construction. */

import { canonicalJsonStringify } from './canonical-json.js';
import { hashText } from './hashing.js';

export function normalizeReviewContent(content: string): string {
  return content.replace(/\r\n?/g, '\n');
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
  readonly baseRepository: { readonly host: string; readonly owner: string; readonly name: string };
  readonly headRepository?: {
    readonly host: string;
    readonly owner: string;
    readonly name: string;
  };
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
