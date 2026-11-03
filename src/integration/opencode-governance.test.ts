/** Exact native delegation correlation against real activation persistence.
 * Component authorizations are semantic fixtures, not operator UI evidence. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenCodeEvent } from '@opencode/client';
import { randomUUID } from 'node:crypto';
import { canonicalJsonStringify } from '../shared/canonical-json.js';
import { hashText } from '../shared/hashing.js';
import type { GovernanceActivationRevision } from '../state/governance-activation.js';
import { OpenCodeGovernance } from './opencode-governance.js';
import { OpenCodeHostAdapter } from './opencode-host-adapter.js';
import { createV2Host, v2ToolEvent } from './opencode-v2-test-helpers.js';
import { FIXTURE_ACTIVATION_ACTOR } from '../fixtures/governance-activation.js';
import { createTestWorkspace, type TestWorkspace } from './test-helpers.js';
import {
  governanceActivationKeys,
  governanceDelegationKey,
  commitGovernanceActivation,
  type GovernanceActivationCommit,
  resolveGovernanceActivation,
} from '../adapters/governance-activation.js';

let ws: TestWorkspace;
let host: ReturnType<typeof createV2Host>;
let controller: AbortController;
let governance: OpenCodeGovernance;
const digest = 'a'.repeat(64);
beforeEach(async () => {
  ws = await createTestWorkspace();
  host = createV2Host(ws.tmpDir);
  await host.seedActive('root', digest);
  controller = new AbortController();
  governance = new OpenCodeGovernance(
    host.ctx,
    new OpenCodeHostAdapter(host.ctx, controller.signal),
    controller.signal,
  );
  host.sessionGet.mockImplementation(async ({ sessionID }) => ({
    id: sessionID,
    location: { directory: ws.tmpDir },
    ...(sessionID.startsWith('child') ? { parentID: 'root', agent: 'general' } : {}),
  }));
});
afterEach(async () => {
  controller.abort();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await ws.cleanup();
});

/** Deliberately malformed scope fixtures with valid journal digests; tests must
 * reach scope validation, not accidentally pass at a broken-hash preflight. */
function rewriteScope(sessionId: string, patch: Partial<GovernanceActivationRevision>): void {
  const keys = governanceActivationKeys(sessionId);
  let previousDigest: string | null = null;
  const revisions = [...host.activation.values.keys()]
    .filter((key) => key.startsWith(keys.revisions))
    .sort();
  for (const key of revisions) {
    const value = host.activation.values.get(key) as GovernanceActivationRevision;
    const next = { ...value, ...patch, previousDigest };
    host.activation.values.set(key, next);
    previousDigest = hashText(canonicalJsonStringify(next));
  }
  host.activation.values.set(keys.head, {
    ...(host.activation.values.get(keys.head) as object),
    digest: previousDigest,
  });
  if (patch.activationId)
    host.activation.values.set(keys.enrollment, {
      schemaVersion: 1,
      sessionId,
      firstActivationId: patch.activationId,
    });
}

async function waitForReceiptWaiter(): Promise<void> {
  // No private-map inspection: wait until native resolution has finished its
  // storage I/O and installed the bounded receipt timer.
  await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));
}

function dispatch(id = 'call', extra: Record<string, unknown> = {}) {
  return v2ToolEvent({
    sessionID: 'root',
    id,
    tool: 'subagent',
    input: { agent: 'general', ...extra },
  }) as Parameters<OpenCodeGovernance['authorizeDispatch']>[1];
}
function receipt(child = 'child', patch: Record<string, unknown> = {}) {
  return {
    type: 'session.tool.progress',
    id: 'native-event',
    created: 1,
    data: {
      sessionID: 'root',
      assistantMessageID: 'message',
      id: 'call',
      metadata: { sessionID: child, status: 'running' },
      ...patch,
    },
  } as OpenCodeEvent;
}
async function authorize(event = dispatch()) {
  const root = await governance.resolve('root');
  if (root.kind !== 'active') throw new Error('Expected component root');
  await governance.authorizeDispatch(root.scope, event);
}

