/** Single-owner native composition and ordering, not installed-host proof.
 * Canonical watchdog/capture settlement is tested at its owners; the V2 root
 * must not simulate those observations by wiring obsolete SDK callbacks. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FlowGuardAuditPlugin } from './plugin.js';
import { OpenCodeHostAdapter } from './opencode-host-adapter.js';
import { createV2Host, v2ToolEvent } from './opencode-v2-test-helpers.js';
import { REVIEWER_SUBAGENT_TYPE } from '../shared/flowguard-identifiers.js';
import { makeState } from '../fixtures.js';

const h = vi.hoisted(() => {
  const order: string[] = [];
  const call = (name: string) =>
    vi.fn((..._args: unknown[]) => {
      order.push(name);
    });
  const asyncCall = (name: string) =>
    vi.fn(async (..._args: unknown[]) => {
      order.push(name);
    });
  return {
    order,
    capture: {
      beforeTool: call('fence'),
      onMessage: call('message'),
      onMessages: call('messages'),
      onParams: call('params'),
      reconcileOnIdle: asyncCall('reconcile-idle'),
      reconcileOnTerminalMessage: asyncCall('reconcile-terminal'),
    },
    before: asyncCall('before'),
    after: asyncCall('after'),
    event: asyncCall('event'),
    compaction: asyncCall('compaction'),
    cap: call('cap'),
    dispose: asyncCall('dispose'),
    resolve: vi.fn(),
    watchdog: vi.fn(),
  };
});
vi.mock('../adapters/session-authority.js', () => ({ resolveSessionAuthority: h.resolve }));
vi.mock('./plugin-workspace.js', () => ({
  createWorkspace: () => ({
    resolveFingerprint: async () => 'fingerprint',
    cachedWsDir: null,
    cachedFingerprint: 'fingerprint',
    resolveSessionAuthority: h.resolve,
  }),
}));
vi.mock('./plugin-logging.js', async () => {
  const { DEFAULT_CONFIG } = await import('../config/flowguard-config.js');
  return {
    createPluginLogger: async () => ({
      config: DEFAULT_CONFIG,
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      disposeLogging: h.dispose,
    }),
  };
});
vi.mock('./plugin-beforehooks.js', () => ({ toolBefore: h.before }));
vi.mock('./plugin-afterhooks.js', () => ({
  toolAfter: h.after,
  handlePluginEvent: h.event,
  handleCompaction: h.compaction,
}));
vi.mock('./reviewer-capture.js', () => ({
  ReviewerCaptureController: class {
    constructor() {
      return h.capture;
    }
  },
}));
vi.mock('./reviewer-output-cap.js', () => ({ validateNativeReviewerOutputLimit: h.cap }));
vi.mock('./reviewer-execution-watchdog.js', () => ({
  ReviewerExecutionWatchdog: h.watchdog,
}));

let host: ReturnType<typeof createV2Host>;
let dispose: (() => void | Promise<void>) | undefined;
const failure = new Error('handler failed');
const completion = (patch: Record<string, unknown> = {}) => ({
  ...v2ToolEvent({ tool: 'flowguard_status' }),
  status: 'completed',
  result: { content: '', metadata: {} },
  ...patch,
});

beforeEach(async () => {
  vi.clearAllMocks();
  h.resolve.mockResolvedValue({
    status: 'resolved',
    worktreeRoot: process.cwd(),
    fingerprint: 'fingerprint',
    sessDir: '/session',
    state: makeState('TICKET'),
  });
  host = createV2Host(process.cwd());
  for (const id of ['session', 'child', 'parent'])
    await host.seedActive(id, makeState('TICKET').policySnapshot.hash);
  dispose = (await FlowGuardAuditPlugin.setup(host.ctx)) || undefined;
  h.order.length = 0;
});
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
  vi.restoreAllMocks();
});

describe('single-owner native hook composition', () => {
  it('runs the capture fence before generic governance', async () => {
    await host.before(v2ToolEvent());
    expect(h.order).toEqual(['fence', 'before']);
    expect(h.capture.beforeTool).toHaveBeenCalledExactlyOnceWith({ sessionID: 'session' });
    expect(h.watchdog).not.toHaveBeenCalled();
  });

  it('fence denial reaches neither governance nor dispatch authorization', async () => {
    h.capture.beforeTool.mockImplementationOnce(() => {
      h.order.push('fence');
      throw failure;
    });
    await expect(host.before(v2ToolEvent())).rejects.toBe(failure);
    expect(h.order).toEqual(['fence']);
    expect(h.before).not.toHaveBeenCalled();
  });

  it('generic denial still observes the capture fence and preserves the original exception', async () => {
    h.before.mockImplementationOnce(async () => {
      h.order.push('before');
      throw failure;
    });
    await expect(host.before(v2ToolEvent())).rejects.toBe(failure);
    expect(h.order).toEqual(['fence', 'before']);
    expect(h.watchdog).not.toHaveBeenCalled();
  });

  it('blocks reviewer release after the fence, before any generic or serialization effect', async () => {
    await expect(
      host.before(v2ToolEvent({ tool: 'subagent', input: { agent: REVIEWER_SUBAGENT_TYPE } })),
    ).rejects.toHaveProperty('code', 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN');
    expect(h.order).toEqual(['fence']);
    expect(host.prompt).not.toHaveBeenCalled();
    expect(h.watchdog).not.toHaveBeenCalled();
  });

  it.each(['', undefined])(
    'never manufactures a release identity for an unsupported reviewer call %j',
    async (id) => {
      await expect(
        host.before(
          v2ToolEvent({ id, tool: 'subagent', input: { agent: REVIEWER_SUBAGENT_TYPE } }),
        ),
      ).rejects.toHaveProperty('code', 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN');
      expect(h.order).toEqual(['fence']);
      expect(host.prompt).not.toHaveBeenCalled();
    },
  );

  it('validates reviewer budgeting before refusing unproved context/capture', async () => {
    await expect(
      host.request({ sessionID: 'child', agent: REVIEWER_SUBAGENT_TYPE }),
    ).rejects.toHaveProperty('code', 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN');
    expect(h.order).toEqual(['cap']);
    for (const observe of [h.capture.onMessage, h.capture.onMessages, h.capture.onParams])
      expect(observe).not.toHaveBeenCalled();
  });

  it('leaves other agents outside reviewer budgeting and capture hooks', async () => {
    const event = {
      sessionID: 'parent',
      agent: 'build',
      options: { reasoningEffort: 'custom-native-effort' },
    };
    const original = structuredClone(event);
    await host.request(event);
    expect(event).toEqual(original);
    expect(h.order).toEqual([]);
  });

  it('budget denial cannot reach monitoring or successful capture observation', async () => {
    h.cap.mockImplementationOnce(() => {
      h.order.push('cap');
      throw failure;
    });
    await expect(host.request({ sessionID: 'child', agent: REVIEWER_SUBAGENT_TYPE })).rejects.toBe(
      failure,
    );
    expect(h.order).toEqual(['cap']);
    expect(h.watchdog).not.toHaveBeenCalled();
    expect(h.capture.onParams).not.toHaveBeenCalled();
  });

  it('processes ordinary successful completion exactly once and propagates after-hook errors', async () => {
    await host.after(completion());
    expect(h.order).toEqual(['after']);
    h.order.length = 0;
    h.after.mockImplementationOnce(async () => {
      h.order.push('after');
      throw failure;
    });
    await expect(host.after(completion())).rejects.toBe(failure);
    expect(h.order).toEqual(['after']);
  });

  it('never converts a native error into successful generic completion', async () => {
    await host.after(completion({ status: 'error', error: { type: 'tool', message: 'failed' } }));
    expect(h.after).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    null,
    {},
    { sessionId: '' },
    { sessionId: 'parent' },
    { sessionId: 'plausible-child' },
  ])(
    'does not use native reviewer completion metadata %j as release/capture proof',
    async (metadata) => {
      await expect(
        host.after(
          completion({
            tool: 'subagent',
            input: { agent: REVIEWER_SUBAGENT_TYPE },
            result: { content: '{}', metadata },
          }),
        ),
      ).rejects.toHaveProperty('code', 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN');
      expect(h.order).toEqual([]);
      expect(h.after).not.toHaveBeenCalled();
      expect(host.prompt).not.toHaveBeenCalled();
    },
  );

  it('retains the native result unchanged when reviewer completion is refused', async () => {
    const event = completion({
      tool: 'subagent',
      input: { agent: REVIEWER_SUBAGENT_TYPE },
      result: { content: '{"overallVerdict":"accept"}', metadata: { sessionId: 'child' } },
    });
    const original = structuredClone(event);
    await expect(host.after(event)).rejects.toHaveProperty(
      'code',
      'REVIEWER_EXECUTION_OUTCOME_UNKNOWN',
    );
    expect(event).toEqual(original);
  });

  it.each(['session.idle', 'session.execution.failed', 'session.tool.failed'])(
    'delivers native %s as notification only, never capture settlement',
    async (type) => {
      host.emit({ type, id: 'event', data: { sessionID: 'child', id: 'call' } });
      await vi.waitFor(() => expect(h.event).toHaveBeenCalledOnce());
      expect(h.order).toEqual(['event']);
      expect(h.capture.reconcileOnIdle).not.toHaveBeenCalled();
      expect(h.capture.reconcileOnTerminalMessage).not.toHaveBeenCalled();
    },
  );

  it.each([
    'session.execution.succeeded',
    'session.step.ended',
    'session.status',
    'message.updated',
  ])('does not promote %s into terminal proof or an obsolete callback', async (type) => {
    host.emit({ type, id: 'event', data: { sessionID: 'child' } });
    await dispose!();
    expect(h.event).not.toHaveBeenCalled();
    expect(h.capture.reconcileOnIdle).not.toHaveBeenCalled();
    expect(h.capture.reconcileOnTerminalMessage).not.toHaveBeenCalled();
  });

  it('keeps the subscription alive while a notification handler is in flight and drains it during cleanup', async () => {
    let finish: () => void = () => {};
    h.event.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          h.order.push('event');
          finish = resolve;
        }),
    );
    host.emit({ type: 'session.idle', id: 'idle', data: { sessionID: 'child' } });
    await vi.waitFor(() => expect(h.event).toHaveBeenCalledOnce());
    const stopping = dispose!();
    expect(h.dispose).not.toHaveBeenCalled();
    finish();
    await stopping;
    expect(h.order).toEqual(['event', 'dispose']);
  });

  it('fences subsequent operations after a failed notification handler, without capture recovery', async () => {
    const log = vi.spyOn(OpenCodeHostAdapter.prototype, 'log').mockImplementation(() => {});
    h.event.mockRejectedValueOnce(failure);
    host.emit({ type: 'session.idle', id: 'idle', data: { sessionID: 'child' } });
    await vi.waitFor(() => expect(log).toHaveBeenCalled());
    await expect(host.before(v2ToolEvent({ sessionID: 'child' }))).rejects.toThrow(
      'lost required event observation',
    );
    await expect(host.before(v2ToolEvent())).resolves.toBeUndefined();
    expect(h.capture.reconcileOnIdle).not.toHaveBeenCalled();
  });

  it('registers only current native context/compaction and tool hooks, with no command-origin shim', async () => {
    await host.compact({ sessionID: 'child', system: [], tools: {} });
    expect(h.order).toEqual(['compaction']);
    expect([...host.sessionHooks.keys()]).toEqual(['prompt', 'context', 'compaction', 'generate']);
    expect([...host.toolHooks.keys()]).toEqual(['execute.before', 'execute.after']);
    expect(host.context.command.transform).not.toHaveBeenCalled();
  });
});
