import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  commitGovernanceActivation,
  governanceActivationKeys,
  resolveGovernanceActivation,
  listActiveGovernanceRoots,
  type GovernanceActivationCommit,
} from './governance-activation.js';
import {
  createActivationStoreFixture,
  seedActiveGovernance,
} from '../fixtures/governance-activation.js';
import { blocked } from '../config/reasons.js';
import { canonicalJsonStringify } from '../shared/canonical-json.js';
import { hashText } from '../shared/hashing.js';
import type { GovernanceActivationRevision } from '../state/governance-activation.js';

const policyDigest = 'a'.repeat(64);
const sessionId = 'root';
function start(): GovernanceActivationCommit {
  return {
    action: 'start',
    expectedRevision: 0,
    sessionId,
    rootSessionId: sessionId,
    activationId: randomUUID(),
    generation: 1,
    directory: '/project',
    worktreeRoot: '/project',
    policyDigest,
    parentDispatch: null,
  };
}

function installHistory(
  fixture: ReturnType<typeof createActivationStoreFixture>,
  initial: GovernanceActivationRevision,
  replay: 'start' | 'end',
): void {
  const keys = governanceActivationKeys(sessionId);
  const statuses = [
    'activating',
    'active',
    'ending',
    'inactive',
    'activating',
    'active',
    'ending',
  ] as const;
  let previousDigest: string | null = null;
  for (const [index, status] of statuses.entries()) {
    const second = index >= 4;
    const decisionId =
      index < 2
        ? 'initial-start'
        : index < 4
          ? 'initial-end'
          : index < 6
            ? replay === 'start'
              ? 'initial-start'
              : 'new-start'
            : 'initial-end';
    const value: GovernanceActivationRevision = {
      ...initial,
      revision: index + 1,
      status,
      previousDigest,
      decisionId,
      generation: second ? 2 : 1,
      activationId: second ? '00000000-0000-4000-8000-000000000002' : initial.activationId,
    };
    fixture.values.set(`${keys.revisions}${String(index + 1).padStart(16, '0')}`, value);
    previousDigest = hashText(canonicalJsonStringify(value));
    fixture.values.set(keys.head, {
      schemaVersion: 1,
      sessionId,
      revision: index + 1,
      digest: previousDigest,
    });
  }
}

