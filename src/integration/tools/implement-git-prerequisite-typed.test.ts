/**
 * @module integration/tools/implement-git-prerequisite-typed
 * @description Typed-error preservation for the /implement git prerequisite
 *              (#852): validateGitPrerequisite must surface GIT_NOT_FOUND /
 *              GIT_TIMEOUT / GIT_COMMAND_FAILED with their real reason codes
 *              instead of flattening every git failure into NOT_GIT_REPO.
 *
 * @test-policy HAPPY, BAD, CORNER — repository, non-repo, and infra failures.
 * @version v1
 */

import { describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';

const { isGitRepoStrict } = vi.hoisted(() => ({ isGitRepoStrict: vi.fn() }));

// All cases run against a REAL existing path: validateGitPrerequisite guards
// missing paths with NOT_GIT_REPO before the probe is ever consulted.
const WORKTREE = os.tmpdir();

vi.mock('../../adapters/git.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../adapters/git.js')>();
  return { ...original, isGitRepoStrict };
});

import { validateGitPrerequisite } from './implement-record.js';
import { GitError } from '../../adapters/git.js';

function parseCode(result: string): string {
  return (JSON.parse(result) as { code: string }).code;
}

describe('validateGitPrerequisite typed error preservation', () => {
  it('returns null when the probe reports a git repository (HAPPY)', async () => {
    isGitRepoStrict.mockResolvedValue(true);
    expect(await validateGitPrerequisite(WORKTREE)).toBeNull();
  });

  it('blocks with NOT_GIT_REPO when the probe reports a non-repo (BAD)', async () => {
    isGitRepoStrict.mockResolvedValue(false);
    const result = await validateGitPrerequisite(WORKTREE);
    expect(parseCode(result!)).toBe('NOT_GIT_REPO');
  });

  it('preserves GIT_NOT_FOUND instead of mislabeling it as NOT_GIT_REPO (BAD)', async () => {
    isGitRepoStrict.mockRejectedValue(
      new GitError('GIT_NOT_FOUND', 'git executable not found in PATH. Ensure git is installed.'),
    );
    const result = await validateGitPrerequisite(WORKTREE);
    expect(parseCode(result!)).toBe('GIT_NOT_FOUND');
  });

  it('preserves GIT_TIMEOUT instead of mislabeling it as NOT_GIT_REPO (CORNER)', async () => {
    isGitRepoStrict.mockRejectedValue(
      new GitError('GIT_TIMEOUT', 'git rev-parse timed out after 5000ms'),
    );
    const result = await validateGitPrerequisite(WORKTREE);
    expect(parseCode(result!)).toBe('GIT_TIMEOUT');
  });

  it('preserves GIT_COMMAND_FAILED as a typed infra failure (CORNER)', async () => {
    isGitRepoStrict.mockRejectedValue(
      new GitError('GIT_COMMAND_FAILED', 'git rev-parse failed: corrupted repo state'),
    );
    const result = await validateGitPrerequisite(WORKTREE);
    expect(parseCode(result!)).toBe('GIT_COMMAND_FAILED');
  });
});
