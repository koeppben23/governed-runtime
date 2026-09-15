/**
 * @module evidence-review-authority.test
 * @description Unit tests for the frozen repository authority predicates.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 */

import { describe, expect, it } from 'vitest';
import {
  deriveRepositoryRevisionProvenance,
  hasFrozenRepositoryAuthority,
  resolveFrozenRevisionTarget,
  verifyFrozenRepositoryAuthority,
} from './evidence-review-authority.js';
import type {
  FrozenRepositoryAuthority,
  RepositoryAuthorityCarrier,
} from './evidence-review-authority.js';

const REMOTE = { host: 'github.com', owner: 'acme', name: 'repo' };
const LOCAL = { kind: 'local' as const, rootCommitDigest: 'sha256:' + 'a'.repeat(64) };
const SHA_BASE = 'b'.repeat(40);
const SHA_HEAD = 'c'.repeat(40);
const TREE_SHA = 'd'.repeat(40);

function candidatePair(baseSha = SHA_BASE, headSha = SHA_HEAD): FrozenRepositoryAuthority {
  return {
    kind: 'candidate_pair',
    base: { kind: 'commit', repositoryIdentity: REMOTE, objectSha: baseSha },
    head: { kind: 'tree', repositoryIdentity: REMOTE, objectSha: headSha },
  };
}

const FORK_HEAD = { host: 'github.com', owner: 'contributor', name: 'repo-fork' };

function forkPair(): FrozenRepositoryAuthority {
  return {
    kind: 'fork_pair',
    base: { kind: 'commit', repositoryIdentity: REMOTE, objectSha: SHA_BASE },
    head: { kind: 'commit', repositoryIdentity: FORK_HEAD, objectSha: SHA_HEAD },
  };
}

describe('hasFrozenRepositoryAuthority', () => {
  it('HAPPY: candidate_pair authority counts', () => {
    expect(hasFrozenRepositoryAuthority({ repositoryAuthority: candidatePair() })).toBe(true);
  });
  it('HAPPY: context authority counts', () => {
    expect(
      hasFrozenRepositoryAuthority({
        repositoryAuthority: {
          kind: 'context',
          context: { kind: 'commit', repositoryIdentity: REMOTE, objectSha: SHA_BASE },
        },
      }),
    ).toBe(true);
  });
  it('BAD: no authority is false', () => {
    expect(hasFrozenRepositoryAuthority({})).toBe(false);
  });
  it('BAD: a repository_change reviewSubject without explicit authority is not governed', () => {
    const carrier = {
      reviewSubject: { kind: 'repository_change' },
    } as unknown as RepositoryAuthorityCarrier;
    expect(hasFrozenRepositoryAuthority(carrier)).toBe(false);
  });
});

describe('resolveFrozenRevisionTarget', () => {
  it('HAPPY: candidate_pair resolves base and head to distinct targets', () => {
    const carrier = { repositoryAuthority: candidatePair() };
    expect(resolveFrozenRevisionTarget(carrier, 'base')?.objectSha).toBe(SHA_BASE);
    expect(resolveFrozenRevisionTarget(carrier, 'head')?.objectSha).toBe(SHA_HEAD);
    expect(resolveFrozenRevisionTarget(carrier, 'head')?.kind).toBe('tree');
  });
  it('HAPPY: fork_pair resolves base and head to their own repositories', () => {
    const carrier = { repositoryAuthority: forkPair() };
    expect(resolveFrozenRevisionTarget(carrier, 'base')?.repositoryIdentity).toEqual(REMOTE);
    expect(resolveFrozenRevisionTarget(carrier, 'head')?.repositoryIdentity).toEqual(FORK_HEAD);
  });
  it('HAPPY: context resolves head only; base is unavailable', () => {
    const carrier = {
      repositoryAuthority: {
        kind: 'context' as const,
        context: { kind: 'commit' as const, repositoryIdentity: REMOTE, objectSha: SHA_BASE },
      },
    };
    expect(resolveFrozenRevisionTarget(carrier, 'head')?.objectSha).toBe(SHA_BASE);
    expect(resolveFrozenRevisionTarget(carrier, 'base')).toBeNull();
  });
});