describe('durable governance activation authority', () => {
  it.each(['start', 'end'] as const)(
    'detects a digest-valid replayed %s decision in persisted history',
    async (replay) => {
      const fixture = createActivationStoreFixture();
      await seedActiveGovernance(fixture.store, { sessionId, directory: '/project', policyDigest });
      const active = await resolveGovernanceActivation(fixture.store, sessionId);
      if (active.kind !== 'active') throw new Error('Expected active fixture');
      installHistory(fixture, active.record, replay);
      expect(await resolveGovernanceActivation(fixture.store, sessionId)).toMatchObject({
        kind: 'blocked',
        reason: expect.stringContaining('Replayed activation decision'),
      });
    },
  );

  it('passes the exact latest committed revision to authorization without overwriting the enrollment marker', async () => {
    const fixture = createActivationStoreFixture();
    await seedActiveGovernance(fixture.store, { sessionId, directory: '/project', policyDigest });
    const active = await resolveGovernanceActivation(fixture.store, sessionId);
    if (active.kind !== 'active') throw new Error('Expected active fixture');
    const authorize = vi.fn(async () => ({
      kind: 'authorized' as const,
      decisionId: 'end-decision',
    }));
    const marker = fixture.values.get(governanceActivationKeys(sessionId).enrollment);
    const {
      revision: _revision,
      status: _status,
      previousDigest: _previousDigest,
      schemaVersion: _schemaVersion,
      decisionId: _decisionId,
      ...scope
    } = active.record;
    expect(
      await commitGovernanceActivation(
        { ...fixture, authorize },
        { ...scope, action: 'begin_end', expectedRevision: 2 },
      ),
    ).toMatchObject({ kind: 'committed', record: { revision: 3 } });
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 2 }),
      active.record,
    );
    expect(fixture.values.get(governanceActivationKeys(sessionId).enrollment)).toEqual(marker);
  });
  it.each(['sessionId', 'firstActivationId'])(
    'rejects an independently foreign enrollment marker %s',
    async (field) => {
      const fixture = createActivationStoreFixture();
      await seedActiveGovernance(fixture.store, { sessionId, directory: '/project', policyDigest });
      const key = governanceActivationKeys(sessionId).enrollment;
      fixture.values.set(key, {
        ...(fixture.values.get(key) as object),
        [field]: field === 'sessionId' ? 'foreign' : '00000000-0000-4000-8000-000000000002',
      });
      expect(await resolveGovernanceActivation(fixture.store, sessionId)).toMatchObject({
        kind: 'blocked',
        reason: expect.stringContaining('Enrollment marker'),
      });
    },
  );

  it('rejects a corrupt record even if the committed head itself is well formed', async () => {
    const fixture = createActivationStoreFixture();
    await seedActiveGovernance(fixture.store, { sessionId, directory: '/project', policyDigest });
    const key = governanceActivationKeys(sessionId).head;
    fixture.values.set(key, { ...(fixture.values.get(key) as object), digest: 'b'.repeat(64) });
    expect(await resolveGovernanceActivation(fixture.store, sessionId)).toMatchObject({
      kind: 'blocked',
      reason: expect.stringContaining('missing, corrupt'),
    });
  });

  it('rejects a head changed during verification rather than returning a stale snapshot', async () => {
    const fixture = createActivationStoreFixture();
    await seedActiveGovernance(fixture.store, { sessionId, directory: '/project', policyDigest });
    const head = governanceActivationKeys(sessionId).head;
    const get = fixture.store.get;
    let reads = 0;
    fixture.store.get = async (key) => (key === head && ++reads === 2 ? undefined : get(key));
    expect(await resolveGovernanceActivation(fixture.store, sessionId)).toMatchObject({
      kind: 'blocked',
      reason: expect.stringContaining('changed during'),
    });
  });

  it.each(['absent', 'active'])(
    'does not ignore a nonempty revision scan cursor: %s',
    async (mode) => {
      const fixture = createActivationStoreFixture();
      if (mode === 'active')
        await seedActiveGovernance(fixture.store, {
          sessionId,
          directory: '/project',
          policyDigest,
        });
      fixture.store.scan = async () => ({ entries: [], next: 'unread-revisions' });
      expect(await resolveGovernanceActivation(fixture.store, sessionId)).toMatchObject({
        kind: 'blocked',
      });
    },
  );

  it.each([{ revision: 4 }, { status: 'inactive' as const }])(
    'rejects independently invalid but rehashed journal content: %j',
    async (patch) => {
      const fixture = createActivationStoreFixture();
      await seedActiveGovernance(fixture.store, { sessionId, directory: '/project', policyDigest });
      const keys = governanceActivationKeys(sessionId);
      const key = [...fixture.values.keys()]
        .filter((key) => key.startsWith(keys.revisions))
        .sort()[1]!;
      const value = { ...(fixture.values.get(key) as GovernanceActivationRevision), ...patch };
      fixture.values.set(key, value);
      fixture.values.set(keys.head, {
        ...(fixture.values.get(keys.head) as object),
        digest: hashText(canonicalJsonStringify(value)),
      });
      expect(await resolveGovernanceActivation(fixture.store, sessionId)).toMatchObject({
        kind: 'blocked',
      });
    },
  );

  it('keeps revision keys canonical, ordered and independently bound to session and call', async () => {
    const fixture = createActivationStoreFixture();
    await seedActiveGovernance(fixture.store, { sessionId, directory: '/project', policyDigest });
    const keys = governanceActivationKeys(sessionId);
    expect(
      [...fixture.values.keys()].filter((key) => key.startsWith(keys.revisions)).sort(),
    ).toEqual([`${keys.revisions}0000000000000001`, `${keys.revisions}0000000000000002`]);
  });

  it('restores roots across multiple pages, excludes child and inactive heads, and reports corrupt heads', async () => {
    const fixture = createActivationStoreFixture();
    for (const id of ['first', 'second'])
      await seedActiveGovernance(fixture.store, {
        sessionId: id,
        directory: '/project',
        policyDigest,
      });
    const root = await resolveGovernanceActivation(fixture.store, 'first');
    if (root.kind !== 'active') throw new Error('Expected root fixture');
    const {
      revision: _revision,
      status: _status,
      previousDigest: _previousDigest,
      decisionId: _decisionId,
      schemaVersion: _schemaVersion,
      ...scope
    } = root.record;
    await commitGovernanceActivation(
      {
        ...fixture,
        authorize: async () => ({ kind: 'authorized', decisionId: root.record.decisionId }),
      },
      {
        ...scope,
        action: 'enroll',
        expectedRevision: 0,
        sessionId: 'child',
        parentDispatch: { sessionId: 'first', callId: 'call' },
      },
    );
    fixture.values.set('governance/v1/invalid/head', { invalid: true });
    const scan = fixture.store.scan;
    const paged = {
      ...fixture.store,
      scan: async (input: Parameters<typeof scan>[0]) => scan({ ...input, limit: 1 }),
    };
    const result = await listActiveGovernanceRoots(paged);
    expect(result.records.map((record) => record.sessionId).sort()).toEqual(['first', 'second']);
    expect(result.errors).toEqual([
      expect.objectContaining({
        kind: 'blocked',
        reason: expect.stringContaining('stored activation head'),
      }),
    ]);
  });

  it('rejects a valid head stored under another session key', async () => {
    const fixture = createActivationStoreFixture();
    await seedActiveGovernance(fixture.store, { sessionId, directory: '/project', policyDigest });
    fixture.values.set(
      'governance/v1/foreign/head',
      fixture.values.get(governanceActivationKeys(sessionId).head),
    );
    const result = await listActiveGovernanceRoots(fixture.store);
    expect(result.records).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
  });

  it('terminates a repeated restoration cursor and preserves the explicit error', async () => {
    const fixture = createActivationStoreFixture();
    fixture.store.scan = vi.fn(async () => ({ entries: [], next: 'repeated' }));
    const result = await listActiveGovernanceRoots(fixture.store);
    expect(fixture.store.scan).toHaveBeenCalledTimes(2);
    expect(result.errors).toEqual([
      expect.objectContaining({ reason: expect.stringContaining('cursor repeated') }),
    ]);
  });

  it('surfaces non-Error storage failures in both reader and restoration', async () => {
    const fixture = createActivationStoreFixture();
    fixture.store.scan = async () => {
      throw 'storage-unavailable';
    };
    expect(await listActiveGovernanceRoots(fixture.store)).toMatchObject({
      records: [],
      errors: [{ kind: 'blocked', reason: expect.stringContaining('storage-unavailable') }],
    });
    expect(await resolveGovernanceActivation(fixture.store, sessionId)).toMatchObject({
      kind: 'blocked',
      reason: expect.stringContaining('storage-unavailable'),
    });
  });

  it('does not write a schema-invalid authorized request', async () => {
    const fixture = createActivationStoreFixture();
    const writer = {
      ...fixture,
      authorize: async () => ({ kind: 'authorized' as const, decisionId: 'fixture' }),
    };
    expect(
      await commitGovernanceActivation(writer, { ...start(), policyDigest: 'invalid' }),
    ).toMatchObject({
      kind: 'blocked',
      reason: expect.stringContaining('Invalid activation revision input'),
    });
    expect(fixture.values.size).toBe(0);
  });

  it('preserves append-only bytes when a revision appears between preflight and commit', async () => {
    const fixture = createActivationStoreFixture();
    const request = start();
    const key = `${governanceActivationKeys(sessionId).revisions}0000000000000001`;
    const writer = {
      ...fixture,
      authorize: async () => {
        fixture.values.set(key, { preparedByAnotherWriter: true });
        return { kind: 'authorized' as const, decisionId: 'fixture' };
      },
    };
    expect(await commitGovernanceActivation(writer, request)).toMatchObject({
      kind: 'blocked',
      reason: expect.stringContaining('append-only'),
    });
    expect(fixture.values.get(key)).toEqual({ preparedByAnotherWriter: true });
    expect(fixture.values.size).toBe(1);
  });
  it('positively verifies nonenrollment without consulting Git or workflow state', async () => {
    const fixture = createActivationStoreFixture();
    await expect(resolveGovernanceActivation(fixture.store, sessionId)).resolves.toEqual({
      kind: 'inactive',
      record: null,
    });
    expect(fixture.values.size).toBe(0);
  });

  it('binds an explicitly authorized activation and preserves it across reader restarts', async () => {
    const fixture = createActivationStoreFixture();
    await seedActiveGovernance(fixture.store, { sessionId, directory: '/project', policyDigest });
    for (let i = 0; i < 2; i++) {
      expect(await resolveGovernanceActivation({ ...fixture.store }, sessionId)).toMatchObject({
        kind: 'active',
        record: { sessionId, rootSessionId: sessionId, generation: 1, revision: 2, policyDigest },
      });
    }
    expect(await resolveGovernanceActivation(fixture.store, 'unrelated')).toEqual({
      kind: 'inactive',
      record: null,
    });
  });

  it('does not create authority when the operator source is unavailable', async () => {
    const fixture = createActivationStoreFixture();
    const authorize = vi.fn(async () => blocked('HUMAN_DECISION_REQUIRED'));
    const result = await commitGovernanceActivation({ ...fixture, authorize }, start());
    expect(result).toMatchObject({ kind: 'blocked', code: 'HUMAN_DECISION_REQUIRED' });
    expect(fixture.values.size).toBe(0);
  });

  it.each(['head', 'revision', 'history'] as const)(
    'blocks lost formerly-active %s authority after restart instead of declaring INACTIVE',
    async (part) => {
      const fixture = createActivationStoreFixture();
      await seedActiveGovernance(fixture.store, { sessionId, directory: '/project', policyDigest });
      const keys = governanceActivationKeys(sessionId);
      const key =
        part === 'head'
          ? keys.head
          : [...fixture.values.keys()].filter((key) => key.startsWith(keys.revisions)).sort()[
              part === 'revision' ? 1 : 0
            ]!;
      fixture.values.delete(key);
      expect(await resolveGovernanceActivation({ ...fixture.store }, sessionId)).toMatchObject({
        kind: 'blocked',
        code: 'GOVERNANCE_AUTHORITY_BLOCKED',
      });
    },
  );

  it.each(['head', 'record'] as const)('rejects corrupt or foreign %s bytes', async (part) => {
    const fixture = createActivationStoreFixture();
    await seedActiveGovernance(fixture.store, { sessionId, directory: '/project', policyDigest });
    const keys = governanceActivationKeys(sessionId);
    const key =
      part === 'head'
        ? keys.head
        : [...fixture.values.keys()].filter((key) => key.startsWith(keys.revisions)).sort()[1]!;
    fixture.values.set(key, { ...(fixture.values.get(key) as object), sessionId: 'foreign' });
    expect(await resolveGovernanceActivation(fixture.store, sessionId)).toMatchObject({
      kind: 'blocked',
    });
  });

  it('surfaces storage/read/scan failures instead of treating them as absent activation', async () => {
    const fixture = createActivationStoreFixture();
    for (const method of ['get', 'scan'] as const) {
      const store = {
        ...fixture.store,
        [method]: vi.fn().mockRejectedValue(new Error('injected storage failure')),
      };
      expect(await resolveGovernanceActivation(store, sessionId)).toMatchObject({
        kind: 'blocked',
        reason: expect.stringContaining('injected storage failure'),
      });
    }
  });

  it('retains the independent enrollment marker when the entire journal namespace is lost', async () => {
    const fixture = createActivationStoreFixture();
    await seedActiveGovernance(fixture.store, { sessionId, directory: '/project', policyDigest });
    const keys = governanceActivationKeys(sessionId);
    fixture.values.delete(keys.head);
    for (const key of fixture.values.keys())
      if (key.startsWith(keys.revisions)) fixture.values.delete(key);
    expect(await resolveGovernanceActivation({ ...fixture.store }, sessionId)).toMatchObject({
      kind: 'blocked',
    });
  });

  it('does not accept an active journal after its enrollment marker disappears', async () => {
    const fixture = createActivationStoreFixture();
    await seedActiveGovernance(fixture.store, { sessionId, directory: '/project', policyDigest });
    fixture.values.delete(governanceActivationKeys(sessionId).enrollment);
    expect(await resolveGovernanceActivation(fixture.store, sessionId)).toMatchObject({
      kind: 'blocked',
    });
  });

  it('detects a stale head with an orphan future revision instead of reading the older ACTIVE snapshot', async () => {
    const fixture = createActivationStoreFixture();
    await seedActiveGovernance(fixture.store, { sessionId, directory: '/project', policyDigest });
    const keys = governanceActivationKeys(sessionId);
    fixture.values.set(`${keys.revisions}${String(3).padStart(16, '0')}`, { incomplete: true });
    expect(await resolveGovernanceActivation(fixture.store, sessionId)).toMatchObject({
      kind: 'blocked',
    });
  });

  it('retains an incomplete prepare/commit transition as BLOCKED after restart', async () => {
    const fixture = createActivationStoreFixture();
    const set = vi.spyOn(fixture.store, 'set');
    set.mockImplementationOnce(async (key, value) => {
      fixture.values.set(key, structuredClone(value));
    });
    set.mockRejectedValueOnce(new Error('head commit failed'));
    const result = await commitGovernanceActivation(
      {
        ...fixture,
        authorize: async () => ({ kind: 'authorized', decisionId: 'start-ui-fixture' }),
      },
      start(),
    );
    expect(result).toMatchObject({ kind: 'blocked' });
    expect(await resolveGovernanceActivation({ ...fixture.store }, sessionId)).toMatchObject({
      kind: 'blocked',
    });
  });

  it('does not turn finish/abort or stale/replayed activation decisions into deactivation', async () => {
    const fixture = createActivationStoreFixture();
    const request = start();
    const writer = {
      ...fixture,
      authorize: async () => ({ kind: 'authorized' as const, decisionId: 'start-decision' }),
    };
    expect((await commitGovernanceActivation(writer, request)).kind).toBe('committed');
    expect(await resolveGovernanceActivation(fixture.store, sessionId)).toMatchObject({
      kind: 'blocked',
    });
    expect(
      (
        await commitGovernanceActivation(writer, {
          ...request,
          action: 'activate',
          expectedRevision: 1,
        })
      ).kind,
    ).toBe('committed');
    expect(await commitGovernanceActivation(writer, request)).toMatchObject({ kind: 'blocked' });
    expect(
      await commitGovernanceActivation(writer, {
        ...request,
        action: 'begin_end',
        expectedRevision: 2,
      }),
    ).toMatchObject({ kind: 'blocked' });
    expect(await resolveGovernanceActivation(fixture.store, sessionId)).toMatchObject({
      kind: 'active',
    });
  });

  it('requires explicit safe end authorization and retains its tombstone across restart', async () => {
    const fixture = createActivationStoreFixture();
    await seedActiveGovernance(fixture.store, { sessionId, directory: '/project', policyDigest });
    const current = await resolveGovernanceActivation(fixture.store, sessionId);
    if (current.kind !== 'active') throw new Error('fixture not active');
    const request = {
      ...start(),
      activationId: current.record.activationId,
      action: 'begin_end' as const,
      expectedRevision: 2,
    };
    const refuse = {
      ...fixture,
      authorize: async () =>
        blocked('GOVERNANCE_AUTHORITY_BLOCKED', { message: 'unresolved obligations' }),
    };
    expect(await commitGovernanceActivation(refuse, request)).toMatchObject({ kind: 'blocked' });
    const writer = {
      ...fixture,
      authorize: async () => ({ kind: 'authorized' as const, decisionId: 'explicit-end' }),
    };
    expect((await commitGovernanceActivation(writer, request)).kind).toBe('committed');
    expect(await resolveGovernanceActivation(fixture.store, sessionId)).toMatchObject({
      kind: 'blocked',
    });
    expect(
      (await commitGovernanceActivation(writer, { ...request, action: 'end', expectedRevision: 3 }))
        .kind,
    ).toBe('committed');
    expect(await resolveGovernanceActivation({ ...fixture.store }, sessionId)).toMatchObject({
      kind: 'inactive',
      record: { generation: 1, status: 'inactive', revision: 4 },
    });
  });

  it('serializes concurrent starts and rejects the stale loser without overwriting history', async () => {
    const fixture = createActivationStoreFixture();
    const writer = {
      ...fixture,
      authorize: async () => ({ kind: 'authorized' as const, decisionId: randomUUID() }),
    };
    const results = await Promise.all([
      commitGovernanceActivation(writer, start()),
      commitGovernanceActivation(writer, start()),
    ]);
    expect(results.map((result) => result.kind).sort()).toEqual(['blocked', 'committed']);
    expect(fixture.values.size).toBe(3);
  });
});
