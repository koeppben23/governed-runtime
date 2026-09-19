/**
 * @module adapters/git-repo
 * @description Git repository detection and control-plane layout resolution.
 *
 * - resolveRoot: worktree root discovery with typed NOT_GIT_REPO mapping
 * - isGitRepo / isGitRepoStrict: repository probes with distinct failure semantics
 * - resolveGitControlPlanePaths: git-resolved $GIT_DIR/$GIT_COMMON_DIR layout
 *
 * @version v1
 */

import * as path from 'node:path';
import { git, GitError } from './git-command.js';

/**
 * Resolve the git worktree root from any subdirectory.
 *
 * Only the actual "not a git repository" git failure (stderr signature
 * `not a git repository`) is normalized to NOT_GIT_REPO. Every other git
 * failure — a corrupt repository, an invalid gitfile, a config error — keeps
 * its typed GIT_COMMAND_FAILED diagnosis so callers never mislabel an
 * infrastructure problem as a missing repository.
 *
 * @param dir - Any directory inside a git repository.
 * @returns Absolute, OS-normalized path to the worktree root.
 * @throws GitError NOT_GIT_REPO when outside a repository; typed code otherwise.
 */
export async function resolveRoot(dir: string): Promise<string> {
  try {
    const root = await git(dir, ['rev-parse', '--show-toplevel']);
    // git always outputs forward slashes; normalize for the OS
    return path.normalize(root);
  } catch (err) {
    if (
      err instanceof GitError &&
      err.code === 'GIT_COMMAND_FAILED' &&
      isNotRepoFailure(err.message)
    ) {
      throw new GitError('NOT_GIT_REPO', `Directory is not inside a git repository: ${dir}`);
    }
    throw err;
  }
}

/** git's stable stderr signature for operating outside a repository. */
function isNotRepoFailure(message: string): boolean {
  return /not a git repository/i.test(message);
}

/**
 * The git control-plane layout of a worktree, resolved by GIT ITSELF.
 */
export interface GitControlPlaneLayout {
  /** The worktree-private $GIT_DIR (a `.git/worktrees/<id>` dir for linked worktrees). */
  readonly gitDir: string;
  /** The common $GIT_COMMON_DIR (owns the shared config/hooks). */
  readonly commonDir: string;
  /** `--git-path HEAD` (worktree-private HEAD). */
  readonly headPath: string;
  /** `--git-path config` (the common config, per-worktree under worktreeConfig). */
  readonly configPath: string;
  /** `--git-path config.worktree` (exists only with extensions.worktreeConfig). */
  readonly worktreeConfigPath: string;
  /** `--git-path hooks` (the effective hook authority dir). */
  readonly hooksPath: string;
}

/**
 * Resolve the git control-plane layout for a worktree via
 * `git rev-parse --git-path ...` (#852).
 *
 * Never guess the layout manually: linked worktrees (`git worktree add`)
 * relocate HEAD/config/hooks between the private $GIT_DIR and the common
 * $GIT_COMMON_DIR, and `extensions.worktreeConfig` adds a per-worktree
 * `config.worktree`. Only git's own path resolution is authoritative.
 *
 * All returned paths are absolute (OS-normalized).
 *
 * @throws GitError with the typed diagnosis when the worktree is not a git
 *         repository or git cannot resolve the layout.
 */
export async function resolveGitControlPlanePaths(
  worktree: string,
): Promise<GitControlPlaneLayout> {
  const out = await git(worktree, [
    'rev-parse',
    '--git-dir',
    '--git-common-dir',
    '--git-path',
    'HEAD',
    '--git-path',
    'config',
    '--git-path',
    'config.worktree',
    '--git-path',
    'hooks',
  ]);
  const lines = out.split('\n').map((line) => line.trim());
  const [gitDir, commonDir, headPath, configPath, worktreeConfigPath, hooksPath] = lines;
  if (
    lines.length !== 6 ||
    lines.some((line) => line.length === 0) ||
    gitDir === undefined ||
    commonDir === undefined ||
    headPath === undefined ||
    configPath === undefined ||
    worktreeConfigPath === undefined ||
    hooksPath === undefined
  ) {
    throw new GitError(
      'GIT_COMMAND_FAILED',
      `git rev-parse returned an unexpected control-plane layout: "${out}"`,
    );
  }
  const resolve = (line: string) => path.resolve(worktree, line);
  return {
    gitDir: resolve(gitDir),
    commonDir: resolve(commonDir),
    headPath: resolve(headPath),
    configPath: resolve(configPath),
    worktreeConfigPath: resolve(worktreeConfigPath),
    hooksPath: resolve(hooksPath),
  };
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
 * Typed git-repository probe for fail-closed lifecycle gates.
 *
 * Unlike {@link isGitRepo} — which collapses EVERY failure (missing git
 * executable, timeout, command failure) into `false` — this probe preserves
 * the typed diagnosis:
 *
 * - a directory that is genuinely outside a repository resolves to `false`
 *   (via {@link resolveRoot}'s NOT_GIT_REPO mapping);
 * - GIT_NOT_FOUND and GIT_TIMEOUT propagate so the caller can surface the real
 *   infrastructure failure instead of mislabeling it as NOT_GIT_REPO.
 *
 * @param dir - Directory to probe.
 * @returns true when the directory is inside a git repository.
 * @throws GitError with the typed code for infrastructure failures.
 */
export async function isGitRepoStrict(dir: string): Promise<boolean> {
  try {
    await resolveRoot(dir);
    return true;
  } catch (err) {
    if (err instanceof GitError && err.code === 'NOT_GIT_REPO') return false;
    throw err;
  }
}
