/**
 * @module adapters/git-changes
 * @description Worktree change discovery: porcelain parsing, changed files,
 * unified diffs, blob hashing, and repository signal gathering.
 *
 * All returned file paths are relative to the worktree root and OS-normalized.
 *
 * @version v1
 */

import * as path from 'node:path';
import { git, gitRaw } from './git-command.js';

/**
 * Known package/dependency manifest basenames — exact matches.
 * `.csproj` / `.sln` are suffix-based manifest families and are handled by the
 * explicit `basename.endsWith(...)` check in the classifier below.
 */
const PACKAGE_FILES: ReadonlySet<string> = new Set([
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'package.json',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'setup.py',
  'requirements.txt',
  'Gemfile',
  'composer.json',
]);

/** Known config filenames (exact match on basename). */
const CONFIG_FILES: ReadonlySet<string> = new Set([
  'tsconfig.json',
  'angular.json',
  'nx.json',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.json',
  '.eslintrc.yml',
  'eslint.config.js',
  'eslint.config.mjs',
  '.prettierrc',
  '.prettierrc.json',
  'Dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'jest.config.js',
  'jest.config.ts',
  'vitest.config.ts',
  'vitest.config.js',
  'webpack.config.js',
  'vite.config.ts',
  'vite.config.js',
  'rollup.config.js',
  'tailwind.config.js',
  'tailwind.config.ts',
  'next.config.js',
  'next.config.mjs',
  'nuxt.config.ts',
]);

/**
 * Parse `git status --porcelain=v1 -z` output into a list of changed paths.
 *
 * Why `-z`: the default (newline) porcelain format C-quotes paths containing
 * spaces or special characters and wraps them in double quotes, and the shared
 * trimming wrapper de-indents the first record's blank status column. Both
 * corrupt fixed-offset parsing. The `-z` format is unambiguous: records are
 * NUL-separated, paths are emitted verbatim (no quoting/escaping), and there is
 * no leading/trailing whitespace to trim.
 *
 * Record layout (`-z`): each entry is `XY<space>path` where `X`/`Y` are the
 * index/worktree status codes (either may be a literal space). For a rename or
 * copy (`R`/`C` in either column) the NEW path is in this record and the OLD
 * path follows as the very next NUL-separated field (with NO status prefix and
 * NO ` -> ` arrow -- that arrow only exists in the non-`-z` format).
 *
 * @returns OS-normalized paths (both sides of a rename included), unsorted.
 */
export function parsePorcelainZ(raw: string): string[] {
  const out: string[] = [];
  // Records are NUL-separated; -z has no trailing newline. Drop empty trailers.
  const fields = raw.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (!field) continue;
    // A status record is at least "XY path" => >= 4 chars (XY + space + 1).
    if (field.length < 4) continue;
    const index = field[0];
    const worktree = field[1];
    const isRenameOrCopy = index === 'R' || index === 'C' || worktree === 'R' || worktree === 'C';
    // Path begins after the 2-char status and its separating space (index 3).
    const newPath = field.slice(3);
    out.push(path.normalize(newPath));
    if (isRenameOrCopy) {
      // The old path is the next NUL-separated field, emitted bare.
      const oldPath = fields[i + 1];
      if (oldPath) {
        out.push(path.normalize(oldPath));
      }
      i++; // consume the old-path field
    }
  }
  return out;
}

/**
 * Discover all changed files in the worktree.
 *
 * Uses `git status --porcelain` which reliably handles all edge cases:
 * - Staged changes (A, M, D, R)
 * - Unstaged changes (M, D)
 * - Untracked files (??)
 * - Empty/initial repositories (no commits yet)
 *
 * @returns Sorted array of file paths relative to worktree root, OS-normalized.
 *
 * Uses `--porcelain=v1 -z` (NUL-delimited, no path quoting/escaping) parsed by
 * {@link parsePorcelainZ}. This avoids the first-path corruption that the
 * whitespace-trimmed, fixed-offset newline parser produced for worktree-only
 * changes (e.g. " M src/..." -> "rc/...").
 */
export async function changedFiles(worktree: string): Promise<string[]> {
  const status = await gitRaw(worktree, ['status', '--porcelain=v1', '-z']);
  if (!status) return [];

  const files = new Set<string>(parsePorcelainZ(status));
  return [...files].sort();
}

/**
 * Produce a unified diff of the given worktree paths against HEAD.
 *
 * Captures the ACTUAL content change for implementation evidence (not just the file
 * names). Tracked changes (staged + unstaged) are rendered by `git diff HEAD`. This
 * is NON-MUTATING: it never stages files (no `git add`). New/untracked files are not
 * expanded into the patch here — their content is still bound by the evidence content
 * digest (see {@link hashWorktreeFiles}); only their human-readable body is omitted.
 *
 * Fails soft: returns an empty string when there is no HEAD (fresh repo) or the diff
 * cannot be produced, so evidence recording never hard-fails on diff capture.
 *
 * @param worktree repository worktree root.
 * @param paths worktree-relative paths to include (already OS-normalized).
 * @returns a unified-diff string (possibly empty).
 */
