/**
 * @module adapters/implementation-base-authority.test
 * @description Unit tests for the implementation-entry freeze authority and
 *              the single transition finalizer (fail-closed freeze + pure
 *              persistence guard).
 *
 * @test-policy HAPPY, BAD, EDGE
 */

import { describe, expect, it, vi } from 'vitest';
import { makeState } from '../fixtures.js';

vi.mock('./git.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./git.js')>();
  return { ...original, headCommitFull: vi.fn() };
});

vi.mock('./frozen-repository.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./frozen-repository.js')>();
  return {
    ...original,
    freezeRepositoryIdentity: vi.fn(() => ({
      kind: 'local' as const,
      rootCommitDigest: 'sha256:' + 'b'.repeat(64),
    })),
  };
});

import { headCommitFull } from './git.js';
import {
  ensureImplementationBase,
  finalizeImplementationEntry,
  freezeImplementationBaseAuthority,
} from './implementation-base-authority.js';
import {
  assertImplementationEntryFrozen,
  IMPLEMENTATION_BASE_FREEZE_FAILED_CODE,
} from './implementation-entry-guard.js';

const SHA = 'd'.repeat(40);

function baseState() {
  return makeState('IMPLEMENTATION', {
    implementationBaseAuthority: {
      kind: 'commit',
      repositoryIdentity: { kind: 'local', rootCommitDigest: 'sha256:' + 'b'.repeat(64) },
      objectSha: SHA,
    },
  });
}

describe('freezeImplementationBaseAuthority', () => {
  it('HAPPY: resolves HEAD commit + identity at the freeze point', async () => {
    vi.mocked(headCommitFull).mockResolvedValue(SHA);
    const target = await freezeImplementationBaseAuthority('/tmp/repo');
    expect(target).toEqual({
      kind: 'commit',
      repositoryIdentity: { kind: 'local', rootCommitDigest: 'sha256:' + 'b'.repeat(64) },
      objectSha: SHA,
    });
  });

  it('BAD: throws FrozenRepositoryError when no commit can be frozen', async () => {
    vi.mocked(headCommitFull).mockResolvedValue(null);
    await expect(freezeImplementationBaseAuthority('/tmp/repo')).rejects.toMatchObject({
      code: 'FREEZE_FAILED',
    });
  });
});

describe('ensureImplementationBase', () => {
  it('HAPPY: freezes exactly once; re-entries preserve the original base', async () => {
    vi.mocked(headCommitFull).mockResolvedValue(SHA);
    const once = await ensureImplementationBase(makeState('IMPLEMENTATION'), '/tmp/repo');
    expect(once.implementationBaseAuthority?.objectSha).toBe(SHA);

    vi.mocked(headCommitFull).mockResolvedValue('e'.repeat(40));
    const twice = await ensureImplementationBase(once, '/tmp/repo');
    expect(twice.implementationBaseAuthority?.objectSha).toBe(SHA);
  });
});

describe('finalizeImplementationEntry (single transition finalizer)', () => {
  it('no-ops for non-IMPLEMENTATION phases', async () => {
    const state = makeState('VALIDATION');
    await expect(finalizeImplementationEntry(state)).resolves.toBe(state);
  });

  it('no-ops when the base is already frozen', async () => {
    const state = baseState();
    vi.mocked(headCommitFull).mockResolvedValue('e'.repeat(40));
    await expect(finalizeImplementationEntry(state)).resolves.toBe(state);
  });

  it('freezes the base when entering IMPLEMENTATION without one', async () => {
    vi.mocked(headCommitFull).mockResolvedValue(SHA);
    const result = await finalizeImplementationEntry(makeState('IMPLEMENTATION'));
    expect(result.implementationBaseAuthority?.objectSha).toBe(SHA);
  });

  it('fails closed with the canonical code when the freeze throws', async () => {
    vi.mocked(headCommitFull).mockResolvedValue(null);
    await expect(finalizeImplementationEntry(makeState('IMPLEMENTATION'))).rejects.toMatchObject({
      code: IMPLEMENTATION_BASE_FREEZE_FAILED_CODE,
    });
  });
});

describe('assertImplementationEntryFrozen (pure persistence guard)', () => {
  it('accepts an IMPLEMENTATION state with a frozen base', () => {
    expect(() => assertImplementationEntryFrozen(baseState())).not.toThrow();
  });

  it('accepts any non-IMPLEMENTATION phase', () => {
    expect(() => assertImplementationEntryFrozen(makeState('IMPL_REVIEW'))).not.toThrow();
    expect(() => assertImplementationEntryFrozen(makeState('READY'))).not.toThrow();
  });

  it('refuses an IMPLEMENTATION state without a frozen base (fail-closed, canonical code)', () => {
    expect(() => assertImplementationEntryFrozen(makeState('IMPLEMENTATION'))).toThrowError(
      expect.objectContaining({ code: IMPLEMENTATION_BASE_FREEZE_FAILED_CODE }),
    );
  });
});
