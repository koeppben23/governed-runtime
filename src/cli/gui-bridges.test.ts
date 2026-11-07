/** Contract-level tests for the two GUI adapters; the runtime has no governance authority. */
import { describe, expect, it, vi } from 'vitest';
import { GUI_RPC_CLIENT_BUNDLE } from '../templates/wrappers/gui-rpc-client-bundle.js';
import { GUI_HOST_BRIDGE_BUNDLE } from '../templates/wrappers/gui-host-bridge-bundle.js';
import type { FlowGuardGuiRpcClient } from '../templates/wrappers/gui-rpc-client-bundle.js';

function rpcClient() {
  const calls: unknown[] = [];
  const session = {
    id: 'session-bound',
    location: { directory: '/workspace/root' },
    server: { client: { rpc: { call: vi.fn(async (input: unknown) => {
      calls.push(input);
      return { output: { kind: 'blocked' } };
    }) } } },
  };
  const factory = new Function('session', GUI_RPC_CLIENT_BUNDLE + '\nreturn flowguardGuiRpcClient(session);');
  const client = factory(session) as FlowGuardGuiRpcClient;
  return { client, calls };
}

describe('Desktop GUI client and host bridges', () => {
  it('binds every RPC to the mounted session and isolates the method names', async () => {
    const { client, calls } = rpcClient();
    await client.getNextAction();
    await client.getWorkbenchReview();
    await client.getWorkbenchDiagnostics();
    await client.submitDecision({
      invocation: '/approve',
      expected: {
        obligationId: 'test-obligation',
        subjectDigest: 'a'.repeat(64),
        reviewCycle: 1,
        iteration: 1,
      },
    });
    expect(calls).toEqual([
      { rpcID: 'flowguard-governance', method: 'GetNextAction',
        location: { directory: '/workspace/root' }, input: { sessionID: 'session-bound' } },
      { rpcID: 'flowguard-governance', method: 'GetWorkbenchReview',
        location: { directory: '/workspace/root' }, input: { sessionID: 'session-bound' } },
      { rpcID: 'flowguard-governance', method: 'GetWorkbenchDiagnostics',
        location: { directory: '/workspace/root' }, input: { sessionID: 'session-bound' } },
      { rpcID: 'flowguard-governance', method: 'SubmitDecision',
        location: { directory: '/workspace/root' },
        input: {
          invocation: '/approve',
          expected: {
            obligationId: 'test-obligation',
            subjectDigest: 'a'.repeat(64),
            reviewCycle: 1,
            iteration: 1,
          },
          sessionID: 'session-bound',
        } },
    ]);
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
        if (module === '@opencode/plugin/gui') return {
          createKeyed: (resolve: () => unknown, setup: (value: unknown) => void) =>
            setup(resolve()),
        };
        if (module === 'solid-js') return { onCleanup };
        throw new Error(module);
      };
      const subscribe = new Function(
        'require', GUI_HOST_BRIDGE_BUNDLE + '\nreturn subscribeFlowGuardSessionCompletion;',
      )(requireStub) as (ctx: unknown, callback: (session: unknown) => void) => boolean;
      const session = { id: 'session-a', server: { id: 'sidecar' } };
      const ctx = {
        sessions: { current: () => session },
        [name]: { get: (id: string) => id === 'sidecar' ? { data: { on } } : null },
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