async function reopenRoot(): Promise<void> {
  const active = await resolveGovernanceActivation(host.activation.store, 'root');
  if (active.kind !== 'active') throw new Error('Expected active component root');
  const r = active.record;
  const end: GovernanceActivationCommit = {
    action: 'begin_end',
    expectedRevision: r.revision,
    sessionId: r.sessionId,
    rootSessionId: r.rootSessionId,
    activationId: r.activationId,
    generation: r.generation,
    directory: r.directory,
    worktreeRoot: r.worktreeRoot,
    policyDigest: r.policyDigest,
    parentDispatch: null,
  };
  const next: GovernanceActivationCommit = {
    ...end,
    action: 'start',
    expectedRevision: r.revision + 2,
    activationId: randomUUID(),
    generation: r.generation + 1,
  };
  for (const input of [
    end,
    { ...end, action: 'end' as const, expectedRevision: r.revision + 1 },
    next,
    { ...next, action: 'activate' as const, expectedRevision: r.revision + 3 },
  ]) {
    const result = await commitGovernanceActivation(
      {
        ...host.activation,
        authorize: async (request) => ({
          kind: 'authorized',
          source: 'host_command',
          actor: FIXTURE_ACTIVATION_ACTOR,
          decisionId:
            request.action === 'begin_end' || request.action === 'end'
              ? 'component-end'
              : 'component-new-start',
        }),
      },
      input,
    );
    expect(result.kind).toBe('committed');
  }
}

