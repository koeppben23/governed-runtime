/**
 * @module repository-authority.test
 * @description Unit tests for the freeze-time repository authority rails
 *              helper: idempotent pre-mutation base freeze, fail-closed
 *              context freezing, and candidate-pair construction.
 *
 * @test-policy HAPPY, BAD, EDGE
 */

import { describe, expect, it, vi } from 'vitest';
import { makeState } from '../fixtures.js';
import type { SessionState } from '../state/schema.js';

vi.mock('../adapters/git.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/git.js')>();
  return { ...original, headCommitFull: vi.fn().mockResolvedValue('a'.repeat(40)) };
});

vi.mock('../adapters/frozen-repository.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/frozen-repository.js')>();
  return {
    ...original,
    freezeRepositoryIdentity: vi.fn(() => ({
      kind: 'local',
      rootCommitDigest: 'sha256:' + 'b'.repeat(64),
    })),
    freezeWorktreeCandidate: vi.fn().mockResolvedValue('c'.repeat(40)),
  };
});

import { headCommitFull } from '../adapters/git.js';
import {
  FrozenRepositoryError,
  freezeRepositoryIdentity,
  freezeWorktreeCandidate,
} from '../adapters/frozen-repository.js';
import {
  ensureImplementationBase,
  freezeCandidatePairAuthority,
  freezeContextAuthority,
  freezeImplementationBaseAuthority,
} from './repository-authority.js';

const SHA = 'a'.repeat(40);

function stateWithBase(): SessionState {
  return {
    ...makeState('IMPLEMENTATION'),
    implementationBaseAuthority: {
      kind: 'commit',
      repositoryIdentity: { kind: 'local', rootCommitDigest: 'sha256:' + 'b'.repeat(64) },
      objectSha: SHA,
    },
  };
}

describe('ensureImplementationBase', () => {
  it('HAPPY: freezes the base exactly once when absent', async () => {
    const result = await ensureImplementationBase(makeState('IMPLEMENTATION'), '/tmp/repo');
    expect(result.implementationBaseAuthority?.objectSha).toBe(SHA);
    expect(result.implementationBaseAuthority?.kind).toBe('commit');
    expect(headCommitFull).toHaveBeenCalledTimes(1);
  });

  it('EDGE: re-entry is idempotent — the pre-mutation base is never re-frozen', async () => {
    vi.mocked(headCommitFull).mockClear();
    const state = stateWithBase();
    const result = await ensureImplementationBase(state, '/tmp/repo');
    expect(result).toBe(state);
    expect(headCommitFull).not.toHaveBeenCalled();
  });

  it('BAD: freeze failure propagates fail-closed', async () => {
    vi.mocked(headCommitFull).mockResolvedValueOnce(null);
    await expect(
      ensureImplementationBase(makeState('IMPLEMENTATION'), '/tmp/repo'),
    ).rejects.toBeInstanceOf(FrozenRepositoryError);
  });
});

describe('freezeImplementationBaseAuthority', () => {
  it('HAPPY: resolves commit + identity at the freeze point', async () => {
    const target = await freezeImplementationBaseAuthority('/tmp/repo');
    expect(target).toEqual({
      kind: 'commit',
      repositoryIdentity: { kind: 'local', rootCommitDigest: 'sha256:' + 'b'.repeat(64) },
      objectSha: SHA,
    });
  });

  it('BAD: no commit fails closed', async () => {
    vi.mocked(headCommitFull).mockResolvedValueOnce(null);
    await expect(freezeImplementationBaseAuthority('/tmp/repo')).rejects.toMatchObject({
      code: 'FREEZE_FAILED',
    });
  });
});

describe('freezeContextAuthority', () => {
  it('HAPPY: builds a context authority from the frozen commit', () => {
    const result = freezeContextAuthority('/tmp/repo', SHA);
    expect(result).toEqual({
      kind: 'available',
      authority: {
        kind: 'context',
        context: {
          kind: 'commit',
          repositoryIdentity: { kind: 'local', rootCommitDigest: 'sha256:' + 'b'.repeat(64) },
          objectSha: SHA,
        },
      },
    });
  });

  it('BAD: unresolvable identity degrades typed (evidence unavailable, not a block)', () => {
    vi.mocked(freezeRepositoryIdentity).mockImplementationOnce(() => {
      throw new FrozenRepositoryError('IDENTITY_UNAVAILABLE', 'no identity');
    });
    expect(freezeContextAuthority('/tmp/repo', SHA)).toEqual({
      kind: 'unavailable',
      reason: 'repository_identity_unavailable',
      diagnostic: 'no identity',
    });
  });
});

describe('freezeCandidatePairAuthority', () => {
  it('HAPPY: pairs the persisted base with the worktree candidate head', async () => {
    const authority = await freezeCandidatePairAuthority(stateWithBase(), '/tmp/repo');
    expect(authority).toEqual({
      kind: 'candidate_pair',
      base: {
        kind: 'commit',
        repositoryIdentity: { kind: 'local', rootCommitDigest: 'sha256:' + 'b'.repeat(64) },
        objectSha: SHA,
      },
      head: {
        kind: 'tree',
        repositoryIdentity: { kind: 'local', rootCommitDigest: 'sha256:' + 'b'.repeat(64) },
        objectSha: 'c'.repeat(40),
      },
    });
  });

  it('BAD: missing base authority returns undefined (fail closed)', async () => {
    vi.mocked(freezeWorktreeCandidate).mockClear();
    const authority = await freezeCandidatePairAuthority(makeState('IMPLEMENTATION'), '/tmp/repo');
    expect(authority).toBeUndefined();
    expect(freezeWorktreeCandidate).not.toHaveBeenCalled();
  });

  it('BAD: candidate freeze failure returns undefined (fail closed)', async () => {
    vi.mocked(freezeWorktreeCandidate).mockRejectedValueOnce(
      new FrozenRepositoryError('FREEZE_FAILED', 'freeze failed'),
    );
    const authority = await freezeCandidatePairAuthority(stateWithBase(), '/tmp/repo');
    expect(authority).toBeUndefined();
  });
});
