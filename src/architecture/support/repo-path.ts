/**
 * @module architecture/repo-path
 * @description Single path-normalization authority for architecture guards.
 *
 * Every architecture guard that derives a logical repository path from a real
 * filesystem path MUST route through these helpers before classification,
 * allowlist, prefix, or `__tests__` checks. The canonical logical form always
 * uses `/` separators, so `path.relative()` output is normalized on Windows as
 * well as POSIX.
 *
 * `replaceAll('\\', '/')` is deliberate: the helper must also canonicalize a
 * synthetic Windows path on a POSIX host, which `split(sep).join('/')` cannot
 * do because `sep` is host-specific.
 *
 * @version v1
 */

import { relative } from 'node:path';

/** Convert a path-like string to the canonical repo-path separator form. */
export function normalizeRepoPath(value: string): string {
  return value.replaceAll('\\', '/');
}

/** Convert a filesystem path to a canonical path relative to `root`. */
export function repoRelative(root: string, file: string): string {
  return normalizeRepoPath(relative(root, file));
}
