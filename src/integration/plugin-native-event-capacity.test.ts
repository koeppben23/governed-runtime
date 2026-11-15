/**
 * @module integration/plugin-native-event-capacity.test
 * @description Native stream overload is bounded and globally fail-closed.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE.
 */
import type { Plugin } from '@opencode/plugin';
import type { OpenCodeEvent } from '@opencode/client';
import { describe, expect, it, vi } from 'vitest';
import { createEventFence, startEventLoop, type EventLoopDeps } from './plugin-native-events.js';
import type { OpenCodeGovernance, ActiveGovernanceScope } from './opencode-governance.js';
import type { OpenCodeHostAdapter } from './opencode-host-adapter.js';

function eventAt(index: number, sessionId = 'root'): OpenCodeEvent {
  return {
    id: `progress-${index}`,
    created: index + 1,
    type: 'session.tool.progress',
    data: {
      sessionID: sessionId,
      assistantMessageID: `message-${index}`,
      id: `tool-${index}`,
      metadata: { status: 'running', sessionID: 'child' },
    },
  };
}

function makeHarness(
  count: number,
  observe: (event: OpenCodeEvent) => Promise<void>,
  abortAtEnd = false,
) {
  const controller = new AbortController();
  const subscribe = vi.fn(() =>
    (async function* () {
      for (let i = 0; i < count; i++) yield eventAt(i);
      if (abortAtEnd) controller.abort();
    })(),
  );
  const observeProgress = vi.fn(observe);
  const failPending = vi.fn();
  const log = vi.fn();
  const governance = {
    observeProgress,
    failPending,
  } as unknown as OpenCodeGovernance;
  const adapter = { log } as unknown as OpenCodeHostAdapter;
  const fence = createEventFence(governance, adapter);
  const failed = vi.fn((error: unknown, event?: OpenCodeEvent) => fence.failed(error, event));
  const operations = new Set<Promise<unknown>>();
  const deps = {
    ctx: { event: { subscribe } } as unknown as Plugin.Context,
    signal: controller.signal,
    governance,
    adapter,
    presentation: { clear: vi.fn() },
    failed,
    operations,
    runtimes: new Map(),
    sessionRoots: new Map(),
    invoke: vi.fn(),
  } as unknown as EventLoopDeps;
  return { controller, deps, failed, failPending, fence, observeProgress, operations };
}

describe('native V2 event handler capacity', () => {
  it('HAPPY: consumes a healthy event stream without dropping progress', async () => {
    const h = makeHarness(100, async () => undefined, true);
    await startEventLoop(h.deps);
    expect(h.observeProgress).toHaveBeenCalledTimes(100);
    expect(h.failed).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(h.operations.size).toBe(0));
  });

  it('BAD: overload limits in-flight handlers and globally revokes admission', async () => {
    const release: Array<() => void> = [];
    const h = makeHarness(1_000, () => new Promise<void>((resolve) => release.push(resolve)));
    await startEventLoop(h.deps);

    expect(h.observeProgress).toHaveBeenCalledTimes(256);
    expect(h.operations.size).toBe(256);
    expect(h.failed).toHaveBeenCalledTimes(1);
    expect(h.failed.mock.calls[0]?.[1]).toBeUndefined();
    expect(h.failPending).toHaveBeenCalledOnce();
    expect(h.failPending).toHaveBeenCalledWith('Native event observation failed.', undefined);
    expect(() =>
      h.fence.assert({
        sessionId: 'unrelated-root',
        root: { sessionId: 'unrelated-root' },
      } as ActiveGovernanceScope),
    ).toThrow('PLUGIN_ENFORCEMENT_UNAVAILABLE');

    for (const resolve of release) resolve();
    await Promise.allSettled([...h.operations]);
    await vi.waitFor(() => expect(h.operations.size).toBe(0));
  });

  it('CORNER: exactly at capacity is admitted, not prematurely rejected', async () => {
    const release: Array<() => void> = [];
    const h = makeHarness(256, () => new Promise<void>((resolve) => release.push(resolve)), true);
    await startEventLoop(h.deps);
    expect(h.observeProgress).toHaveBeenCalledTimes(256);
    expect(h.operations.size).toBe(256);
    expect(h.failed).not.toHaveBeenCalled();
    for (const resolve of release) resolve();
    await Promise.allSettled([...h.operations]);
    await vi.waitFor(() => expect(h.operations.size).toBe(0));
  });

  it('EDGE: retiring event hints retains sticky failure latches', () => {
    const h = makeHarness(0, async () => undefined);
    const root = {
      sessionId: 'root',
      root: { sessionId: 'root' },
    } as ActiveGovernanceScope;
    const child = {
      sessionId: 'child',
      root: { sessionId: 'root' },
    } as ActiveGovernanceScope;
    h.fence.assert(root);
    h.fence.assert(child);
    h.fence.forgetSession('child');
    h.fence.failed(new Error('late native event'), eventAt(0, 'child'));
    expect(h.failPending).toHaveBeenCalledWith('Native event observation failed.', 'child');
    // The deleted child's hint is gone: an unrelated root remains admissible.
    expect(() => h.fence.assert(root)).not.toThrow();
    expect(() => h.fence.assert(root)).not.toThrow();
    h.fence.failed(new Error('root stream failed'), eventAt(0));
    h.fence.forgetSession('root');
    expect(() => h.fence.assert(root)).toThrow('PLUGIN_ENFORCEMENT_UNAVAILABLE');
  });

  it('EDGE: a stopped stream never schedules new event handlers', async () => {
    const h = makeHarness(50, async () => undefined);
    h.controller.abort();
    await startEventLoop(h.deps);
    expect(h.observeProgress).not.toHaveBeenCalled();
    expect(h.failed).not.toHaveBeenCalled();
    expect(h.operations.size).toBe(0);
  });
});