describe('native governance delegation correlation', () => {
  it('rejects a stale scope before runtime admission', async () => {
    const active = await resolveGovernanceActivation(host.activation.store, 'root');
    if (active.kind !== 'active') throw new Error('Expected active root');
    const scope = { sessionId: 'root', record: active.record, root: active.record };
    await expect(governance.assertScopeCurrent('root', scope)).resolves.toBeUndefined();
    await expect(
      governance.assertScopeCurrent('root', {
        ...scope,
        record: { ...scope.record, revision: 1 },
      }),
    ).rejects.toThrow('Activation changed');
    await expect(
      governance.assertScopeCurrent('root', {
        ...scope,
        root: { ...scope.root, revision: 1 },
      }),
    ).rejects.toThrow('Activation changed');
  });

  it.each(['activationId', 'generation', 'agent'])(
    'rejects a changed committed dispatch %s independently',
    async (field) => {
      await authorize();
      await governance.observeProgress(receipt());
      const key = governanceDelegationKey('root', 'message', 'call');
      const replacement = {
        activationId: '00000000-0000-4000-8000-000000000002',
        generation: 2,
        agent: 'explore',
      }[field];
      host.activation.values.set(key, {
        ...(host.activation.values.get(key) as object),
        [field]: replacement,
      });
      expect(await governance.resolve('child')).toMatchObject({
        kind: 'blocked',
        reason: expect.stringContaining('dispatch identity'),
      });
    },
  );

  it.each([
    { activationId: '00000000-0000-4000-8000-000000000002' },
    { generation: 2 },
    { policyDigest: 'b'.repeat(64) },
    { worktreeRoot: '/foreign' },
  ])('rejects independently changed root authority behind an enrolled child: %j', async (patch) => {
    await authorize();
    await governance.observeProgress(receipt());
    if ('generation' in patch) {
      rewriteScope('child', patch);
      const key = governanceDelegationKey('root', 'message', 'call');
      host.activation.values.set(key, {
        ...(host.activation.values.get(key) as object),
        generation: 2,
      });
    } else rewriteScope('root', patch);
    expect(await resolveGovernanceActivation(host.activation.store, 'root')).toMatchObject({
      kind: 'active',
    });
    expect(await governance.resolve('child')).toMatchObject({
      kind: 'blocked',
      reason: expect.stringContaining('stale or foreign'),
    });
  });

  it('rejects a child that changes its native parent after committed enrollment', async () => {
    await authorize();
    await governance.observeProgress(receipt());
    host.sessionGet.mockImplementation(async ({ sessionID }) => ({
      id: sessionID,
      location: { directory: ws.tmpDir },
      parentID: 'foreign',
      agent: 'general',
    }));
    expect(await governance.resolve('child')).toMatchObject({
      kind: 'blocked',
      reason: expect.stringContaining('authorized parent'),
    });
  });

  it('rejects a child claiming another root even when its dispatch agrees with that claim', async () => {
    await authorize();
    await governance.observeProgress(receipt());
    rewriteScope('child', { rootSessionId: 'foreign' });
    const key = governanceDelegationKey('root', 'message', 'call');
    host.activation.values.set(key, {
      ...(host.activation.values.get(key) as object),
      rootSessionId: 'foreign',
    });
    expect(await governance.resolve('child')).toMatchObject({
      kind: 'blocked',
      reason: expect.stringContaining('stale or foreign'),
    });
  });

  it.each([new Set(['root']), new Set(Array.from({ length: 64 }, (_, i) => `ancestor-${i}`))])(
    'bounds ancestry before host I/O: %j',
    async (ancestors) => {
      expect(await governance.resolve('root', ancestors)).toMatchObject({
        kind: 'blocked',
        reason: expect.stringContaining('ancestry'),
      });
      expect(host.sessionGet).not.toHaveBeenCalled();
    },
  );

  it('keeps ordinary unstarted roots and descendants inactive', async () => {
    host.sessionGet.mockImplementation(async ({ sessionID }) => ({
      id: sessionID,
      location: { directory: ws.tmpDir },
      ...(sessionID === 'ordinary-child' ? { parentID: 'ordinary' } : {}),
    }));
    expect(await governance.resolve('ordinary')).toEqual({ kind: 'inactive' });
    expect(await governance.resolve('ordinary-child')).toEqual({ kind: 'inactive' });
  });

  it.each(['activationId', 'generation'])(
    'refuses dispatch from a stale scope snapshot: %s',
    async (field) => {
      const root = await governance.resolve('root');
      if (root.kind !== 'active') throw new Error('Expected root');
      const stale = {
        ...root.scope,
        root: {
          ...root.scope.root,
          ...(field === 'generation'
            ? { generation: 2 }
            : { activationId: '00000000-0000-4000-8000-000000000002' }),
        },
      };
      await expect(governance.authorizeDispatch(stale, dispatch())).rejects.toThrow(
        'Activation changed before',
      );
    },
  );

  it.each(['activationId', 'generation'])(
    'refuses a stale dispatch receipt after root changes: %s',
    async (field) => {
      await authorize();
      rewriteScope(
        'root',
        field === 'generation'
          ? { generation: 2 }
          : { activationId: '00000000-0000-4000-8000-000000000002' },
      );
      await expect(governance.observeProgress(receipt())).rejects.toThrow(
        'stale parent generation',
      );
      expect(await resolveGovernanceActivation(host.activation.store, 'child')).toMatchObject({
        kind: 'inactive',
      });
    },
  );

  it('deduplicates repeated native progress for the same exact call', async () => {
    await authorize();
    const first = governance.observeProgress(receipt());
    expect(governance.observeProgress(receipt())).toBe(first);
    await first;
    expect(await resolveGovernanceActivation(host.activation.store, 'child')).toMatchObject({
      kind: 'active',
      record: { revision: 1 },
    });
    expect(await governance.resolve('child-other')).toMatchObject({
      kind: 'blocked',
      reason: expect.stringContaining('not authorized'),
    });
  });

  it('does not replay an already settled receipt after a later same-agent continuation', async () => {
    await authorize();
    await governance.observeProgress(receipt());
    await authorize(dispatch('next', { sessionID: 'child' }));
    await governance.observeProgress(receipt('child', { id: 'next' }));
    const bytes = structuredClone([...host.activation.values]);
    expect(governance.observeProgress(receipt())).toBeUndefined();
    expect([...host.activation.values]).toEqual(bytes);
    expect(await governance.resolve('child')).toMatchObject({
      kind: 'active',
      scope: { record: { revision: 2, parentDispatch: { callId: 'next' } } },
    });
  });

  it('does not admit a reviewer dispatch even if both host and dispatch select reviewer', async () => {
    await expect(authorize(dispatch('call', { agent: 'flowguard-reviewer' }))).rejects.toThrow(
      'independent-review',
    );
    host.sessionGet.mockImplementation(async ({ sessionID }) => ({
      id: sessionID,
      location: { directory: ws.tmpDir },
      ...(sessionID === 'child' ? { parentID: 'root', agent: 'flowguard-reviewer' } : {}),
    }));
    expect(governance.observeProgress(receipt())).toBeUndefined();
  });

  it.each([
    { activationId: '00000000-0000-4000-8000-000000000002' },
    { rootSessionId: 'foreign' },
    { generation: 2 },
    { parentDispatch: { sessionId: 'foreign', messageId: 'message', callId: 'call' } },
  ])(
    'does not reuse child enrollment replaced between authorization and receipt: %j',
    async (patch) => {
      await authorize();
      await governance.observeProgress(receipt());
      await authorize(dispatch('next', { sessionID: 'child' }));
      rewriteScope('child', patch);
      await expect(governance.observeProgress(receipt('child', { id: 'next' }))).rejects.toThrow(
        'foreign or stale',
      );
    },
  );

  it('waits for a receipt, then releases every child callback and clears its timeout', async () => {
    await authorize();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const first = governance.resolve('child');
    const second = governance.resolve('child');
    await waitForReceiptWaiter();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await governance.observeProgress(receipt());
    expect((await first).kind).toBe('active');
    expect((await second).kind).toBe('active');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for the new continuation receipt rather than reusing the old resolved operation', async () => {
    await authorize();
    await governance.observeProgress(receipt());
    await authorize(dispatch('next', { sessionID: 'child' }));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = governance.resolve('child');
    await waitForReceiptWaiter();
    await governance.observeProgress(receipt('child', { id: 'next' }));
    expect(await pending).toMatchObject({ kind: 'active', scope: { record: { revision: 2 } } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects waiting callbacks on a failed receipt and leaves no timeout or dispatch permission', async () => {
    await authorize();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = governance.resolve('child');
    const rejection = expect(pending).rejects.toThrow('exact enrolled child scope');
    await waitForReceiptWaiter();
    host.sessionGet.mockImplementation(async ({ sessionID }) => ({
      id: sessionID,
      location: { directory: ws.tmpDir },
      ...(sessionID === 'child' ? { parentID: 'foreign', agent: 'general' } : {}),
    }));
    await expect(governance.observeProgress(receipt())).rejects.toThrow(
      'exact enrolled child scope',
    );
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
    host.sessionGet.mockImplementation(async ({ sessionID }) => ({
      id: sessionID,
      location: { directory: ws.tmpDir },
      ...(sessionID.startsWith('child') ? { parentID: 'root', agent: 'general' } : {}),
    }));
    expect(await governance.resolve('child-other')).toMatchObject({
      kind: 'blocked',
      reason: expect.stringContaining('not authorized'),
    });
  });

  it('rejects pending child callbacks on shutdown and clears receipt timers', async () => {
    await authorize();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = governance.resolve('child');
    const rejection = expect(pending).rejects.toThrow('adapter stopped');
    await waitForReceiptWaiter();
    controller.abort();
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('expires an unobserved receipt after the bounded wait without enrolling the child', async () => {
    await authorize();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = governance.resolve('child');
    const rejection = expect(pending).rejects.toThrow('No exact native');
    await waitForReceiptWaiter();
    await vi.advanceTimersByTimeAsync(5_000);
    await rejection;
    expect(await resolveGovernanceActivation(host.activation.store, 'child')).toMatchObject({
      kind: 'inactive',
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never waits for an unenrolled child while reading committed-only authority', async () => {
    await authorize();
    const result = await governance.resolve('child', new Set(), false);
    expect(result).toMatchObject({
      kind: 'blocked',
      reason: expect.stringContaining('no committed enrollment'),
    });
  });

  it('refuses waiting after shutdown even when a dispatch intent remains', async () => {
    await authorize();
    controller.abort();
    await expect(governance.resolve('child')).rejects.toThrow('adapter stopped');
  });

  it('refuses overlapping continuation dispatches before publishing the second intent', async () => {
    await authorize();
    await governance.observeProgress(receipt());
    await authorize(dispatch('first-continuation', { sessionID: 'child' }));
    await expect(
      authorize(dispatch('second-continuation', { sessionID: 'child' })),
    ).rejects.toThrow('unsettled continuation');
    expect(
      host.activation.values.has(governanceDelegationKey('root', 'message', 'second-continuation')),
    ).toBe(false);
  });

  it('rejects ambiguous child authority encountered during enrollment', async () => {
    await authorize();
    host.activation.values.set(governanceActivationKeys('child').enrollment, { corrupted: true });
    await expect(governance.observeProgress(receipt())).rejects.toThrow('ambiguous');
  });

  it('rechecks shutdown at the authorization port after the child lookup finishes', async () => {
    await authorize();
    host.sessionGet.mockImplementation(async ({ sessionID }) => {
      if (sessionID === 'child') controller.abort();
      return {
        id: sessionID,
        location: { directory: ws.tmpDir },
        ...(sessionID === 'child' ? { parentID: 'root', agent: 'general' } : {}),
      };
    });
    await expect(governance.observeProgress(receipt())).rejects.toThrow(
      'Only the observed native delegation',
    );
    expect(await resolveGovernanceActivation(host.activation.store, 'child')).toMatchObject({
      kind: 'inactive',
    });
  });
  it.each(['sessionId', 'messageId', 'callId', 'rootSessionId'])(
    'rejects an enrollment backed by a foreign dispatch %s',
    async (field) => {
      await authorize();
      await governance.observeProgress(receipt());
      const key = governanceDelegationKey('root', 'message', 'call');
      host.activation.values.set(key, {
        ...(host.activation.values.get(key) as object),
        [field]: 'foreign',
      });
      expect(await governance.resolve('child')).toMatchObject({ kind: 'blocked' });
    },
  );
  it('does not infer enrollment merely from host parentID', async () => {
    expect(await governance.resolve('child')).toMatchObject({ kind: 'blocked' });
    expect(await resolveGovernanceActivation(host.activation.store, 'child')).toMatchObject({
      kind: 'inactive',
    });
  });

  it('persists an exact enrollment before releasing a child waiter and restores it without event reconstruction', async () => {
    await authorize();
    const child = governance.resolve('child');
    await governance.observeProgress(receipt());
    expect(await child).toMatchObject({
      kind: 'active',
      scope: {
        root: { sessionId: 'root' },
        record: { parentDispatch: { sessionId: 'root', messageId: 'message', callId: 'call' } },
      },
    });
    const restored = new OpenCodeGovernance(
      host.ctx,
      new OpenCodeHostAdapter(host.ctx, controller.signal),
      controller.signal,
    );
    expect(await restored.resolve('child')).toMatchObject({ kind: 'active' });
  });

  it.each([
    { sessionID: 'other' },
    { id: 'other' },
    { assistantMessageID: 'other' },
    { metadata: { sessionID: 'child', status: 'completed' } },
    { metadata: { status: 'running' } },
  ])('does not use an unrelated or terminal-looking progress event: %j', async (patch) => {
    await authorize();
    expect(governance.observeProgress(receipt('child', patch))).toBeUndefined();
    expect(await resolveGovernanceActivation(host.activation.store, 'child')).toMatchObject({
      kind: 'inactive',
    });
  });

  it('rejects dispatch replay without replacing the original authorization', async () => {
    await authorize();
    const bytes = structuredClone([...host.activation.values]);
    await expect(authorize()).rejects.toThrow('cannot be replayed');
    expect([...host.activation.values]).toEqual(bytes);
  });

  it('treats a provider-reused call ID in a new host assistant message as a distinct dispatch', async () => {
    await authorize();
    await governance.observeProgress(receipt());
    const next = { ...dispatch(), messageID: 'next-message' } as ReturnType<typeof dispatch>;
    await authorize(next);
    expect(
      host.activation.values.has(governanceDelegationKey('root', 'next-message', 'call')),
    ).toBe(true);
    // The original receipt cannot settle the new dispatch, and vice versa.
    expect(governance.observeProgress(receipt('child-two'))).toBeUndefined();
    await governance.observeProgress(receipt('child-two', { assistantMessageID: 'next-message' }));
    expect(await governance.resolve('child-two')).toMatchObject({
      kind: 'active',
      scope: { record: { parentDispatch: { messageId: 'next-message', callId: 'call' } } },
    });
    expect(await governance.resolve('child')).toMatchObject({
      kind: 'active',
      scope: { record: { parentDispatch: { messageId: 'message', callId: 'call' } } },
    });
  });

  it('does not enroll a different requested continuation or a second child for one dispatch', async () => {
    await expect(authorize(dispatch('call', { sessionID: 'child-requested' }))).rejects.toThrow(
      'not verifiably enrolled',
    );
    await authorize();
    const enrollment = governance.observeProgress(receipt());
    await expect(governance.observeProgress(receipt('child-second'))).rejects.toThrow(
      'multiple children',
    );
    await enrollment;
    expect(await resolveGovernanceActivation(host.activation.store, 'child-second')).toMatchObject({
      kind: 'inactive',
    });
  });

  it('refuses a continuation progress receipt naming another child', async () => {
    await authorize();
    await governance.observeProgress(receipt());
    await authorize(dispatch('continue', { sessionID: 'child' }));
    await expect(
      governance.observeProgress(receipt('child-other', { id: 'continue' })),
    ).rejects.toThrow('authorized continuation');
    expect(await resolveGovernanceActivation(host.activation.store, 'child-other')).toMatchObject({
      kind: 'inactive',
    });
  });

  it.each(['parent', 'agent', 'reviewer', 'directory'])(
    'blocks foreign child %s before enrollment',
    async (part) => {
      await authorize();
      host.sessionGet.mockImplementation(async ({ sessionID }) => ({
        id: sessionID,
        location: {
          directory: part === 'directory' && sessionID === 'child' ? '/foreign' : ws.tmpDir,
        },
        ...(sessionID === 'child'
          ? {
              parentID: part === 'parent' ? 'other' : 'root',
              agent:
                part === 'reviewer'
                  ? 'flowguard-reviewer'
                  : part === 'agent'
                    ? 'explore'
                    : 'general',
            }
          : {}),
      }));
      await expect(governance.observeProgress(receipt())).rejects.toThrow(
        'GOVERNANCE_AUTHORITY_BLOCKED',
      );
      expect(await resolveGovernanceActivation(host.activation.store, 'child')).toMatchObject({
        kind: 'inactive',
      });
    },
  );

  it('revalidates a new continuation dispatch rather than reusing a resolved child-only promise', async () => {
    await authorize();
    await governance.observeProgress(receipt());
    await authorize(dispatch('next', { sessionID: 'child' }));
    host.sessionGet.mockImplementation(async ({ sessionID }) => ({
      id: sessionID,
      location: { directory: ws.tmpDir },
      ...(sessionID === 'child' ? { parentID: 'root', agent: 'explore' } : {}),
    }));
    await expect(governance.observeProgress(receipt('child', { id: 'next' }))).rejects.toThrow(
      'agent differs',
    );
  });

  it('accepts a host-native non-reviewer agent change only after its new exact continuation receipt', async () => {
    await authorize();
    await governance.observeProgress(receipt());
    await authorize(dispatch('next', { sessionID: 'child', agent: 'explore' }));
    host.sessionGet.mockImplementation(async ({ sessionID }) => ({
      id: sessionID,
      location: { directory: ws.tmpDir },
      ...(sessionID === 'child' ? { parentID: 'root', agent: 'explore' } : {}),
    }));
    const continued = governance.resolve('child');
    await governance.observeProgress(receipt('child', { id: 'next' }));
    expect(await continued).toMatchObject({
      kind: 'active',
      scope: { record: { revision: 2, parentDispatch: { callId: 'next' } } },
    });
    expect(await governance.resolve('child')).toMatchObject({ kind: 'active' });
  });

  it('does not carry child authority past loss of its root generation', async () => {
    await authorize();
    await governance.observeProgress(receipt());
    host.activation.values.delete(governanceActivationKeys('root').head);
    expect(await governance.resolve('child')).toMatchObject({ kind: 'blocked' });
  });

  it('rejects an old-generation child before continuing it after an explicit root End/restart lifecycle', async () => {
    await authorize();
    await governance.observeProgress(receipt());
    await reopenRoot();
    expect(await governance.resolve('root')).toMatchObject({
      kind: 'active',
      scope: { root: { generation: 2 } },
    });
    expect(await governance.resolve('child')).toMatchObject({ kind: 'blocked' });
    const bytes = structuredClone([...host.activation.values]);
    await expect(authorize(dispatch('stale-continuation', { sessionID: 'child' }))).rejects.toThrow(
      'not verifiably enrolled',
    );
    expect([...host.activation.values]).toEqual(bytes);
  });

  it('does not wait under the root lock for a continuation receipt that requires that same lock', async () => {
    await authorize();
    await governance.observeProgress(receipt());
    const child = await governance.resolve('child');
    if (child.kind !== 'active') throw new Error('Expected enrolled component child');
    await authorize(dispatch('continue', { sessionID: 'child' }));
    const nested = v2ToolEvent({
      sessionID: 'child',
      id: 'nested',
      tool: 'subagent',
      input: { agent: 'general' },
    }) as Parameters<OpenCodeGovernance['authorizeDispatch']>[1];
    await expect(governance.authorizeDispatch(child.scope, nested)).rejects.toThrow(
      'Activation changed before native subagent dispatch',
    );
  });

  it('never reconstructs an unobserved child from durable dispatch intent after adapter restart', async () => {
    await authorize();
    const restored = new OpenCodeGovernance(
      host.ctx,
      new OpenCodeHostAdapter(host.ctx, controller.signal),
      controller.signal,
    );
    expect(restored.observeProgress(receipt())).toBeUndefined();
    expect(await restored.resolve('child')).toMatchObject({ kind: 'blocked' });
  });

  it('stops only the affected scope waiters, without releasing an unrelated child', async () => {
    await authorize();
    const child = governance.resolve('child');
    const failure = expect(child).rejects.toThrow('scoped failure');
    await vi.waitFor(() =>
      expect(host.sessionGet).toHaveBeenCalledWith({ sessionID: 'child' }, expect.anything()),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    governance.failPending('unrelated failure', 'unrelated');
    governance.failPending('scoped failure', 'root');
    await failure;
  });

  it('does not commit enrollment after shutdown', async () => {
    await authorize();
    controller.abort();
    await expect(governance.observeProgress(receipt())).rejects.toThrow('adapter stopped');
    expect(await resolveGovernanceActivation(host.activation.store, 'child')).toMatchObject({
      kind: 'inactive',
    });
  });
});
