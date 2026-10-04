/**
 * @module adapters/git-command
 * @description Shared git subprocess primitives: typed errors and the
 * raw/trimmed execFile wrappers every git adapter module builds on.
 *
 * Design:
 * - Uses child_process.execFile (no shell invocation -- zero injection risk)
 * - Typed errors (GitError with codes)
 * - Timeout protection (5 seconds per command, configurable)
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
import { isEnoent } from './persistence.js';
import { getAdapterLogger } from '../logging/adapter-logger.js';

/** Deduplicated warn: uses warnOnce if available, falls back to warn. */
export function logWarn(service: string, message: string, extra?: Record<string, unknown>): void {
  const log = getAdapterLogger();
  if (log.warnOnce) {
    log.warnOnce(service, message, extra);
  } else {
    log.warn(service, message, extra);
  }
}

const execFileAsync = promisify(execFile);

/** Default timeout for git commands (ms). 5 seconds is generous for local ops. */
const GIT_TIMEOUT_MS = 5_000;

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

/**
 * Execute a git command in the given working directory.
 * Returns trimmed stdout on success.
 * Throws GitError on any failure.
 *
 * @param cwd - Working directory for the git command.
 * @param args - Git subcommand and arguments (e.g., ["status", "--porcelain"]).
 * @param timeoutMs - Optional timeout override.
 */
export async function gitRaw(
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
    const stderr =
      typeof err === 'object' && err !== null && 'stderr' in err ? String(err.stderr).trim() : '';
    const msg = stderr || (err instanceof Error ? err.message : String(err));
    throw new GitError('GIT_COMMAND_FAILED', `git ${args.join(' ')} failed: ${msg}`);
  }
}

/**
 * Trimmed git invocation -- for single-value commands (rev-parse, symbolic-ref,
 * config) where surrounding whitespace is noise. NEVER use for parsing
 * multi-record porcelain/diff output; use {@link gitRaw} + a dedicated parser.
 */
export async function git(
  cwd: string,
  args: string[],
  timeoutMs: number = GIT_TIMEOUT_MS,
): Promise<string> {
  return (await gitRaw(cwd, args, timeoutMs)).trim();
}

/** Type-safe timeout check (process killed). */
function isTimedOut(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'killed' in err && err.killed === true;
}