export async function worktreeDiff(worktree: string, paths: readonly string[]): Promise<string> {
  if (paths.length === 0) return '';
  try {
    return await gitRaw(worktree, ['diff', '--no-color', 'HEAD', '--', ...paths]);
  } catch {
    // No HEAD yet (initial repo) or path error — fall back to a plain worktree diff.
    try {
      return await gitRaw(worktree, ['diff', '--no-color', '--', ...paths]);
    } catch {
      return '';
    }
  }
}

/**
 * Compute the git blob hash of each given worktree path's CURRENT content.
 *
 * Uses `git hash-object` (the same content addressing git uses for blobs), so
 * the hash changes iff the file content changes. Used to capture a
 * pre-implementation baseline: a file that was already dirty at session start
 * is only scoped out of implementation evidence if its hash is unchanged (i.e.
 * the task did not touch it). A deleted or unreadable path maps to null.
 *
 * Fast path: a single batched `git hash-object -- <paths...>` call (one
 * subprocess, output is one hash per line in input order). If the batch fails
 * (e.g. a deleted path makes git abort), fall back to per-path hashing so one
 * unreadable/deleted file does not lose the hashes of the others.
 *
 * @returns Map of input path -> blob hash, or null when the path could not be hashed.
 */
export async function hashWorktreeFiles(
  worktree: string,
  paths: readonly string[],
): Promise<Record<string, string | null>> {
  if (paths.length === 0) return {};
  // Fast path: one subprocess for all paths.
  try {
    const raw = await gitRaw(worktree, ['hash-object', '--', ...paths]);
    const lines = raw.split('\n').filter((l) => l.length > 0);
    if (lines.length === paths.length) {
      const out: Record<string, string | null> = {};
      paths.forEach((p, i) => {
        out[p] = lines[i] ?? null;
      });
      return out;
    }
    // Line count mismatch — fall through to robust per-path hashing.
  } catch {
    // Batch aborted (e.g. a deleted path) — fall through.
  }
  const out: Record<string, string | null> = {};
  for (const p of paths) {
    try {
      // `--` guards against paths that look like options. hash-object reads the
      // working-tree file content (not the index/HEAD).
      out[p] = await git(worktree, ['hash-object', '--', p]);
    } catch {
      out[p] = null; // deleted, untracked-removed, or unreadable
    }
  }
  return out;
}

/**
 * Gather repository file signals for profile auto-detection.
 *
 * Lists all tracked and untracked files in the worktree, then categorizes them:
 * - packageFiles: build/dependency manifest files (pom.xml, package.json, build.gradle, etc.)
 * - configFiles: configuration and tool config files (tsconfig.json, angular.json, etc.)
 * - files: all file paths (relative to worktree root)
 *
 * Uses `git ls-files` for tracked files and `git ls-files --others --exclude-standard`
 * for untracked files.
 *
 * Performance: On very large repos, this returns all root-level relevant files.
 * The profile detect() functions only check for specific filenames, so even
 * large arrays are fast (linear scan with early exit).
 */
export async function listRepoSignals(worktree: string): Promise<{
  files: string[];
  packageFiles: string[];
  configFiles: string[];
  packageFilePaths: string[];
  configFilePaths: string[];
}> {
  let allFiles: string[] = [];

  try {
    // Tracked files
    const tracked = await git(worktree, ['ls-files']);
    if (tracked) {
      allFiles = tracked.split('\n').filter((f) => f.trim());
    }
  } catch {
    // No commits yet or not a git repo — try status-based fallback
    try {
      const status = await gitRaw(worktree, ['status', '--porcelain=v1', '-z']);
      if (status) {
        allFiles = parsePorcelainZ(status);
      }
    } catch {
      // No git at all — return empty signals
    }
  }

  // Normalize paths
  allFiles = allFiles.map((f) => path.normalize(f));

  // Categorize by basename (basenames for backward compat, full paths for new consumers)
  const packageFiles: string[] = [];
  const configFiles: string[] = [];
  const packageFilePaths: string[] = [];
  const configFilePaths: string[] = [];

  for (const filePath of allFiles) {
    const basename = path.basename(filePath);
    if (PACKAGE_FILES.has(basename)) {
      packageFiles.push(basename);
      packageFilePaths.push(filePath);
    } else if (basename.endsWith('.csproj') || basename.endsWith('.sln')) {
      packageFiles.push(basename);
      packageFilePaths.push(filePath);
    }
    if (CONFIG_FILES.has(basename)) {
      configFiles.push(basename);
      configFilePaths.push(filePath);
    }
  }

  return {
    files: allFiles,
    packageFiles: [...new Set(packageFiles)],
    configFiles: [...new Set(configFiles)],
    packageFilePaths,
    configFilePaths,
  };
}
