/**
 * @module git
 * @description Git subprocess adapter -- thin wrapper around git CLI commands.
 *
 * Provides the git operations the FlowGuard system needs:
 * - Worktree root detection (resolveRoot)
 * - Changed file discovery (changedFiles, diffFiles)
 * - Branch info (currentBranch)
 * - Worktree cleanliness check (isClean)
 * - Remote origin URL retrieval (remoteOriginUrl)
 *
 * Design:
 * - Uses child_process.execFile (no shell invocation -- zero injection risk)
 * - Typed errors (GitError with codes)
 * - Timeout protection (5 seconds per command, configurable)
 * - Path normalization (git outputs forward slashes, we normalize to OS convention)
 * - All returned file paths are relative to worktree root
 * - windowsHide: true (suppress console window on Windows)
 *
 * Security:
 * - execFile with argument array (never string concatenation)
 * - No user input interpolated into shell commands
 * - Timeout prevents runaway git processes (e.g., on very large repos)
 *
 * @version v1
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import { isEnoent } from './persistence.js';
import { getAdapterLogger } from '../logging/adapter-logger.js';

/** Deduplicated warn: uses warnOnce if available, falls back to warn. */
function logWarn(service: string, message: string, extra?: Record<string, unknown>): void {
  const log = getAdapterLogger();
  if (log.warnOnce) {
    log.warnOnce(service, message, extra);
  } else {
    log.warn(service, message, extra);
  }
}

const execFileAsync = promisify(execFile);

// -- Constants ----------------------------------------------------------------

/** Default timeout for git commands (ms). 5 seconds is generous for local ops. */
const GIT_TIMEOUT_MS = 5_000;

/** Known package/dependency manifest filenames. */
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
  '*.csproj',
  '*.sln',
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

// -- Error --------------------------------------------------------------------

/**
 * Typed git error.
 * Codes:
 * - GIT_NOT_FOUND: git executable not in PATH
 * - GIT_TIMEOUT: command exceeded timeout
 * - GIT_COMMAND_FAILED: git returned non-zero exit code
 * - NOT_GIT_REPO: directory is not inside a git repository
 */
/**
 * Typed git error codes.
 * Compile-time validated — no arbitrary strings allowed.
 */
export type GitErrorCode = 'GIT_NOT_FOUND' | 'GIT_TIMEOUT' | 'GIT_COMMAND_FAILED' | 'NOT_GIT_REPO';

export class GitError extends Error {
  readonly code: GitErrorCode;

  constructor(code: GitErrorCode, message: string) {
    super(message);
    this.name = 'GitError';
    this.code = code;
  }
}

// -- Internals ----------------------------------------------------------------

/**
 * Execute a git command in the given working directory.
 * Returns trimmed stdout on success.
 * Throws GitError on any failure.
 *
 * @param cwd - Working directory for the git command.
 * @param args - Git subcommand and arguments (e.g., ["status", "--porcelain"]).
 * @param timeoutMs - Optional timeout override.
 */
async function gitRaw(
  cwd: string,
  args: string[],
  timeoutMs: number = GIT_TIMEOUT_MS,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: timeoutMs,
      windowsHide: true,
      // maxBuffer: 10MB -- sufficient for large repos with many files
      maxBuffer: 10 * 1024 * 1024,
    });
    // NOTE: raw stdout, NOT trimmed. Callers that parse fixed-width or
    // NUL-delimited output (e.g. `--porcelain -z`) MUST NOT receive a
    // whole-blob-trimmed string: trimming strips the leading status column of
    // the first porcelain line (e.g. " M src/...") which then shifts every
    // fixed-offset slice and corrupts the first path (src -> rc). See
    // parsePorcelainZ. Use `git()` (trimmed) only for single-value commands.
    return stdout;
  } catch (err: unknown) {
    if (isEnoent(err)) {
      getAdapterLogger().error('git', 'git executable not found in PATH');
      throw new GitError(
        'GIT_NOT_FOUND',
        'git executable not found in PATH. Ensure git is installed.',
      );
    }
    if (isTimedOut(err)) {
      getAdapterLogger().error('git', `git ${args[0]} timed out`, {
        args,
        timeoutMs,
        cwd,
      });
      throw new GitError('GIT_TIMEOUT', `git ${args[0]} timed out after ${timeoutMs}ms`);
    }
    // Extract stderr for diagnostics
    const stderr =
      typeof err === 'object' && err !== null && 'stderr' in err
        ? String((err as { stderr: unknown }).stderr).trim()
        : '';
    const msg = stderr || (err instanceof Error ? err.message : String(err));
    getAdapterLogger().error('git', `git ${args.join(' ')} failed`, {
      args,
      cwd,
      stderr: stderr || undefined,
    });
    throw new GitError('GIT_COMMAND_FAILED', `git ${args.join(' ')} failed: ${msg}`);
  }
}

