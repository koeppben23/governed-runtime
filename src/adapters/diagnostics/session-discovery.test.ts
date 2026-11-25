/**
 * @module adapters/diagnostics/session-discovery.test
 * @description Verified lineage discovery, conflict handling and hard budgets.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionAuthorityResolution } from '../session-authority.js';
import type { SessionState } from '../../state/schema.js';
import { discoverSessionTree, type SessionTreeRequest } from './session-discovery.js';

vi.mock('../session-authority.js', () => ({
  resolveSessionAuthority: vi.fn(),
}));

import { resolveSessionAuthority } from '../session-authority.js';

const resolveMock = vi.mocked(resolveSessionAuthority);

interface InvocationLink {
  readonly parent: string;
  readonly child: string;
}

interface AttemptLink {
  readonly child?: string;
  readonly observedBy?: string;
}

function stateOf(
  input: {
    readonly invocations?: readonly InvocationLink[];
    readonly attempts?: readonly AttemptLink[];
  } = {},
): SessionState {
  return {
    phase: 'READY',
    reviewAssurance: {
      invocations: (input.invocations ?? []).map((link, index) => ({
        parentSessionId: link.parent,
        childSessionId: link.child,
        invocationId: `invocation-${index}`,
      })),
      attempts: (input.attempts ?? []).map((attempt, index) => ({
        childSessionId: attempt.child,
        attemptId: `attempt-${index}`,
        observations:
          attempt.observedBy === undefined ? [] : [{ observedBySessionId: attempt.observedBy }],
      })),
    },
  } as unknown as SessionState;
}

function resolved(sessionId: string, state: SessionState): SessionAuthorityResolution {
  return {
    status: 'resolved',
    sessDir: `/tmp/${sessionId}`,
    worktreeRoot: '/tmp',
    fingerprint: 'fingerprint',
    state,
  };
}

function absent(sessionId: string): SessionAuthorityResolution {
  return {
    status: 'absent',
    sessDir: `/tmp/${sessionId}`,
    worktreeRoot: '/tmp',
    fingerprint: 'fingerprint',
  };
}

function request(
  rootState: SessionState,
  overrides: Partial<SessionTreeRequest> = {},
): SessionTreeRequest {
  return {
    root: '/tmp/repo',
    rootSessionId: 'root',
    rootState,
    rootAuthority: resolved('root', rootState),
    ...overrides,
  };
}

beforeEach(() => {
  resolveMock.mockReset();
  resolveMock.mockImplementation(async ({ sessionId }) => absent(sessionId));
});

describe('session tree discovery', () => {
  it('HAPPY — verifies a root → child → grandchild invocation chain', async () => {
    resolveMock.mockImplementation(async ({ sessionId }) => {
      if (sessionId === 'child') {
        return resolved(
          'child',
          stateOf({ invocations: [{ parent: 'child', child: 'grandchild' }] }),
        );
      }
      if (sessionId === 'grandchild') return resolved('grandchild', stateOf());
      return absent(sessionId);
    });

    const tree = await discoverSessionTree(
      request(stateOf({ invocations: [{ parent: 'root', child: 'child' }] })),
    );

    expect(tree.truncated).toBe(false);
    expect(tree.reasons).toEqual([]);
    expect(
      tree.sessions.map((session) => ({
        id: session.sessionId,
        parent: session.parentSessionId,
        generation: session.generation,
        lineage: session.lineage,
        state: session.state === null ? null : 'resolved',
      })),
    ).toEqual([
      { id: 'root', parent: null, generation: 0, lineage: 'verified', state: 'resolved' },
      { id: 'child', parent: 'root', generation: 1, lineage: 'verified', state: 'resolved' },
      {
        id: 'grandchild',
        parent: 'child',
        generation: 2,
        lineage: 'verified',
        state: 'resolved',
      },
    ]);
    expect(resolveMock.mock.calls.map(([input]) => input.sessionId)).toEqual([
      'child',
      'grandchild',
    ]);
  });

  it('BAD — keeps a session with conflicting invocation parents not_verified', async () => {
    resolveMock.mockImplementation(async ({ sessionId }) => {
      if (sessionId === 'parent-a') {
        return resolved(
          'parent-a',
          stateOf({ invocations: [{ parent: 'parent-a', child: 'shared' }] }),
        );
      }
      if (sessionId === 'parent-b') {
        return resolved(
          'parent-b',
          stateOf({ invocations: [{ parent: 'parent-b', child: 'shared' }] }),
        );
      }
      if (sessionId === 'shared') return resolved('shared', stateOf());
      return absent(sessionId);
    });

    const tree = await discoverSessionTree(
      request(
        stateOf({
          invocations: [
            { parent: 'root', child: 'parent-a' },
            { parent: 'root', child: 'parent-b' },
            { parent: 'parent-a', child: 'shared' },
            { parent: 'parent-b', child: 'shared' },
          ],
        }),
      ),
    );

    const shared = tree.sessions.find((session) => session.sessionId === 'shared');
    expect(shared).toMatchObject({
      parentSessionId: null,
      lineage: 'not_verified',
      conflict: true,
      authority: null,
      state: null,
    });
    expect(shared?.warnings.map((entry) => entry.code)).toContain('LINEAGE_CONFLICT');
    expect(tree.reasons).toContain('LINEAGE_CONFLICT:shared');
    expect(resolveMock.mock.calls.map(([input]) => input.sessionId)).not.toContain('shared');
  });

  it('BAD — a later conflict clears an already verified descendant chain', async () => {
    resolveMock.mockImplementation(async ({ sessionId }) => {
      if (sessionId === 'parent-a') {
        return resolved(
          'parent-a',
          stateOf({ invocations: [{ parent: 'parent-a', child: 'grandchild' }] }),
        );
      }
      if (sessionId === 'parent-b') {
        return resolved(
          'parent-b',
          stateOf({ invocations: [{ parent: 'parent-b', child: 'parent-a' }] }),
        );
      }
      if (sessionId === 'grandchild') return resolved('grandchild', stateOf());
      return absent(sessionId);
    });

    const tree = await discoverSessionTree(
      request(
        stateOf({
          invocations: [
            { parent: 'root', child: 'parent-a' },
            { parent: 'root', child: 'parent-b' },
          ],
        }),
      ),
    );

    expect(tree.sessions.find((session) => session.sessionId === 'parent-a')).toMatchObject({
      lineage: 'not_verified',
      conflict: true,
    });
    expect(tree.sessions.find((session) => session.sessionId === 'grandchild')).toMatchObject({
      lineage: 'not_verified',
      authority: null,
      state: null,
    });
  });

  it('CORNER — ignores duplicate and cyclic invocation edges', async () => {
    resolveMock.mockImplementation(async ({ sessionId }) =>
      sessionId === 'child'
        ? resolved(
            'child',
            stateOf({
              invocations: [
                { parent: 'child', child: 'root' },
                { parent: 'child', child: 'child' },
              ],
            }),
          )
        : absent(sessionId),
    );

    const tree = await discoverSessionTree(
      request(
        stateOf({
          invocations: [
            { parent: 'root', child: 'child' },
            { parent: 'root', child: 'child' },
          ],
        }),
      ),
    );

    expect(tree.sessions.map((session) => session.sessionId)).toEqual(['root', 'child']);
    expect(tree.sessions[1]).toMatchObject({
      parentSessionId: 'root',
      generation: 1,
      lineage: 'verified',
    });
    expect(resolveMock).toHaveBeenCalledTimes(1);
  });

  it('BAD — attempts, observations and foreign parents never authorize a read', async () => {
    const tree = await discoverSessionTree(
      request(
        stateOf({
          invocations: [{ parent: 'foreign', child: 'foreign-child' }],
          attempts: [{ child: 'attempt-child' }, { observedBy: 'observer' }],
        }),
      ),
    );

    expect(tree.sessions).toHaveLength(4);
    for (const sessionId of ['attempt-child', 'observer', 'foreign-child']) {
      expect(tree.sessions.find((session) => session.sessionId === sessionId)).toMatchObject({
        lineage: 'not_verified',
        authority: null,
        state: null,
      });
    }
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it('CORNER — preserves the first overflow candidate and stops at the discovery budget', async () => {
    resolveMock.mockImplementation(async ({ sessionId }) =>
      sessionId === 'child-1' ? resolved('child-1', stateOf()) : absent(sessionId),
    );

    const tree = await discoverSessionTree(
      request(
        stateOf({
          invocations: [
            { parent: 'root', child: 'child-1' },
            { parent: 'root', child: 'child-2' },
            { parent: 'root', child: 'child-3' },
          ],
        }),
        { maxNodes: 2 },
      ),
    );

    expect(tree.truncated).toBe(true);
    expect(tree.reasons).toContain('DISCOVERY_NODE_LIMIT');
    expect(tree.sessions.map((session) => session.sessionId)).toEqual([
      'root',
      'child-1',
      'child-2',
    ]);
    // The root state was not fully enumerated, so none of its children may be
    // read or treated as verified.
    for (const sessionId of ['child-1', 'child-2']) {
      expect(tree.sessions.find((session) => session.sessionId === sessionId)).toMatchObject({
        lineage: 'not_verified',
        state: null,
      });
    }
    expect(
      tree.sessions.find((session) => session.sessionId === 'child-2')?.warnings.map((w) => w.code),
    ).toContain('SESSION_LINEAGE_PARENT_INCOMPLETE');
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it('BAD — an invocation claim observed only in another parent does not authorize', async () => {
    resolveMock.mockImplementation(async ({ sessionId }) => {
      if (sessionId === 'claimed-parent') {
        return resolved('claimed-parent', stateOf({ attempts: [{ child: 'child' }] }));
      }
      if (sessionId === 'child') return resolved('child', stateOf());
      return absent(sessionId);
    });

    const tree = await discoverSessionTree(
      request(
        stateOf({
          invocations: [
            { parent: 'root', child: 'claimed-parent' },
            { parent: 'claimed-parent', child: 'child' },
          ],
        }),
      ),
    );

    expect(tree.sessions.find((session) => session.sessionId === 'child')).toMatchObject({
      parentSessionId: 'claimed-parent',
      lineage: 'not_verified',
      authority: null,
      state: null,
    });
    expect(resolveMock.mock.calls.map(([input]) => input.sessionId)).not.toContain('child');
  });

  it('CORNER — bounds raw candidate enumeration and stays conservative', async () => {
    const tree = await discoverSessionTree(
      request(
        stateOf({
          invocations: [
            { parent: 'root', child: 'child-1' },
            { parent: 'root', child: 'child-2' },
            { parent: 'root', child: 'child-3' },
            { parent: 'root', child: 'child-4' },
          ],
        }),
        { maxNodes: 10, maxCandidates: 2 },
      ),
    );

    expect(tree.truncated).toBe(true);
    expect(tree.reasons).toContain('DISCOVERY_CANDIDATE_LIMIT');
    expect(tree.sessions.map((session) => session.sessionId)).toEqual([
      'root',
      'child-1',
      'child-2',
    ]);
    expect(
      tree.sessions
        .filter((session) => session.sessionId !== 'root')
        .every((session) => session.lineage === 'not_verified'),
    ).toBe(true);
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it('EDGE — keeps a verified child with missing state in the denominator', async () => {
    const tree = await discoverSessionTree(
      request(stateOf({ invocations: [{ parent: 'root', child: 'child' }] })),
    );

    expect(tree.sessions.find((session) => session.sessionId === 'child')).toMatchObject({
      parentSessionId: 'root',
      lineage: 'verified',
      state: null,
      authority: { status: 'absent' },
    });
    expect(tree.reasons).toContain('SESSION_STATE_ABSENT:child');
  });

  it('EDGE — marks discovery partial and does not read a child after the time budget', async () => {
    let calls = 0;
    const tree = await discoverSessionTree(
      request(stateOf({ invocations: [{ parent: 'root', child: 'child' }] }), {
        deadlineAt: 100,
        // The root enumeration completes, then the child read is refused.
        now: () => (calls++ === 0 ? 50 : 200),
      }),
    );

    expect(tree.truncated).toBe(true);
    expect(tree.reasons).toContain('CAPTURE_TIME_BUDGET_EXCEEDED:child');
    expect(tree.sessions.find((session) => session.sessionId === 'child')).toMatchObject({
      lineage: 'verified',
      authority: null,
      state: null,
    });
    expect(resolveMock).not.toHaveBeenCalled();
  });
});
