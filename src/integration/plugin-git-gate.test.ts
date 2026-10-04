/**
 * @module integration/plugin-git-gate.test
 * @description Tests for the git prerequisite gate before host mutation
 *              dispatch (#852): a mutating host tool in a non-Git worktree
 *              must fail closed with NOT_GIT_REPO BEFORE any dispatch is
 *              authorized, and typed git diagnoses (GIT_NOT_FOUND,
 *              GIT_TIMEOUT) must be preserved instead of being flattened.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 * @version v1
 */

import { describe, expect, it, vi } from 'vitest';

const { isGitRepoStrict } = vi.hoisted(() => ({ isGitRepoStrict: vi.fn() }));

vi.mock('../adapters/git.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/git.js')>();
  return { ...original, isGitRepoStrict };
});

import { enforceGitPrerequisiteBeforeMutation } from './plugin-git-gate.js';
import { GitError } from '../adapters/git.js';

function thrownCode(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  const prefix = '[FlowGuard] ';
  if (!err.message.startsWith(prefix)) return undefined;
  try {
    const parsed = JSON.parse(err.message.slice(prefix.length)) as { code?: unknown };
    return typeof parsed.code === 'string' ? parsed.code : undefined;
  } catch {
    return undefined;
  }
}

function deps(worktree: string | undefined): { getWorktreeRoot(): string | undefined } {
  return { getWorktreeRoot: () => worktree };
}

describe('enforceGitPrerequisiteBeforeMutation', () => {
  it('allows the mutation when the worktree is a git repository (HAPPY)', async () => {
    isGitRepoStrict.mockResolvedValue(true);
    await expect(
      enforceGitPrerequisiteBeforeMutation(deps('/repo'), 'write'),
    ).resolves.toBeUndefined();
  });

  it('blocks with NOT_GIT_REPO when the worktree is not a git repository (BAD)', async () => {
    isGitRepoStrict.mockResolvedValue(false);
    await expect(enforceGitPrerequisiteBeforeMutation(deps('/plain'), 'bash')).rejects.toThrow(
      'NOT_GIT_REPO',
    );
  });

  it('preserves GIT_NOT_FOUND instead of mislabeling it as NOT_GIT_REPO (BAD)', async () => {
    isGitRepoStrict.mockRejectedValue(
      new GitError('GIT_NOT_FOUND', 'git executable not found in PATH. Ensure git is installed.'),
    );
    await expect(enforceGitPrerequisiteBeforeMutation(deps('/repo'), 'write')).rejects.toThrow(
      'GIT_NOT_FOUND',
    );
  });

  it('preserves GIT_TIMEOUT instead of mislabeling it as NOT_GIT_REPO (CORNER)', async () => {
    isGitRepoStrict.mockRejectedValue(
      new GitError('GIT_TIMEOUT', 'git rev-parse timed out after 5000ms'),
    );
    await expect(enforceGitPrerequisiteBeforeMutation(deps('/repo'), 'write')).rejects.toThrow(
      'GIT_TIMEOUT',
    );
  });

  it('fails closed when no worktree is available (EDGE)', async () => {
    await expect(enforceGitPrerequisiteBeforeMutation(deps(undefined), 'bash')).rejects.toThrow(
      'PLUGIN_ENFORCEMENT_UNAVAILABLE',
    );
  });

  it('carries the NOT_GIT_REPO enforcement code in the error payload (BAD)', async () => {
    isGitRepoStrict.mockResolvedValue(false);
    await expect(enforceGitPrerequisiteBeforeMutation(deps('/plain'), 'edit')).rejects.toSatisfy(
      (err: unknown) => thrownCode(err) === 'NOT_GIT_REPO',
    );
  });
});
