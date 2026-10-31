/** HAI and native OpenCode V2 client boundary; no live-host assurance is inferred. */
import { describe, expect, it, vi } from 'vitest';
import { OpenCodeHostAdapter, projectOpenCodeEvent } from '../integration/opencode-host-adapter.js';
import { createV2Host } from '../integration/opencode-v2-test-helpers.js';
import { REQUIRED_INDEPENDENT_REVIEW_TRANSPORT, reviewTransportSatisfies } from './host-adapter.js';
import type { OpenCodeEvent } from '@opencode/client';

function fixture() {
  const host = createV2Host('/worktree');
  const controller = new AbortController();
  return { host, controller, adapter: new OpenCodeHostAdapter(host.ctx, controller.signal) };
}

describe('native V2 host adapter', () => {
  it('accepts the V2 context and advertises interception, not reviewer proof', async () => {
    const { adapter } = fixture();
    await adapter.initialize();
    expect(adapter.platform).toBe('opencode');
    expect(adapter.enforcementLevel).toBe('synchronous');
    expect(adapter.getWorkingDirectory()).toBe('/worktree');
    expect(adapter.getWorktree()).toBe('/worktree');
    expect(adapter.isReviewerSupported()).toBe(false);
    expect(adapter.capabilities.reviewTransports).toEqual([]);
    expect(await adapter.validateCapabilities()).toMatchObject({
      valid: true,
      runtimeVerified: [],
    });
  });

  it.each([
    ['agent', 'list'],
    ['session', 'get'],
    ['session', 'context'],
    ['session', 'interrupt'],
    ['tool', 'hook'],
    ['tool', 'transform'],
    ['session', 'hook'],
    ['event', 'subscribe'],
  ])('fails closed without native %s.%s', async (domain, method) => {
    const { host, adapter } = fixture();
    const ctx = host.ctx as unknown as Record<string, Record<string, unknown>>;
    delete ctx[domain]![method];
    await expect(adapter.initialize()).rejects.toMatchObject({ code: 'HOST_ADAPTER_INIT_FAILED' });
  });

  it('does not expose removed no-op delivery methods', () => {
    const { adapter } = fixture();
    for (const field of ['deliverArgMutation', 'mutateToolResult', 'injectCompactionContext'])
      expect(adapter).not.toHaveProperty(field);
  });

  it('reads the native agent registry without a name alias or process-global cache', async () => {
    const { host, adapter, controller } = fixture();
    expect(await adapter.listAgents('child')).toEqual([{ id: 'flowguard-reviewer' }]);
    expect(host.listAgents).toHaveBeenCalledWith(
      { location: { directory: '/worktree' } },
      { signal: controller.signal },
    );
    await adapter.listAgents('child');
    expect(host.listAgents).toHaveBeenCalledTimes(2);
  });

  it('uses exact native session lookup and actual per-session location', async () => {
    const { host, adapter, controller } = fixture();
    expect(await adapter.getSession('child')).toEqual({
      sessionId: 'child',
      parentSessionId: 'parent',
      directory: '/worktree',
    });
    expect(host.sessionGet).toHaveBeenCalledWith(
      { sessionID: 'child' },
      { signal: controller.signal },
    );
    host.sessionGet.mockResolvedValueOnce({
      id: 'foreign',
      parentID: 'parent',
      location: { directory: '/other' },
    });
    await expect(adapter.getSession('child')).rejects.toMatchObject({
      code: 'HOST_ADAPTER_INIT_FAILED',
    });
  });

  it('passes native history through unchanged, including absence of V1 parentID', async () => {
    const { host, adapter } = fixture();
    const history = [{ type: 'assistant', id: 'response', requestID: 'request', finish: 'stop' }];
    host.sessionContext.mockResolvedValueOnce(history);
    expect(await adapter.readHistory('child')).toBe(history);
    expect(history[0]).not.toHaveProperty('parentID');
  });

  it('requests interruption of only the exact child with resume disabled', async () => {
    const { host, adapter, controller } = fixture();
    expect(await adapter.interrupt('child')).toBe(true);
    expect(host.interrupt).toHaveBeenCalledWith(
      { sessionID: 'child', resume: false },
      { signal: controller.signal },
    );
    host.interrupt.mockResolvedValueOnce({ interrupted: false });
    expect(await adapter.interrupt('child')).toBe(false);
  });

  it.each(['listAgents', 'getSession', 'readHistory', 'interrupt'] as const)(
    'propagates %s host failures',
    async (method) => {
      const { host, adapter } = fixture();
      const error = new Error('native failure');
      const spies = {
        listAgents: host.listAgents,
        getSession: host.sessionGet,
        readHistory: host.sessionContext,
        interrupt: host.interrupt,
      };
      spies[method].mockRejectedValueOnce(error);
      const operation = adapter[method]('child');
      await expect(operation).rejects.toBe(error);
    },
  );

  it('does not equate admission, wait or idle with reviewer provenance or quiescence', async () => {
    const { host, adapter } = fixture();
    expect(await adapter.quiescence('child')).toBe('unknown');
    await expect(adapter.reviewerCall('parent', 'child')).rejects.toMatchObject({
      code: 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN',
    });
    await expect(
      adapter.executeReviewerPrompt({
        sessionId: 'child',
        requestId: 'request',
        agent: 'flowguard-reviewer',
        model: { providerID: 'provider', modelID: 'model', variant: null },
        text: '{}',
      }),
    ).rejects.toMatchObject({ code: 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN' });
    expect(host.prompt).not.toHaveBeenCalled();
  });

  it('delivers synchronous block decisions with the canonical enforcement code', () => {
    const { adapter } = fixture();
    expect(() =>
      adapter.deliverBlockDecision(
        { tool: 'shell', sessionID: 'session', callID: 'call', args: {} },
        {
          blocked: true,
          code: 'PLUGIN_ENFORCEMENT_UNAVAILABLE',
          reason: 'unavailable',
        },
      ),
    ).toThrow(/PLUGIN_ENFORCEMENT_UNAVAILABLE/);
  });

  it('shutdown is idempotent and performs no authority or lease recovery', async () => {
    const { host, adapter } = fixture();
    await adapter.shutdown();
    await adapter.shutdown();
    expect(host.interrupt).not.toHaveBeenCalled();
    expect(host.prompt).not.toHaveBeenCalled();
  });
});

describe('native V2 notification projection', () => {
  it.each(['session.deleted', 'session.idle', 'session.execution.failed', 'session.tool.failed'])(
    'preserves %s identity and data without creating completion proof',
    (type) => {
      const data = {
        sessionID: 'child',
        id: 'call',
        executed: false,
        error: { code: 'failed', message: 'error' },
      };
      const projected = projectOpenCodeEvent({
        id: 'event',
        type,
        data,
      } as unknown as OpenCodeEvent);
      expect(projected).toEqual({
        sessionId: 'child',
        event: { type, data: { ...data, hostEventId: 'event' } },
      });
      expect(projected?.event).not.toHaveProperty('properties');
    },
  );

  it.each([
    'session.execution.succeeded',
    'session.step.ended',
    'message.updated',
    'server.connected',
  ])('does not promote %s into review approval or another event shape', (type) => {
    expect(
      projectOpenCodeEvent({
        type,
        id: 'event',
        data: { sessionID: 'child' },
      } as unknown as OpenCodeEvent),
    ).toBeNull();
  });

  it('retains transport-bound capability checks rather than joining incomplete transports', () => {
    expect(
      reviewTransportSatisfies(
        {
          ...REQUIRED_INDEPENDENT_REVIEW_TRANSPORT,
          kind: 'native_task_message_json',
          assurance: 'unstructured',
          validatedResult: false,
        },
        REQUIRED_INDEPENDENT_REVIEW_TRANSPORT,
      ),
    ).toBe(false);
  });
});
