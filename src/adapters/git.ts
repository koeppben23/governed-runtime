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

const execFileAsync = promisify(execFile);

// -- Constants ----------------------------------------------------------------

/** Default timeout for git commands (ms). 5 seconds is generous for local ops. */
const GIT_TIMEOUT_MS = 5_000;

// -- Error --------------------------------------------------------------------

/**
 * Typed git error.
 * Codes:
 * - GIT_NOT_FOUND: git executable not in PATH
 * - GIT_TIMEOUT: command exceeded timeout
 * - GIT_COMMAND_FAILED: git returned non-zero exit code
 * - NOT_GIT_REPO: directory is not inside a git repository
 */
export class GitError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
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
async function git(
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
    return stdout.trim();
  } catch (err: unknown) {
    if (isEnoent(err)) {
      throw new GitError(
        'GIT_NOT_FOUND',
        'git executable not found in PATH. Ensure git is installed.',
      );
    }
    if (isTimedOut(err)) {
      throw new GitError('GIT_TIMEOUT', `git ${args[0]} timed out after ${timeoutMs}ms`);
    }
    // Extract stderr for diagnostics
    const stderr =
      typeof err === 'object' && err !== null && 'stderr' in err
        ? String((err as { stderr: unknown }).stderr).trim()
        : '';
    const msg = stderr || (err instanceof Error ? err.message : String(err));
    throw new GitError('GIT_COMMAND_FAILED', `git ${args.join(' ')} failed: ${msg}`);
  }
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
 * Porcelain format: "XY filename" where XY is the two-character status.
 * For renames: "XY old -> new" -- we include BOTH paths.
 */
export async function changedFiles(worktree: string): Promise<string[]> {
  const status = await git(worktree, ['status', '--porcelain']);
  if (!status) return [];

  const files = new Set<string>();

  for (const line of status.split('\n')) {
    if (!line || line.length < 4) continue;

    // Status is characters 0-1, space at 2, filename starts at 3
    const entry = line.slice(3);

    // Handle renames: "old -> new"
    const arrowIdx = entry.indexOf(' -> ');
    if (arrowIdx !== -1) {
      files.add(path.normalize(entry.slice(0, arrowIdx)));
      files.add(path.normalize(entry.slice(arrowIdx + 4)));
    } else {
      files.add(path.normalize(entry));
    }
  }

  return [...files].sort();
}

/**
 * Get the current HEAD commit hash (short form).
 * Returns null if no commits exist.
 */
export async function headCommit(worktree: string): Promise<string | null> {
  try {
    return await git(worktree, ['rev-parse', '--short', 'HEAD']);
  } catch {
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
}> {
  /** Known package/dependency manifest filenames. */
  const PACKAGE_FILES = new Set([
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
  const CONFIG_FILES = new Set([
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
      const status = await git(worktree, ['status', '--porcelain']);
      if (status) {
        allFiles = status
          .split('\n')
          .filter((line) => line && line.length >= 4)
          .map((line) => line.slice(3).trim());
      }
    } catch {
      // No git at all — return empty signals
    }
  }

  // Normalize paths
  allFiles = allFiles.map((f) => path.normalize(f));

  // Categorize by basename
  const packageFiles: string[] = [];
  const configFiles: string[] = [];

  for (const filePath of allFiles) {
    const basename = path.basename(filePath);
    if (PACKAGE_FILES.has(basename)) {
      packageFiles.push(basename);
    } else if (basename.endsWith('.csproj') || basename.endsWith('.sln')) {
      packageFiles.push(basename);
    }
    if (CONFIG_FILES.has(basename)) {
      configFiles.push(basename);
    }
  }

  return {
    files: allFiles,
    packageFiles: [...new Set(packageFiles)],
    configFiles: [...new Set(configFiles)],
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
