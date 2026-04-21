/**
 * @module discovery/repo-paths
 * @description Path hygiene helpers for repo-relative signal paths.
 *
 * These helpers intentionally operate on repo-relative paths only.
 * Absolute paths are treated as non-root/non-signal for root-level checks.
 */

/**
 * Normalize a repo-signal path string for cross-platform root checks.
 *
 * Normalization rules:
 * - trim surrounding whitespace
 * - convert backslashes to forward slashes
 * - remove leading "./" segments (repeat-until-fixed)
 * - collapse duplicate slashes
 */
export function normalizeRepoSignalPath(filePath: string): string {
  let normalized = filePath.trim().replaceAll('\\', '/');

  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }

  normalized = normalized.replace(/\/+/g, '/');
  return normalized;
}

/**
 * Return true when a path is a valid root-level repo-relative signal path.
 *
 * Non-root/invalid examples:
 * - nested paths (contains "/")
 * - POSIX absolute (starts with "/")
 * - Windows absolute (e.g. "C:/...")
 * - empty/degenerate values
 */
export function isRootLevelRepoSignal(filePath: string): boolean {
  const normalized = normalizeRepoSignalPath(filePath);
  if (!normalized || normalized === '.' || normalized === '/') return false;
  if (normalized.startsWith('/')) return false;
  if (/^[a-zA-Z]:\//.test(normalized)) return false;
  return !normalized.includes('/');
}

/**
 * Return the root-level basename for a repo signal path, or null when nested/invalid.
 */
export function getRootBasename(filePath: string): string | null {
  if (!isRootLevelRepoSignal(filePath)) return null;
  const normalized = normalizeRepoSignalPath(filePath);
  return normalized.length > 0 ? normalized : null;
}
