/** Contract-level tests for the two GUI adapters; the runtime has no governance authority. */
import { describe, expect, it, vi } from 'vitest';
import { GUI_RPC_CLIENT_BUNDLE } from '../templates/wrappers/gui-rpc-client-bundle.js';
import { GUI_HOST_BRIDGE_BUNDLE } from '../templates/wrappers/gui-host-bridge-bundle.js';
import type { FlowGuardGuiRpcClient } from '../integration/gui-rpc-client-contract.js';

function rpcClient() {
  const calls: unknown[] = [];
  const session = {
    id: 'session-bound',
    location: { directory: '/workspace/root' },
    server: {
      client: {
        rpc: {
          call: vi.fn(async (input: unknown) => {
            calls.push(input);
            return { output: { kind: 'blocked' } };
          }),
        },
      },
    },
  };
  const factory = new Function(
    'session',
    GUI_RPC_CLIENT_BUNDLE + '\nreturn flowguardGuiRpcClient(session);',
  );
  const client = factory(session) as FlowGuardGuiRpcClient;
  return { client, calls };
}

describe('Desktop GUI client and host bridges', () => {
  it('binds every RPC to the mounted session and isolates the method names', async () => {
    const { client, calls } = rpcClient();
    await client.getNextAction();
    await client.getWorkbenchReview();
    await client.getWorkbenchDiagnostics();
    await client.getPresentation('cursor-1');
    await client.submitDecision({
      invocation: '/approve',
      expected: {
        sessionID: 'session-bound',
        activationId: '11111111-1111-4111-8111-111111111111',
        activationGeneration: 1,
        policyDigest: 'p'.repeat(64),
        stateDigest: 's'.repeat(64),
        phase: 'PLAN_REVIEW',
        obligationId: '22222222-2222-4222-8222-222222222222',
        subjectDigest: 'a'.repeat(64),
        reviewType: 'plan',
        reviewCycle: 1,
        iteration: 1,
      },
    });
    expect(calls).toEqual([
      {
        rpcID: 'flowguard-governance',
        method: 'GetNextAction',
        location: { directory: '/workspace/root' },
        input: { sessionID: 'session-bound' },
      },
      {
        rpcID: 'flowguard-governance',
        method: 'GetWorkbenchReview',
        location: { directory: '/workspace/root' },
        input: { sessionID: 'session-bound' },
      },
      {
        rpcID: 'flowguard-governance',
        method: 'GetWorkbenchDiagnostics',
        location: { directory: '/workspace/root' },
        input: { sessionID: 'session-bound' },
      },
      {
        rpcID: 'flowguard-governance',
        method: 'GetPresentation',
        location: { directory: '/workspace/root' },
        input: { sessionID: 'session-bound', after: 'cursor-1' },
      },
      {
        rpcID: 'flowguard-governance',
        method: 'SubmitDecision',
        location: { directory: '/workspace/root' },
        input: {
          invocation: '/approve',
          expected: {
            sessionID: 'session-bound',
            activationId: '11111111-1111-4111-8111-111111111111',
            activationGeneration: 1,
            policyDigest: 'p'.repeat(64),
            stateDigest: 's'.repeat(64),
            phase: 'PLAN_REVIEW',
            obligationId: '22222222-2222-4222-8222-222222222222',
            subjectDigest: 'a'.repeat(64),
            reviewType: 'plan',
            reviewCycle: 1,
            iteration: 1,
          },
          sessionID: 'session-bound',
        },
      },
    ]);
  });

  it('reconciles only visible current sidecar sessions and releases its timer', () => {
    const ticks: Array<() => void> = [];
    const clear = vi.fn();
    const schedule = vi.fn((callback: () => void, period: number) => {
      expect(period).toBe(30_000);
      ticks.push(callback);
      return 7;
    });
    const factory = new Function(
      'setInterval',
      'clearInterval',
      'document',
      GUI_HOST_BRIDGE_BUNDLE + '\nreturn createFlowGuardStatusReconciler;',
    );
    const visibility = { visibilityState: 'visible' };
    let current = { id: 'session-a', server: { id: 'sidecar' } };
    const notify = vi.fn();
    const create = factory(schedule, clear, visibility) as (
      context: unknown,
      callback: (session: unknown) => void,
    ) => { begin(): void; stop(): void };
    const controller = create({ sessions: { current: () => current } }, notify);
    expect(schedule).not.toHaveBeenCalled();
    controller.begin();
    controller.begin();
    expect(schedule).toHaveBeenCalledTimes(1);
    visibility.visibilityState = 'hidden';
    ticks[0]?.();
    expect(notify).not.toHaveBeenCalled();
    visibility.visibilityState = 'visible';
    current = { id: 'session-a', server: { id: 'remote' } };
    ticks[0]?.();
    expect(notify).not.toHaveBeenCalled();
    current = { id: 'session-a', server: { id: 'sidecar' } };
    ticks[0]?.();
    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(current);
    controller.stop();
    ticks[0]?.();
    expect(notify).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledWith(7);
    controller.begin();
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it('polls only visible sidecar presentation pages and announces one baseline event', async () => {
    const event = (id: string, sessionID = 'session-a') => ({
      id,
      sessionID,
      kind: 'notice',
      message: id,
      occurredAt: '2026-11-12T00:00:00.000Z',
    });
    const ticks: Array<() => void> = [];
    const clear = vi.fn();
    const schedule = vi.fn((callback: () => void, period: number) => {
      expect(period).toBe(1_000);
      ticks.push(callback);
      return 9;
    });
    const visibility = { visibilityState: 'visible' };
    const factory = new Function(
      'setInterval',
      'clearInterval',
      'document',
      GUI_HOST_BRIDGE_BUNDLE + '\nreturn createFlowGuardPresentationWatcher;',
    );
    const pages = [
      { events: [event('one'), event('two')], cursor: 'two' },
      { events: [event('two'), event('three')], cursor: 'three' },
    ];
    const getPresentation = vi.fn(async () => pages.shift() ?? { events: [], cursor: null });
    const notify = vi.fn();
    let current = { id: 'session-a', server: { id: 'sidecar' } };
    const create = factory(schedule, clear, visibility) as (
      context: unknown,
      get: (
        session: unknown,
        after: string | null,
      ) => Promise<{
        events: Array<ReturnType<typeof event>>;
        cursor: string | null;
      }>,
      callback: (value: ReturnType<typeof event>) => void,
    ) => { start(): void; stop(): void };
    const watcher = create({ sessions: { current: () => current } }, getPresentation, notify);
    watcher.start();
    expect(schedule).toHaveBeenCalledOnce();

    ticks[0]?.();
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ id: 'two' }));
    ticks[0]?.();
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(2));
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'three' }));

    visibility.visibilityState = 'hidden';
    ticks[0]?.();
    expect(getPresentation).toHaveBeenCalledTimes(2);
    visibility.visibilityState = 'visible';
    current = { id: 'session-b', server: { id: 'sidecar' } };
    pages.push({ events: [event('b1', 'session-b')], cursor: 'b1' });
    ticks[0]?.();
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(3));
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'b1' }));

    watcher.stop();
    ticks[0]?.();
    expect(getPresentation).toHaveBeenCalledTimes(3);
    expect(clear).toHaveBeenCalledWith(9);
  });

  it.each(['serverEndpoints', 'servers'])(
    'subscribes to the supported %s lookup, with no foreign-session callback',
    (name) => {
      const subscriptions = new Map<string, (event: unknown) => void>();
      const cleanup = vi.fn();
      const on = vi.fn((event: string, callback: (event: unknown) => void) => {
        subscriptions.set(event, callback);
        return cleanup;
      });
      const onCleanup = vi.fn((handler: () => void) => handler());
      const requireStub = (module: string) => {
        if (module === '@opencode/plugin/gui')
          return {
            createKeyed: (resolve: () => unknown, setup: (value: unknown) => void) =>
              setup(resolve()),
          };
        if (module === 'solid-js') return { onCleanup };
        throw new Error(module);
      };
      const subscribe = new Function(
        'require',
        GUI_HOST_BRIDGE_BUNDLE + '\nreturn subscribeFlowGuardSessionCompletion;',
      )(requireStub) as (ctx: unknown, callback: (session: unknown) => void) => boolean;
      const session = { id: 'session-a', server: { id: 'sidecar' } };
      const ctx = {
        sessions: { current: () => session },
        [name]: { get: (id: string) => (id === 'sidecar' ? { data: { on } } : null) },
      };
      const handler = vi.fn();
      expect(subscribe(ctx, handler)).toBe(true);
      expect(on).toHaveBeenCalledWith('session.execution.succeeded', expect.any(Function));
      subscriptions.get('session.execution.succeeded')?.({ data: { sessionID: 'other' } });
      expect(handler).not.toHaveBeenCalled();
      session.server.id = 'remote';
      subscriptions.get('session.execution.succeeded')?.({ data: { sessionID: 'session-a' } });
      expect(handler).not.toHaveBeenCalled();
      session.server.id = 'sidecar';
      subscriptions.get('session.execution.succeeded')?.({ data: { sessionID: 'session-a' } });
      expect(handler).toHaveBeenCalledExactlyOnceWith(session);
      expect(onCleanup).toHaveBeenCalledWith(cleanup);
    },
  );
});
