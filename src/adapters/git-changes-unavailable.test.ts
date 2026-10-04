/**
 * @module adapters/git-changes-unavailable.test
 * @description Typed git-failure propagation for listRepoSignals.
 *
 * A missing git executable or a git timeout cannot be simulated
 * deterministically against the real binary, so these cases mock the shared
 * git command authority and assert that the typed GitError propagates
 * unchanged instead of collapsing into empty repository signals.
 *
 * @test-policy BAD, CORNER
 */

import { describe, expect, it, vi } from 'vitest';
import { GitError, gitRaw } from './git-command.js';
import { listRepoSignals } from './git-changes.js';

vi.mock('./git-command.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./git-command.js')>();
  return { ...actual, gitRaw: vi.fn() };
});

describe('listRepoSignals typed failure propagation', () => {
  it.each(['GIT_NOT_FOUND', 'GIT_TIMEOUT', 'GIT_COMMAND_FAILED'] as const)(
    'propagates %s instead of returning empty signals',
    async (code) => {
      vi.mocked(gitRaw).mockRejectedValueOnce(new GitError(code, `${code} failure`));

      await expect(listRepoSignals('/repo')).rejects.toMatchObject({ code });
    },
  );

  it('propagates an unexpected error unchanged', async () => {
    vi.mocked(gitRaw).mockRejectedValueOnce(new TypeError('unexpected'));

    await expect(listRepoSignals('/repo')).rejects.toThrow(TypeError);
  });
});