/**
 * Trimmed git invocation -- for single-value commands (rev-parse, symbolic-ref,
 * config) where surrounding whitespace is noise. NEVER use for parsing
 * multi-record porcelain/diff output; use {@link gitRaw} + a dedicated parser.
 */
async function git(
  cwd: string,
  args: string[],
  timeoutMs: number = GIT_TIMEOUT_MS,
): Promise<string> {
  return (await gitRaw(cwd, args, timeoutMs)).trim();
}

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

// -- Public API ---------------------------------------------------------------

/**
 * Resolve the git worktree root from any subdirectory.
 *
 * @param dir - Any directory inside a git repository.
 * @returns Absolute, OS-normalized path to the worktree root.
 * @throws GitError if not inside a git repository.
 */
export async function resolveRoot(dir: string): Promise<string> {
  try {
    const root = await git(dir, ['rev-parse', '--show-toplevel']);
    // git always outputs forward slashes; normalize for the OS
    return path.normalize(root);
  } catch (err) {
    if (err instanceof GitError && err.code === 'GIT_COMMAND_FAILED') {
      throw new GitError('NOT_GIT_REPO', `Directory is not inside a git repository: ${dir}`);
    }
    throw err;
  }
}

/**
 * Check if a directory is inside a git repository.
 * Non-throwing convenience wrapper around resolveRoot.
 */
export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await git(dir, ['rev-parse', '--is-inside-work-tree']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the current branch name.
 *
 * @returns Branch name, or null for detached HEAD.
 */
export async function currentBranch(worktree: string): Promise<string | null> {
  try {
    const branch = await git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']);
    // Detached HEAD returns literal "HEAD"
    return branch === 'HEAD' ? null : branch;
  } catch {
    logWarn('git', 'Failed to resolve current branch', { worktree });
    return null;
  }
}

/**
 * Check if the worktree is clean (no staged, unstaged, or untracked changes).
 * Useful for pre-implementation baseline checks.
 */
export async function isClean(worktree: string): Promise<boolean> {
  const status = await git(worktree, ['status', '--porcelain']);
  return status === '';
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
 * Get the current HEAD commit hash (short form).
 * Returns null if no commits exist.
 */
export async function headCommit(worktree: string): Promise<string | null> {
  try {
    return await git(worktree, ['rev-parse', '--short', 'HEAD']);
  } catch {
    logWarn('git', 'Failed to resolve HEAD commit', { worktree });
    return null;
  }
}

/**
 * Get the default branch name for the repository.
 *
 * Strategy:
 * 1. Try `git symbolic-ref refs/remotes/origin/HEAD` (set after clone)
 * 2. Fall back to null if no remote HEAD is configured
 *
 * Returns the branch name only (e.g., "main"), not the full ref.
 * Returns null if the default branch cannot be determined.
 */
export async function defaultBranch(worktree: string): Promise<string | null> {
  try {
    const ref = await git(worktree, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
    // ref is "refs/remotes/origin/main" — extract last segment
    const parts = ref.split('/');
    return parts[parts.length - 1] || null;
  } catch {
    logWarn('git', 'Failed to resolve default branch', { worktree });
    return null;
  }
}

/**
 * Get the remote "origin" URL for the repository.
 *
 * Returns null if:
 * - No remote named "origin" exists
 * - The directory is not a git repository
 * - Git is not available
 *
 * Used by the workspace registry to derive the canonical repository fingerprint.
 */
export async function remoteOriginUrl(worktree: string): Promise<string | null> {
  try {
    const url = await git(worktree, ['remote', 'get-url', 'origin']);
    return url || null;
  } catch {
    logWarn('git', 'Failed to resolve remote origin URL', { worktree });
    return null;
  }
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

// ─── Actor Identity Helpers ──────────────────────────────────────────────────

/**
 * Read `git config user.name` for actor resolution.
 * Returns null on any failure (not a repo, no config, git not found).
 * Non-fatal — actor resolution falls through to 'unknown'.
 */
export async function gitUserName(cwd: string): Promise<string | null> {
  try {
    const name = await git(cwd, ['config', 'user.name']);
    return name || null;
  } catch {
    logWarn('git', 'Failed to read git user.name', { cwd });
    return null;
  }
}

/**
 * Read `git config user.email` for actor resolution.
 * Returns null on any failure (not a repo, no config, git not found).
 * Non-fatal — email is optional for ActorInfo.
 */
export async function gitUserEmail(cwd: string): Promise<string | null> {
  try {
    const email = await git(cwd, ['config', 'user.email']);
    return email || null;
  } catch {
    logWarn('git', 'Failed to read git user.email', { cwd });
    return null;
  }
}

// -- Internals ----------------------------------------------------------------

/** Type-safe timeout check (process killed). */
function isTimedOut(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'killed' in err &&
    (err as { killed: unknown }).killed === true
  );
}
