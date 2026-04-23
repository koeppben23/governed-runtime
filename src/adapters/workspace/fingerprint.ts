/**
 * @module workspace/fingerprint
 * @description URL canonicalization, path normalization, and fingerprint computation.
 *
 * Fingerprint algorithm (matches reference implementation):
 * - Remote canonical: SHA-256("repo:" + canonicalize(remoteUrl))[:24]
 * - Local path fallback: SHA-256("repo:local:" + normalize(worktreePath))[:24]
 *
 * @version v1
 */

import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { remoteOriginUrl } from '../git.js';

import { FINGERPRINT_LENGTH, type FingerprintResult } from './types.js';

// -- URL Canonicalization -----------------------------------------------------

/**
 * Canonicalize a git remote URL for stable fingerprint derivation.
 *
 * Algorithm (matches reference implementation):
 * 1. Convert SCP-style URLs (git@host:path) to ssh://git@host/path
 * 2. Parse via URL
 * 3. Casefold hostname (include port if non-default)
 * 4. Normalize path: replace backslashes, collapse slashes, strip .git, casefold
 * 5. Return canonical form: repo://<host><path>
 *
 * @param rawUrl - Raw remote URL from git (HTTPS, SSH, SCP-style, etc.)
 * @returns Canonical URL in the form "repo://<host><path>"
 */
export function canonicalizeOriginUrl(rawUrl: string): string {
  let url = rawUrl.trim();

  // SCP-style: git@github.com:org/repo.git → ssh://git@github.com/org/repo.git
  const scpMatch = url.match(/^([A-Za-z0-9._-]+@)?([A-Za-z0-9._-]+):(.+)$/);
  if (scpMatch && !url.includes('://')) {
    const user = scpMatch[1] ?? '';
    const host = scpMatch[2];
    const repoPath = scpMatch[3];
    url = `ssh://${user}${host}/${repoPath}`;
  }

  let hostname: string;
  let pathname: string;

  try {
    const parsed = new URL(url);
    // Casefold hostname; include port if present and non-default
    hostname = parsed.hostname.toLowerCase();
    if (parsed.port) {
      hostname += `:${parsed.port}`;
    }
    pathname = parsed.pathname;
  } catch {
    // Unparseable URL — use as-is with basic normalization
    hostname = '';
    pathname = url;
  }

  // Normalize path: replace backslashes, collapse multiple slashes
  pathname = pathname.replace(/\\/g, '/').replace(/\/+/g, '/');

  // Strip trailing slash (but keep leading /) — must happen before .git strip
  // so that "repo.git/" becomes "repo.git" which then becomes "repo"
  if (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }

  // Strip trailing .git suffix
  if (pathname.endsWith('.git')) {
    pathname = pathname.slice(0, -4);
  }

  // Strip any trailing slash left after .git removal (e.g. "/org/.git" → "/org/")
  if (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }

  // Ensure leading slash
  if (!pathname.startsWith('/')) {
    pathname = '/' + pathname;
  }

  // Casefold path for case-insensitive matching
  pathname = pathname.toLowerCase();

  return `repo://${hostname}${pathname}`;
}

// -- Path Normalization -------------------------------------------------------

/**
 * Normalize a filesystem path for deterministic fingerprint derivation.
 *
 * Algorithm (matches reference implementation):
 * 1. Resolve to absolute path
 * 2. Normalize (collapse .., remove redundant separators)
 * 3. Replace backslashes with forward slashes
 * 4. Casefold on Windows (case-insensitive filesystem)
 *
 * @param absPath - Absolute path to normalize.
 * @returns Normalized path string suitable for hashing.
 */
export function normalizeForFingerprint(absPath: string): string {
  let normalized = path.resolve(absPath);
  normalized = path.normalize(normalized);
  normalized = normalized.replace(/\\/g, '/');
  if (process.platform === 'win32') {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}

// -- Fingerprint Computation --------------------------------------------------

/**
 * Compute the deterministic repository fingerprint.
 *
 * Two derivation paths:
 * 1. Remote canonical (preferred): SHA-256("repo:" + canonicalize(remoteUrl))[:24]
 * 2. Local path fallback: SHA-256("repo:local:" + normalize(worktreePath))[:24]
 *
 * The fingerprint is stable across:
 * - Different clones of the same remote (same fingerprint)
 * - Worktree path changes (if remote exists)
 * - OS normalization differences (casefolding, separators)
 *
 * @param worktree - Git worktree root path.
 * @returns FingerprintResult with fingerprint, material class, and derivation metadata.
 */
export async function computeFingerprint(worktree: string): Promise<FingerprintResult> {
  const remote = await remoteOriginUrl(worktree);

  if (remote) {
    const canonical = canonicalizeOriginUrl(remote);
    const material = `repo:${canonical}`;
    const fingerprint = crypto
      .createHash('sha256')
      .update(material, 'utf-8')
      .digest('hex')
      .slice(0, FINGERPRINT_LENGTH);
    return {
      fingerprint,
      materialClass: 'remote_canonical',
      canonicalRemote: canonical,
      normalizedRoot: normalizeForFingerprint(worktree),
    };
  }

  // Fallback: no remote — use normalized local path
  const normalizedRoot = normalizeForFingerprint(worktree);
  const material = `repo:local:${normalizedRoot}`;
  const fingerprint = crypto
    .createHash('sha256')
    .update(material, 'utf-8')
    .digest('hex')
    .slice(0, FINGERPRINT_LENGTH);
  return {
    fingerprint,
    materialClass: 'local_path',
    canonicalRemote: null,
    normalizedRoot,
  };
}

/**
 * Compute fingerprint synchronously from a known canonical remote URL.
 * Used when the remote URL is already available (avoids async git call).
 */
export function computeFingerprintFromRemote(canonicalRemote: string): string {
  const material = `repo:${canonicalRemote}`;
  return crypto
    .createHash('sha256')
    .update(material, 'utf-8')
    .digest('hex')
    .slice(0, FINGERPRINT_LENGTH);
}

/**
 * Compute fingerprint synchronously from a normalized local path.
 * Used when there is no remote (fallback path).
 */
export function computeFingerprintFromPath(normalizedPath: string): string {
  const material = `repo:local:${normalizedPath}`;
  return crypto
    .createHash('sha256')
    .update(material, 'utf-8')
    .digest('hex')
    .slice(0, FINGERPRINT_LENGTH);
}
