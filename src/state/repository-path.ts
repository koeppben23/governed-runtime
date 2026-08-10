/**
 * @module repository-path
 * @description Repository-relative POSIX path classification and normalization.
 */

/** Structural result of repository-relative POSIX path classification. */
export type RepositoryPathClassification =
  | { readonly kind: 'valid'; readonly normalizedPath: string }
  | { readonly kind: 'escapes_repository' }
  | { readonly kind: 'invalid' };

/**
 * Classify a repository-relative POSIX path without allowing ambiguous forms.
 * An attempt to pop beyond the repository root is distinct from other invalid
 * input so enforcement can report path traversal without parsing schema errors.
 */
export function classifyRepositoryPath(value: string): RepositoryPathClassification {
  const path = value.trim();
  if (
    path.length === 0 ||
    path.startsWith('/') ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path) ||
    path.includes('\\') ||
    path.includes('\0')
  ) {
    return { kind: 'invalid' };
  }
  const resolved: string[] = [];
  for (const segment of path.split('/')) {
    if (segment.length === 0 || segment === '.') continue;
    if (segment === '..') {
      if (resolved.length === 0) return { kind: 'escapes_repository' };
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  return resolved.length > 0
    ? { kind: 'valid', normalizedPath: resolved.join('/') }
    : { kind: 'invalid' };
}

/** Normalize a valid repository-relative path, preserving the legacy API. */
export function normalizeRepositoryPath(value: string): string | undefined {
  const classification = classifyRepositoryPath(value);
  return classification.kind === 'valid' ? classification.normalizedPath : undefined;
}