describe('deriveRepositoryRevisionProvenance', () => {
  it('HAPPY: candidate_pair derives available with both SHAs', () => {
    expect(deriveRepositoryRevisionProvenance({ repositoryAuthority: candidatePair() })).toEqual({
      kind: 'available',
      headSha: SHA_HEAD,
      baseSha: SHA_BASE,
    });
  });
  it('HAPPY: context derives head-only availability', () => {
    expect(
      deriveRepositoryRevisionProvenance({
        repositoryAuthority: {
          kind: 'context',
          context: { kind: 'commit', repositoryIdentity: REMOTE, objectSha: SHA_BASE },
        },
      }),
    ).toEqual({ kind: 'available', headSha: SHA_BASE });
  });
  it('HAPPY: fork_pair derives available with both SHAs', () => {
    expect(deriveRepositoryRevisionProvenance({ repositoryAuthority: forkPair() })).toEqual({
      kind: 'available',
      headSha: SHA_HEAD,
      baseSha: SHA_BASE,
    });
  });
  it('BAD: no authority derives unavailable', () => {
    const derived = deriveRepositoryRevisionProvenance({});
    expect(derived.kind).toBe('unavailable');
  });
});

describe('verifyFrozenRepositoryAuthority', () => {
  it('HAPPY: consistent remote candidate_pair verifies', () => {
    expect(verifyFrozenRepositoryAuthority(candidatePair())).toBeNull();
  });
  it('HAPPY: consistent local candidate_pair verifies', () => {
    const authority: FrozenRepositoryAuthority = {
      kind: 'candidate_pair',
      base: { kind: 'commit', repositoryIdentity: LOCAL, objectSha: SHA_BASE },
      head: { kind: 'tree', repositoryIdentity: LOCAL, objectSha: TREE_SHA },
    };
    expect(verifyFrozenRepositoryAuthority(authority)).toBeNull();
  });
  it('BAD: mixed remote/local identities are rejected', () => {
    const authority: FrozenRepositoryAuthority = {
      kind: 'candidate_pair',
      base: { kind: 'commit', repositoryIdentity: REMOTE, objectSha: SHA_BASE },
      head: { kind: 'tree', repositoryIdentity: LOCAL, objectSha: TREE_SHA },
    };
    expect(verifyFrozenRepositoryAuthority(authority)).toContain('identity kind');
  });
  it('BAD: divergent remote identities are rejected', () => {
    const authority: FrozenRepositoryAuthority = {
      kind: 'candidate_pair',
      base: { kind: 'commit', repositoryIdentity: REMOTE, objectSha: SHA_BASE },
      head: {
        kind: 'tree',
        repositoryIdentity: { host: 'github.com', owner: 'other', name: 'repo' },
        objectSha: TREE_SHA,
      },
    };
    expect(verifyFrozenRepositoryAuthority(authority)).toContain('remote repository identity');
  });
  it('HAPPY: fork_pair with distinct same-host remote identities verifies', () => {
    expect(verifyFrozenRepositoryAuthority(forkPair())).toBeNull();
  });
  it('BAD: fork_pair naming the same repository is rejected', () => {
    const authority: FrozenRepositoryAuthority = {
      kind: 'fork_pair',
      base: { kind: 'commit', repositoryIdentity: REMOTE, objectSha: SHA_BASE },
      head: { kind: 'commit', repositoryIdentity: REMOTE, objectSha: SHA_HEAD },
    };
    expect(verifyFrozenRepositoryAuthority(authority)).toContain('distinct repositories');
  });
  it('BAD: fork_pair with local identities is rejected', () => {
    const authority: FrozenRepositoryAuthority = {
      kind: 'fork_pair',
      base: { kind: 'commit', repositoryIdentity: LOCAL, objectSha: SHA_BASE },
      head: {
        kind: 'commit',
        repositoryIdentity: { kind: 'local', rootCommitDigest: 'sha256:' + 'b'.repeat(64) },
        objectSha: SHA_HEAD,
      },
    };
    expect(verifyFrozenRepositoryAuthority(authority)).toContain('remote repository identities');
  });
  it('BAD: fork_pair across hosts is rejected', () => {
    const authority: FrozenRepositoryAuthority = {
      kind: 'fork_pair',
      base: { kind: 'commit', repositoryIdentity: REMOTE, objectSha: SHA_BASE },
      head: {
        kind: 'commit',
        repositoryIdentity: { host: 'gitlab.com', owner: 'contributor', name: 'repo-fork' },
        objectSha: SHA_HEAD,
      },
    };
    expect(verifyFrozenRepositoryAuthority(authority)).toContain('one remote host');
  });
});
