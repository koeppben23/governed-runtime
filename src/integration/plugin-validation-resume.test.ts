/** Composition admission only. Native subprocess/persistence proof lives in the smoke suite. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FlowGuardAuditPlugin } from './plugin.js';
import { OpenCodeGovernance } from './opencode-governance.js';
import { OpenCodeHostAdapter } from './opencode-host-adapter.js';
import { createV2Host, v2ToolEvent } from './opencode-v2-test-helpers.js';
import { createTestWorkspace, canonicalBinding } from './test-helpers.js';
import { makeState } from '../fixtures.js';
import { writeState } from '../adapters/persistence.js';
import { sessionDir } from '../adapters/workspace/index.js';
import * as validation from './tools/auto-validation.js';
import * as afterhooks from './plugin-afterhooks.js';
import * as activation from '../adapters/governance-activation.js';
import { dispatchEvent } from './plugin-native-events.js';

const disposers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  try {
    for (const dispose of disposers.splice(0).reverse()) await dispose();
  } finally {
    vi.restoreAllMocks();
  }
});
async function fixture() {
  const ws = await createTestWorkspace();
  disposers.push(ws.cleanup);
  const host = createV2Host(ws.tmpDir);
  const binding = await canonicalBinding(ws.tmpDir, 'root');
  const state = makeState('TICKET', { binding });
  await writeState(sessionDir(binding.fingerprint, 'root'), state);
  await host.seedActive('root', state.policySnapshot.hash);
  host.sessionGet.mockImplementation(async ({ sessionID }) => ({
    id: sessionID,
    location: { directory: ws.tmpDir },
    outcome: 'succeeded',
    time: { busy: 90, idle: 100 },
  }));
  const resume = vi
    .spyOn(validation, 'resumePendingSystemWork')
    .mockResolvedValue({ kind: 'none' });
  const claim = vi.spyOn(OpenCodeHostAdapter.prototype, 'claimSuccessfulExecutionWakeup');
  const dispose = await FlowGuardAuditPlugin.setup(host.ctx);
  if (dispose) disposers.push(dispose);
  return { host, resume, claim };
}
function success(sessionID = 'root') {
  return {
    type: 'session.execution.succeeded',
    id: 'success',
    created: 100,
    durable: { aggregateID: sessionID, seq: 1, version: 1 },
    data: { sessionID },
  };
}
describe('native success to canonical system-work composition', () => {
  it('fences the ACTIVE root on native admission read failure without blocking unrelated sessions', async () => {
    const { host, claim, resume } = await fixture();
    const diagnostic = vi.spyOn(OpenCodeHostAdapter.prototype, 'log').mockImplementation(() => {});
    claim.mockRejectedValueOnce(new Error('Native completion read failed'));
    host.emit(success());
    await vi.waitFor(() =>
      expect(diagnostic).toHaveBeenCalledWith(
        'error',
        'V2 event stream unavailable',
        expect.anything(),
      ),
    );
    expect(resume).not.toHaveBeenCalled();
    await expect(host.before(v2ToolEvent({ sessionID: 'root' }))).rejects.toHaveProperty(
      'code',
      'PLUGIN_ENFORCEMENT_UNAVAILABLE',
    );
    await expect(host.before(v2ToolEvent({ sessionID: 'unrelated' }))).resolves.toBeUndefined();
  });
  it.each(['root', 'delegated'] as const)(
    'retains %s deletion scope and releases only its native metadata',
    async (kind) => {
      const { host } = await fixture();
      const handler = vi.spyOn(afterhooks, 'handlePluginEvent').mockResolvedValue(undefined);
      host.emit(success());
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
      const runtime = handler.mock.calls[0]![0];
      handler.mockClear();
      const controller = new AbortController();
      const adapter = new OpenCodeHostAdapter(host.ctx, controller.signal);
      const governance = new OpenCodeGovernance(host.ctx, adapter, controller.signal);
      const resolution = await activation.resolveGovernanceActivation(
        host.activation.store,
        'root',
      );
      if (resolution.kind !== 'active') throw new Error('Missing root activation');
      // Explicit active delegated-record port fixture, not enrollment provenance.
      const sessionId = kind === 'root' ? 'root' : 'child';
      vi.spyOn(activation, 'resolveGovernanceActivation').mockResolvedValue({
        kind: 'active',
        record: { ...resolution.record, sessionId, rootSessionId: 'root' },
      });
      const sessionRoots = new Map([
        ['root', 'worktree'],
        ['child', 'worktree'],
      ]);
      const deps = {
        adapter,
        governance,
        sessionRoots,
        runtimes: new Map([['worktree', Promise.resolve({ runtime })]]),
        invoke: async () => undefined,
      };
      const forget = vi.spyOn(adapter, 'forgetSession');
      const event = {
        type: 'session.deleted' as const,
        id: 'deleted',
        created: 101,
        durable: { aggregateID: sessionId, seq: 2, version: 2 as const },
        data: { sessionID: sessionId },
      };
      await dispatchEvent(event, deps);
      await dispatchEvent(event, deps);
      expect(forget).toHaveBeenCalledTimes(2);
      expect(forget).toHaveBeenCalledWith(sessionId);
      expect(sessionRoots.has(sessionId)).toBe(false);
      expect(handler).toHaveBeenCalledTimes(kind === 'root' ? 1 : 0);
      if (kind === 'delegated') expect(sessionRoots.has('root')).toBe(true);
      controller.abort();
    },
  );
  it('routes one admitted root notification through the timestamped canonical resume path', async () => {
    const { host, resume, claim } = await fixture();
    host.emit(success());
    host.emit(success());
    await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(claim).toHaveBeenCalledTimes(2));
    // Drain the event queue and all registered operations before the final count.
    await disposers.pop()?.();
    expect(resume).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionID: 'root' }),
      undefined,
      100,
    );
  });
  it('does not claim an unrelated inactive session notification', async () => {
    const { host, resume, claim } = await fixture();
    host.emit(success('unrelated'));
    host.emit(success()); // deterministic queue barrier
    await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
    await disposers.pop()?.();
    expect(claim).toHaveBeenCalledExactlyOnceWith(success());
    expect(resume.mock.calls[0]![0].sessionID).toBe('root');
  });
  it('does not promote even an admitted delegated scope to a root completion', async () => {
    const { host, resume, claim } = await fixture();
    // Explicit scoped-port fixture, not native delegation/reviewer evidence.
    const resolve = OpenCodeGovernance.prototype.resolve;
    vi.spyOn(OpenCodeGovernance.prototype, 'resolve').mockImplementation(async function (
      this: OpenCodeGovernance,
      sessionId,
      ...args
    ) {
      if (sessionId !== 'child') return resolve.call(this, sessionId, ...args);
      const root = await resolve.call(this, 'root', ...args);
      if (root.kind !== 'active') throw new Error('Missing fixture scope');
      return { kind: 'active', scope: { ...root.scope, sessionId: 'child' } };
    });
    host.emit(success('child'));
    host.emit(success());
    await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
    await disposers.pop()?.();
    expect(claim).toHaveBeenCalledExactlyOnceWith(success());
    expect(resume.mock.calls[0]![0].sessionID).toBe('root');
  });
});
