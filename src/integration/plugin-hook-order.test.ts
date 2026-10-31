/** Composition contracts only; host provenance is covered at its own boundary. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FlowGuardAuditPlugin } from './plugin.js';
import { REVIEWER_SUBAGENT_TYPE } from '../shared/flowguard-identifiers.js';

const h = vi.hoisted(() => {
  const order: string[] = [];
  const sync = (name: string) =>
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
      beforeTool: sync('fence'),
      onMessage: sync('message'),
      onMessages: sync('context'),
      onParams: sync('params'),
      reconcileOnIdle: asyncCall('idle'),
      reconcileOnTerminalMessage: asyncCall('terminal-message'),
    },
    watchdog: {
      onTaskAuthorized: sync('authorized'),
      onReviewerRequest: asyncCall('reviewer-request'),
      onToolStart: sync('tool-start'),
      onToolEnd: sync('tool-end'),
      onSerializationStart: sync('serialization'),
      finishTask: sync('finish'),
      failTask: vi.fn(async () => {
        order.push('fail');
        return true;
      }),
    },
    cap: asyncCall('cap'),
    before: asyncCall('before'),
    after: asyncCall('after'),
    nativeBefore: asyncCall('native-before'),
    nativeAfter: asyncCall('native-after'),
    isNativeBefore: vi.fn(() => false),
    isNativeAfter: vi.fn(() => false),
    isTerminal: vi.fn(async (..._args: unknown[]) => {
      order.push('is-terminal');
      return true;
    }),
    event: asyncCall('event'),
    command: asyncCall('command'),
    compaction: asyncCall('compaction'),
    disposeLogging: vi.fn(async () => {}),
  };
});

vi.mock('./plugin-workspace.js', () => ({
  createWorkspace: () => ({
    resolveFingerprint: async () => null,
    cachedWsDir: null,
    cachedFingerprint: null,
  }),
}));
vi.mock('./plugin-logging.js', async () => {
  const { DEFAULT_CONFIG } = await import('../config/flowguard-config.js');
  return {
    createPluginLogger: async () => ({
      config: DEFAULT_CONFIG,
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      disposeLogging: h.disposeLogging,
    }),
  };
});
vi.mock('./plugin-beforehooks.js', () => ({ commandBefore: h.command, toolBefore: h.before }));
vi.mock('./plugin-afterhooks.js', () => ({
  toolAfter: h.after,
  handlePluginEvent: h.event,
  handleCompaction: h.compaction,
}));
vi.mock('./review/dispatch/native-task-review.js', () => ({
  isNativeReviewerTaskBefore: h.isNativeBefore,
  isNativeReviewerTaskAfter: h.isNativeAfter,
  nativeReviewTaskBefore: h.nativeBefore,
  nativeReviewTaskAfter: h.nativeAfter,
}));
vi.mock('./reviewer-capture.js', () => ({
  ReviewerCaptureController: class {
    constructor() {
      return h.capture;
    }
  },
}));
vi.mock('./reviewer-output-cap.js', () => ({ createReviewerOutputCapHook: () => h.cap }));
vi.mock('./reviewer-output-cap-failure.js', () => ({
  createReviewerOutputCapFailurePersister: () => vi.fn(),
}));
vi.mock('./reviewer-execution-watchdog.js', () => ({
  createReviewerExecutionWatchdog: () => h.watchdog,
}));
vi.mock('./reviewer-execution-failure.js', () => ({
  createReviewerExecutionFailurePersister: () => vi.fn(),
  createReviewerExecutionTerminalReader: () => h.isTerminal,
}));

type Hooks = Awaited<ReturnType<typeof FlowGuardAuditPlugin>>;
let hooks: Hooks;
const identity = { tool: 'read', sessionID: 'child', callID: 'call-1' };
const result = () => ({ title: '', output: '', metadata: {} });
const failure = new Error('handler failed');

beforeEach(async () => {
  vi.clearAllMocks();
  h.isNativeBefore.mockReturnValue(false);
  h.isNativeAfter.mockReturnValue(false);
  h.isTerminal.mockImplementation(async () => {
    h.order.push('is-terminal');
    return true;
  });
  h.watchdog.failTask.mockImplementation(async () => {
    h.order.push('fail');
    return true;
  });
  hooks = await FlowGuardAuditPlugin({
    directory: '',
    worktree: '',
    client: { app: { agents: async () => ({ data: [] }) }, session: { prompt: async () => ({}) } },
  } as never);
  h.order.length = 0;
});
afterEach(async () => {
  await hooks.dispose?.();
});

describe('single-owner plugin composition', () => {
  it('runs the capture fence before generic governance and starts timing only after admission', async () => {
    await hooks['tool.execute.before']!(identity, { args: {} });
    expect(h.order).toEqual(['fence', 'before', 'tool-start']);
    expect(h.watchdog.onToolStart).toHaveBeenCalledWith('child', 'call-1');
  });

  it('fence denial reaches neither governance nor watchdog authorization', async () => {
    h.capture.beforeTool.mockImplementationOnce(() => {
      h.order.push('fence');
      throw failure;
    });
    await expect(hooks['tool.execute.before']!(identity, { args: {} })).rejects.toBe(failure);
    expect(h.order).toEqual(['fence']);
  });

  it('downstream denial still observes capture contamination but starts no timer', async () => {
    h.before.mockRejectedValueOnce(failure);
    await expect(hooks['tool.execute.before']!(identity, { args: {} })).rejects.toBe(failure);
    expect(h.order).toEqual(['fence']);
    expect(h.before).toHaveBeenCalledOnce();
    expect(h.watchdog.onToolStart).not.toHaveBeenCalled();
  });

  it('authorizes native timing only after native dispatch, bypassing generic governance', async () => {
    h.isNativeBefore.mockReturnValue(true);
    await hooks['tool.execute.before']!(identity, { args: {} });
    expect(h.order).toEqual(['fence', 'native-before', 'authorized']);
    expect(h.watchdog.onTaskAuthorized).toHaveBeenCalledWith('child', 'call-1');
  });

  it('failed native authorization starts no watchdog', async () => {
    h.isNativeBefore.mockReturnValue(true);
    h.nativeBefore.mockRejectedValueOnce(failure);
    await expect(hooks['tool.execute.before']!(identity, { args: {} })).rejects.toBe(failure);
    expect(h.order).toEqual(['fence']);
    expect(h.watchdog.onTaskAuthorized).not.toHaveBeenCalled();
  });

  it.each(['', undefined])('never invents missing dispatch identity %j', async (callID) => {
    h.isNativeBefore.mockReturnValue(true);
    await hooks['tool.execute.before']!({ ...identity, callID } as never, { args: {} });
    expect(h.order).toEqual(['fence', 'native-before']);
  });

  it('orders output cap, reviewer monitoring and final capture observation', async () => {
    await hooks['chat.params']!(
      { sessionID: 'child', agent: REVIEWER_SUBAGENT_TYPE } as never,
      {} as never,
    );
    expect(h.order).toEqual(['cap', 'reviewer-request', 'params']);
  });

  it('leaves other agents outside reviewer request monitoring', async () => {
    await hooks['chat.params']!({ sessionID: 'parent', agent: 'build' } as never, {} as never);
    expect(h.order).toEqual(['cap', 'params']);
  });

  it('output-cap rejection prevents monitoring and successful capture observation', async () => {
    h.cap.mockRejectedValueOnce(failure);
    await expect(
      hooks['chat.params']!({ agent: REVIEWER_SUBAGENT_TYPE } as never, {} as never),
    ).rejects.toBe(failure);
    expect(h.watchdog.onReviewerRequest).not.toHaveBeenCalled();
    expect(h.capture.onParams).not.toHaveBeenCalled();
  });

  it('monitoring failure prevents successful capture observation', async () => {
    h.watchdog.onReviewerRequest.mockRejectedValueOnce(failure);
    await expect(
      hooks['chat.params']!({ agent: REVIEWER_SUBAGENT_TYPE } as never, {} as never),
    ).rejects.toBe(failure);
    expect(h.order).toEqual(['cap']);
    expect(h.capture.onParams).not.toHaveBeenCalled();
  });

  it('generic completion always ends its exact tool timer, including when processing throws', async () => {
    await hooks['tool.execute.after']!({ ...identity, args: {} }, result());
    expect(h.order).toEqual(['after', 'tool-end']);
    h.order.length = 0;
    h.after.mockRejectedValueOnce(failure);
    await expect(hooks['tool.execute.after']!({ ...identity, args: {} }, result())).rejects.toBe(
      failure,
    );
    expect(h.order).toEqual(['tool-end']);
    expect(h.watchdog.onToolEnd).toHaveBeenLastCalledWith('child', 'call-1');
  });

  it('native completion starts serialization before capture and finishes only after terminal proof', async () => {
    h.isNativeAfter.mockReturnValue(true);
    await hooks['tool.execute.after']!(
      { ...identity, args: {} },
      { ...result(), metadata: { sessionId: 'reviewer' } },
    );
    expect(h.order).toEqual(['serialization', 'native-after', 'is-terminal', 'finish']);
    expect(h.watchdog.finishTask).toHaveBeenCalledWith({
      parentSessionId: 'child',
      callId: 'call-1',
      childSessionId: 'reviewer',
    });
    expect(h.after).not.toHaveBeenCalled();
    expect(h.watchdog.onToolEnd).not.toHaveBeenCalled();
  });

  it('absent child identity is not synthesized from the parent', async () => {
    h.isNativeAfter.mockReturnValue(true);
    await hooks['tool.execute.after']!({ ...identity, args: {} }, result());
    expect(h.order).toEqual(['native-after', 'is-terminal', 'finish']);
    expect(h.watchdog.finishTask).toHaveBeenCalledWith({
      parentSessionId: 'child',
      callId: 'call-1',
    });
    expect(Object.hasOwn(h.isTerminal.mock.calls[0]?.[0] as object, 'childSessionId')).toBe(false);
  });

  it.each([undefined, null])(
    'missing metadata %j is not a fabricated child identity',
    async (metadata) => {
      h.isNativeAfter.mockReturnValue(true);
      await hooks['tool.execute.after']!({ ...identity, args: {} }, { ...result(), metadata });
      expect(h.order).toEqual(['native-after', 'is-terminal', 'finish']);
      expect(Object.hasOwn(h.isTerminal.mock.calls[0]?.[0] as object, 'childSessionId')).toBe(
        false,
      );
    },
  );

  it('an empty child ID cannot start serialization monitoring', async () => {
    h.isNativeAfter.mockReturnValue(true);
    await hooks['tool.execute.after']!(
      { ...identity, args: {} },
      { ...result(), metadata: { sessionId: '' } },
    );
    expect(h.order).toEqual(['native-after', 'is-terminal', 'finish']);
    expect(h.watchdog.onSerializationStart).not.toHaveBeenCalled();
  });

  it('missing exact call identity retains monitoring and cannot reach capture or success', async () => {
    h.isNativeAfter.mockReturnValue(true);
    await expect(
      hooks['tool.execute.after']!({ ...identity, callID: '', args: {} }, result()),
    ).rejects.toMatchObject({ code: 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN' });
    expect(h.order).toEqual([]);
    expect(h.watchdog.finishTask).not.toHaveBeenCalled();
  });

  it('capture exceptions settle failure before propagating the original exception', async () => {
    h.isNativeAfter.mockReturnValue(true);
    h.nativeAfter.mockRejectedValueOnce(failure);
    await expect(hooks['tool.execute.after']!({ ...identity, args: {} }, result())).rejects.toBe(
      failure,
    );
    expect(h.order).toEqual(['fail']);
    expect(h.isTerminal).not.toHaveBeenCalled();
    expect(h.watchdog.finishTask).not.toHaveBeenCalled();
  });

  it('terminal-read exceptions are failures, not successful completion', async () => {
    h.isNativeAfter.mockReturnValue(true);
    h.isTerminal.mockRejectedValueOnce(failure);
    await expect(hooks['tool.execute.after']!({ ...identity, args: {} }, result())).rejects.toBe(
      failure,
    );
    expect(h.order).toEqual(['native-after', 'fail']);
    expect(h.watchdog.finishTask).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'nonterminal outcome persists failure; persistence=%j never becomes success',
    async (persisted) => {
      h.isNativeAfter.mockReturnValue(true);
      h.isTerminal.mockImplementation(async () => {
        h.order.push('is-terminal');
        return false;
      });
      h.watchdog.failTask.mockImplementation(async () => {
        h.order.push('fail');
        return persisted;
      });
      const completed = hooks['tool.execute.after']!({ ...identity, args: {} }, result());
      if (persisted) await expect(completed).resolves.toBeUndefined();
      else
        await expect(completed).rejects.toMatchObject({
          code: 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN',
        });
      expect(h.order).toEqual(['native-after', 'is-terminal', 'fail']);
      expect(h.watchdog.finishTask).not.toHaveBeenCalled();
    },
  );

  it.each([
    { type: 'session.idle', properties: { sessionID: 'child' } },
    { type: 'session.status', properties: { sessionID: 'child', status: { type: 'idle' } } },
  ])('dispatches %j before non-awaited reconciliation', async (event) => {
    h.capture.reconcileOnIdle.mockImplementationOnce(() => new Promise<never>(() => {}));
    await hooks.event!({ event } as never);
    expect(h.order).toEqual(['event']);
    expect(h.capture.reconcileOnIdle).toHaveBeenCalledOnce();
  });

  it('terminal-message reconciliation is non-awaited and receives the exact host message', async () => {
    const info = { id: 'message', sessionID: 'child' };
    h.capture.reconcileOnTerminalMessage.mockImplementationOnce(() => new Promise<never>(() => {}));
    await hooks.event!({ event: { type: 'message.updated', properties: { info } } } as never);
    expect(h.order).toEqual(['event']);
    expect(h.capture.reconcileOnTerminalMessage.mock.calls[0]?.[1]).toBe(info);
  });

  it('busy status cannot trigger idle reconciliation', async () => {
    await hooks.event!({
      event: {
        type: 'session.status',
        properties: { sessionID: 'child', status: { type: 'busy' } },
      },
    } as never);
    expect(h.order).toEqual(['event']);
    expect(h.capture.reconcileOnIdle).not.toHaveBeenCalled();
  });

  it('dispatch failure prevents capture reconciliation, preserving the original error', async () => {
    h.event.mockRejectedValueOnce(failure);
    await expect(
      hooks.event!({
        event: { type: 'session.idle', properties: { sessionID: 'child' } },
      } as never),
    ).rejects.toBe(failure);
    expect(h.capture.reconcileOnIdle).not.toHaveBeenCalled();
  });

  it('registers message, context, command and compaction handlers directly', async () => {
    await hooks['chat.message']!({} as never, {} as never);
    await hooks['experimental.chat.messages.transform']!({}, { messages: [] });
    await hooks['command.execute.before']!(
      { command: 'check', sessionID: 'child', arguments: '' },
      { parts: [] },
    );
    await hooks['experimental.session.compacting']!({ sessionID: 'child' }, { context: [] });
    expect(h.order).toEqual(['message', 'context', 'command', 'compaction']);
  });
});
