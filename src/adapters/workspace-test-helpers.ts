/**
 * @module adapters/workspace-test-helpers
 * @description Test-only fixtures for adapter suites that need a real git
 * worktree without binding to the developer's repository root.
 *
 * The helper never falls back to `path.resolve('.')`: every suite that needs a
 * worktree gets a fresh temporary git repository. Creation is failure-atomic
 * (a failed `git init` or remote setup removes the directory again), and the
 * cleanup removes the whole tree, so repo-scoped config written under
 * `{worktree}/.opencode/` can never leak into the real repository.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/** Deterministic local test remote; never contacted, only canonicalized. */
export const TEST_REMOTE_ORIGIN = 'https://github.com/flowguard-test/repo.git';

export interface TempWorktree {
  /** Realpath of the temporary git worktree root. */
  readonly worktree: string;
  /** Remove the temporary worktree tree (best effort on Windows locks). */
  readonly cleanup: () => Promise<void>;
}

export interface TempWorktreeOptions {
  readonly prefix?: string;
  /** Optional `origin` remote so `computeFingerprint` uses remote identity. */
  readonly remote?: string;
}

/**
 * Create an isolated temporary git worktree.
 *
 * @param options - Optional directory prefix and `origin` remote URL.
 * @returns The realpathed worktree root plus its idempotent cleanup.
 */
export async function createTempWorktree(options: TempWorktreeOptions = {}): Promise<TempWorktree> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), options.prefix ?? 'fg-worktree-'));
  try {
    const worktree = await fs.realpath(created);
    execFileSync('git', ['init', '--quiet', worktree], { windowsHide: true });
    if (options.remote !== undefined) {
      execFileSync('git', ['remote', 'add', 'origin', options.remote], {
        cwd: worktree,
        windowsHide: true,
      });
    }
    return {
      worktree,
      cleanup: async () => {
        await fs.rm(worktree, { recursive: true, force: true });
      },
    };
  } catch (error) {
    // Failure-atomic: no partially initialized temp directory survives.
    await fs.rm(created, { recursive: true, force: true }).catch(() => {
      // Best effort; the original error is the actionable failure.
    });
    throw error;
  }
}
