import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ReviewerCaptureController,
  ReviewerCaptureError,
  ReviewerCaptureOutcomeUnknownError,
  completedReviewerModel,
  textOf,
} from './reviewer-capture.js';
import type { OrchestratorClient } from './review/types.js';
import {
  CAPTURE_MODEL,
  CAPTURE_ATTEMPT,
  CAPTURE_OBLIGATION,
  observedPrompt,
  reviewerInputFixture,
} from './reviewer-capture-test-helpers.js';

function fixture() {
  const controller = new ReviewerCaptureController();
  const lease = controller.begin('child', CAPTURE_MODEL, {
    attemptId: CAPTURE_ATTEMPT,
    obligationId: CAPTURE_OBLIGATION,
  });
  const text = 'serialize';
  const messageID = controller.request('child', text);
  const opts = {
    path: { id: 'child' },
    body: {
      messageID,
      model: CAPTURE_MODEL,
      variant: CAPTURE_MODEL.variant,
      agent: 'flowguard-reviewer',
      parts: [{ type: 'text', text }],
    },
  };
  const payload = JSON.stringify(reviewerInputFixture());
  return { controller, opts, payload, lease };
}

function requestContext(h: ReturnType<typeof fixture>) {
  const message: Record<string, unknown> = {
    id: h.opts.body.messageID,
    sessionID: 'child',
    role: 'user',
    agent: 'flowguard-reviewer',
    model: { ...CAPTURE_MODEL },
  };
  return { message, parts: h.opts.body.parts };
}

describe('capture hook identity and execution boundaries', () => {
  it.each([
    'duplicate',
    'id',
    'session',
    'role',
    'agent',
    'prompt',
    'model',
    'provider',
    'variant',
    'synthetic',
    'ignored',
  ])('rejects a %s serialization request and retains the violation', (mismatch) => {
    const h = fixture();
    const output = requestContext(h);
    if (mismatch === 'duplicate') h.controller.onMessage({ sessionID: 'child' }, output);
    if (mismatch === 'id') output.message.id = 'msg_other';
    if (mismatch === 'session') output.message.sessionID = 'another';
    if (mismatch === 'role') output.message.role = 'assistant';
    if (mismatch === 'agent') output.message.agent = 'build';
    if (mismatch === 'prompt') output.parts = [{ type: 'text', text: 'different prompt' }];
    if (mismatch === 'model') output.message.model = { ...CAPTURE_MODEL, modelID: 'other' };
    if (mismatch === 'provider') output.message.model = { ...CAPTURE_MODEL, providerID: 'other' };
    if (mismatch === 'variant') output.message.model = { ...CAPTURE_MODEL, variant: 'low' };
    if (mismatch === 'synthetic' || mismatch === 'ignored')
      Object.assign(output.parts[0]!, { [mismatch]: true });
    expect(() => h.controller.onMessage({ sessionID: 'child' }, output)).toThrow(
      ReviewerCaptureError,
    );
    expect(() => h.controller.request('child', 'try another prompt')).toThrow();
  });

  it.each(['request-missing', 'user-unobserved', 'intervening-assistant', 'mixed-session'])(
    'rejects %s in transform history rather than treating the last response as sufficient',
    (mismatch) => {
      const h = fixture();
      const output = requestContext(h);
      if (mismatch !== 'user-unobserved') h.controller.onMessage({ sessionID: 'child' }, output);
      const messages: unknown[] = [{ info: output.message, parts: output.parts }];
      if (mismatch === 'request-missing') output.message.id = 'msg_other';
      if (mismatch === 'intervening-assistant')
        messages.push({ info: { sessionID: 'child', role: 'assistant' }, parts: [] });
      if (mismatch === 'mixed-session')
        messages.unshift({ info: { sessionID: 'another', role: 'user' }, parts: [] });
      expect(() => h.controller.onMessages({ messages })).toThrow();
      expect(h.controller.isSafe('child')).toBe(false);
    },
  );

  it.each([
    'agent',
    'request-id',
    'provider',
    'model',
    'user-selection',
    'missing-options',
    'bad-options',
    'second-params',
  ])('rejects %s at the prepared model-call boundary', (mismatch) => {
    const h = fixture();
    const output = requestContext(h);
    h.controller.onMessage({ sessionID: 'child' }, output);
    h.controller.onMessages({ messages: [{ info: output.message, parts: output.parts }] });
    const model: { providerID: string; id: string } = {
      providerID: CAPTURE_MODEL.providerID,
      id: CAPTURE_MODEL.modelID,
    };
    const input = {
      sessionID: 'child',
      agent: 'flowguard-reviewer',
      message: output.message,
      model,
    };
    if (mismatch === 'second-params') h.controller.onParams(input, { options: {} });
    if (mismatch === 'agent') input.agent = 'build';
    if (mismatch === 'request-id') input.message.id = 'msg_other';
    if (mismatch === 'provider') input.model.providerID = 'other';
    if (mismatch === 'model') input.model.id = 'other';
    if (mismatch === 'user-selection') input.message.model = { ...CAPTURE_MODEL, variant: 'low' };
    expect(() =>
      h.controller.onParams(
        input,
        mismatch === 'missing-options'
          ? {}
          : { options: mismatch === 'bad-options' ? 'unavailable' : {} },
      ),
    ).toThrow();
    expect(h.controller.isSafe('child')).toBe(false);
  });

  it.each(['none', 'user-only', 'no-params'])(
    'requires all synchronous hooks even if the SDK returns plausible final metadata (%s)',
    (observed) => {
      const h = fixture();
      const output = requestContext(h);
      if (observed !== 'none') h.controller.onMessage({ sessionID: 'child' }, output);
      if (observed === 'no-params')
        h.controller.onMessages({ messages: [{ info: output.message, parts: output.parts }] });
      const info = {
        id: 'msg_plausible',
        parentID: h.opts.body.messageID,
        sessionID: 'child',
        role: 'assistant',
        agent: 'flowguard-reviewer',
        ...CAPTURE_MODEL,
        finish: 'stop',
        time: { completed: 123 },
      };
      expect(() =>
        h.controller.verify(
          'child',
          { info, parts: [{ type: 'text', text: h.payload }] },
          h.payload,
        ),
      ).toThrow();
    },
  );

  it.each(['role', 'length', 'error', 'id-equals-request', 'time'])(
    'never accepts an invalid final response: %s',
    (mismatch) => {
      const h = fixture();
      const response = observedPrompt(h.controller, h.opts, h.payload).data;
      const info = { ...response.info } as Record<string, unknown>;
      if (mismatch === 'role') info.role = 'user';
      if (mismatch === 'length') info.finish = 'length';
      if (mismatch === 'error') info.error = { name: 'MessageAbortedError' };
      if (mismatch === 'id-equals-request') info.id = h.opts.body.messageID;
      if (mismatch === 'time') info.time = {};
      expect(() => h.controller.verify('child', { ...response, info }, h.payload)).toThrow();
    },
  );

  it('never invents a capture scope for an unregistered child', () => {
    const controller = new ReviewerCaptureController();
    expect(() => controller.request('missing', 'serialize')).toThrow();
    expect(() => controller.assertSafe('missing')).toThrow();
    expect(() => controller.verify('missing', {}, '')).toThrow();
    expect(() => controller.onMessages({ messages: [] })).not.toThrow();
  });
});

describe('host model resolution and regular-text framing', () => {
  it('uses the final assistant and its exact own user request, not the first/parent selection', () => {
    const initial = { providerID: 'parent-provider', modelID: 'parent-model', variant: 'low' };
    const messages = [
      { info: { id: 'msg_first', role: 'user', sessionID: 'child', model: initial } },
      {
        info: {
          id: 'msg_old',
          role: 'assistant',
          parentID: 'msg_first',
          sessionID: 'child',
          ...initial,
        },
      },
      { info: { id: 'msg_final_request', role: 'user', sessionID: 'child', model: CAPTURE_MODEL } },
      {
        info: {
          id: 'msg_final',
          role: 'assistant',
          parentID: 'msg_final_request',
          sessionID: 'child',
          ...CAPTURE_MODEL,
        },
      },
    ];
    expect(completedReviewerModel(messages, 'child')).toEqual(CAPTURE_MODEL);
    expect(completedReviewerModel(messages, 'another-child')).toBeNull();
    expect(completedReviewerModel(null, 'child')).toBeNull();
  });

  it.each(['no-assistant', 'no-user', 'wrong-user-role', 'wrong-user-session', 'model-mismatch'])(
    'refuses an incomplete child configuration: %s',
    (mismatch) => {
      const user: Record<string, unknown> = {
        id: 'msg_user',
        role: 'user',
        sessionID: 'child',
        model: CAPTURE_MODEL,
      };
      const assistant = {
        id: 'msg_response',
        role: 'assistant',
        parentID: 'msg_user',
        sessionID: 'child',
        ...CAPTURE_MODEL,
      };
      if (mismatch === 'wrong-user-role') user.role = 'system';
      if (mismatch === 'wrong-user-session') user.sessionID = 'another';
      if (mismatch === 'model-mismatch') user.model = { ...CAPTURE_MODEL, variant: 'low' };
      const data =
        mismatch === 'no-assistant'
          ? [{ info: user }]
          : mismatch === 'no-user'
            ? [{ info: assistant }]
            : [{ info: user }, { info: assistant }];
      expect(completedReviewerModel(data, 'child')).toBeNull();
    },
  );

  it('joins only regular text in one message, excluding reasoning and step metadata', () => {
    expect(
      textOf([
        { type: 'reasoning', text: 'not payload' },
        { type: 'step-start' },
        { type: 'text', text: '{"x":' },
        { type: 'step-finish' },
        { type: 'text', text: '1}' },
      ]),
    ).toBe('{"x":1}');
    expect(textOf([{ type: 'text', text: '{}', ignored: false, synthetic: false }])).toBe('{}');
    expect(textOf([{ type: 'text', text: '{}', ignored: true }])).toBeNull();
    expect(textOf([{ type: 'tool', text: '{}' }])).toBeNull();
    expect(textOf(null)).toBeNull();
  });
});

describe('synchronous reviewer capture fence', () => {
  it('binds exact request, child, model and raw payload', () => {
    const { controller, opts, payload } = fixture();
    const result = observedPrompt(controller, opts, payload);
    expect(controller.verify('child', result.data, payload)).toMatchObject({
      requestMessageId: opts.body.messageID,
      childSessionId: 'child',
      model: CAPTURE_MODEL,
      obligationId: CAPTURE_OBLIGATION,
      attemptId: CAPTURE_ATTEMPT,
    });
  });
  it.each(['parentID', 'sessionID', 'modelID', 'providerID', 'variant', 'finish', 'agent'])(
    'rejects wrong response %s',
    (field) => {
      const { controller, opts, payload } = fixture();
      const result = observedPrompt(controller, opts, payload);
      const info = { ...result.data.info, [field]: 'wrong' };
      expect(() => controller.verify('child', { ...result.data, info }, payload)).toThrow(
        field === 'agent' ? ReviewerCaptureError : ReviewerCaptureOutcomeUnknownError,
      );
    },
  );
  it.each(['read', 'flowguard_observe_repository', 'mcp_read', 'task', 'custom'])(
    'blocks %s before execution and never clears the violation for valid JSON',
    (tool) => {
      const { controller, opts, payload } = fixture();
      const result = observedPrompt(controller, opts, payload);
      expect(() => controller.beforeTool({ sessionID: 'child', tool })).toThrow();
      expect(() => controller.verify('child', result.data, payload)).toThrow();
      expect(controller.isSafe('child')).toBe(false);
    },
  );
  it('rejects a provider-executed tool in the final response', () => {
    const { controller, opts, payload } = fixture();
    const result = observedPrompt(controller, opts, payload);
    expect(() =>
      controller.verify(
        'child',
        {
          ...result.data,
          parts: [{ type: 'tool', metadata: { providerExecuted: true } }, ...result.data.parts],
        },
        payload,
      ),
    ).toThrow();
  });
  it('rejects a second model step and foreign messages', () => {
    const { controller, opts, payload } = fixture();
    observedPrompt(controller, opts, payload);
    expect(() =>
      controller.onMessages({
        messages: [{ info: { sessionID: 'child', id: opts.body.messageID } }],
      }),
    ).toThrow();
  });
  it('fails closed on missing or mixed transform identity', () => {
    const { controller } = fixture();
    expect(() => controller.onMessages({ messages: [] })).toThrow();
    expect(controller.isSafe('child')).toBe(false);
  });
  it('does not mistake unrelated host work for this child', () => {
    const { controller } = fixture();
    controller.onMessages({ messages: [{ info: { sessionID: 'another-child' } }] });
    controller.beforeTool({ sessionID: 'another-child', tool: 'read' });
    expect(controller.isSafe('child')).toBe(true);
  });
  it('releases only the owner lease and never a concurrent operation', () => {
    const controller = new ReviewerCaptureController();
    const lease = controller.begin('child', CAPTURE_MODEL, {
      attemptId: CAPTURE_ATTEMPT,
      obligationId: CAPTURE_OBLIGATION,
    });
    expect(() =>
      controller.begin('child', CAPTURE_MODEL, {
        attemptId: CAPTURE_ATTEMPT,
        obligationId: CAPTURE_OBLIGATION,
      }),
    ).toThrow();
    controller.release('child', 'foreign-lease');
    expect(controller.isSafe('child')).toBe(true);
    controller.release('child', lease);
    expect(controller.isSafe('child')).toBe(false);
    expect(() =>
      controller.begin('child', CAPTURE_MODEL, {
        attemptId: CAPTURE_ATTEMPT,
        obligationId: CAPTURE_OBLIGATION,
      }),
    ).not.toThrow();
  });
  it('retains an unknown-outcome fence after cleanup', () => {
    const { controller } = fixture();
    controller.quarantine('child');
    controller.release('child');
    expect(() =>
      controller.begin('child', CAPTURE_MODEL, {
        attemptId: CAPTURE_ATTEMPT,
        obligationId: CAPTURE_OBLIGATION,
      }),
    ).toThrow();
    expect(() => controller.beforeTool({ sessionID: 'child', tool: 'read' })).toThrow();
  });
});

type HostHistoryEntry = NonNullable<
  Awaited<ReturnType<NonNullable<OrchestratorClient['session']['messages']>>>['data']
>[number];

function quarantineHarness() {
  const h = fixture();
  const response = observedPrompt(h.controller, h.opts, h.payload);
  const history: Array<HostHistoryEntry & { info: NonNullable<HostHistoryEntry['info']> }> = [
    {
      info: { id: h.opts.body.messageID, sessionID: 'child', role: 'user', model: CAPTURE_MODEL },
      parts: h.opts.body.parts,
    },
    response.data,
  ];
  const client: OrchestratorClient = {
    app: { agents: async () => ({ data: [] }) },
    session: {
      prompt: vi.fn(),
      get: vi.fn(async () => ({ data: { id: 'child', parentID: 'parent' } })),
      abort: vi.fn(async () => ({ data: true })),
      status: vi.fn(async () => ({ data: {} })),
      messages: vi.fn(async () => ({ data: history })),
    },
  };
  h.controller.quarantine('child');
  return { ...h, client, history };
}

afterEach(() => vi.useRealTimers());

describe('identity-bound quarantine reconciliation', () => {
  it('requires an acknowledged abort and two stable idle, request-bound histories', async () => {
    const { controller, client, lease } = quarantineHarness();
    controller.release('child', lease);
    expect(controller.isQuarantined('child')).toBe(true);
    expect(await controller.reconcileQuarantine(client, 'child')).toBe(true);
    expect(client.session.get).toHaveBeenCalledWith({ path: { id: 'child' } });
    expect(client.session.abort).toHaveBeenCalledWith({ path: { id: 'child' } });
    expect(client.session.messages).toHaveBeenCalledTimes(2);
    const nextLease = controller.begin('child', CAPTURE_MODEL, {
      attemptId: CAPTURE_ATTEMPT,
      obligationId: CAPTURE_OBLIGATION,
    });
    controller.release('child', lease);
    expect(controller.isSafe('child')).toBe(true);
    controller.release('child', nextLease);
    expect(controller.isSafe('child')).toBe(false);
  });

  it.each(['mixed-prefix', 'duplicate-request', 'request-role', 'prior-running', 'prior-pending'])(
    'rejects independently invalid %s while the final response remains correct',
    async (mismatch) => {
      const { controller, client, history } = quarantineHarness();
      if (mismatch === 'duplicate-request') history.unshift(history[0]!);
      if (mismatch === 'request-role') Object.assign(history[0]!.info, { role: 'assistant' });
      if (mismatch === 'mixed-prefix')
        history.unshift({
          ...history[0]!,
          info: {
            ...history[0]!.info,
            id: 'msg_foreign',
            sessionID: 'another-child',
          },
        });
      if (mismatch === 'prior-running' || mismatch === 'prior-pending') {
        client.session.messages = vi.fn(async () => ({
          data: [
            {
              info: { sessionID: 'child', id: 'msg_previous', role: 'assistant' },
              parts: [
                {
                  type: 'tool',
                  state: { status: mismatch === 'prior-running' ? 'running' : 'pending' },
                },
              ],
            },
            ...history,
          ],
        }));
      }
      expect(await controller.reconcileQuarantine(client, 'child')).toBe(false);
      expect(controller.isQuarantined('child')).toBe(true);
    },
  );

  it.each([
    'completed-tool',
    'error-tool',
    'non-tool-status',
    'explicit-idle',
    'aborted-assistant',
  ])('accepts positively confirmed %s without manufacturing a successful review', async (valid) => {
    const { controller, client, history } = quarantineHarness();
    if (valid === 'explicit-idle')
      client.session.status = vi.fn(async () => ({ data: { child: { type: 'idle' } } }));
    if (valid === 'aborted-assistant')
      Object.assign(history[1]!.info, {
        finish: undefined,
        error: { name: 'MessageAbortedError', data: { message: 'Stopped' } },
      });
    if (valid.includes('tool') || valid === 'non-tool-status')
      client.session.messages = vi.fn(async () => ({
        data: [
          {
            info: { id: 'msg_previous', sessionID: 'child', role: 'assistant' },
            parts: [
              {
                type: valid === 'non-tool-status' ? 'text' : 'tool',
                state: {
                  status:
                    valid === 'completed-tool'
                      ? 'completed'
                      : valid === 'error-tool'
                        ? 'error'
                        : 'pending',
                },
              },
            ],
          },
          ...history,
        ],
      }));
    expect(await controller.reconcileQuarantine(client, 'child')).toBe(true);
    expect(controller.isSafe('child')).toBe(false);
  });

  it.each(['get', 'abort', 'status', 'messages'] as const)(
    'does not send a control request without the %s verification capability',
    async (capability) => {
      const { controller, client } = quarantineHarness();
      const metadata = client.session.get;
      const abort = client.session.abort;
      delete client.session[capability];
      expect(await controller.reconcileQuarantine(client, 'child')).toBe(false);
      expect(metadata).not.toHaveBeenCalled();
      expect(abort).not.toHaveBeenCalled();
    },
  );

  it.each(['metadata-error', 'status-error', 'missing-status', 'array-status'])(
    'does not mistake %s for an idle host',
    async (failure) => {
      const { controller, client } = quarantineHarness();
      if (failure === 'metadata-error')
        client.session.get = vi.fn(async () => ({
          data: { id: 'child' },
          error: 'ambiguous metadata',
        }));
      if (failure === 'status-error')
        client.session.status = vi.fn(async () => ({ data: {}, error: 'unavailable status' }));
      if (failure === 'missing-status') client.session.status = vi.fn(async () => ({}));
      if (failure === 'array-status')
        client.session.status = vi.fn(async () => ({
          data: [] as unknown as Record<string, { type: string }>,
        }));
      expect(await controller.reconcileQuarantine(client, 'child')).toBe(false);
      expect(controller.isQuarantined('child')).toBe(true);
    },
  );

  it.each([
    'busy',
    'retry',
    'abort-refused',
    'abort-error',
    'metadata',
    'missing-capability',
    'history-error',
    'wrong-session',
    'wrong-request',
    'missing-request',
    'running-tool',
    'pending-tool',
    'unfinished',
    'changing-history',
    'throw',
  ])(
    'retains quarantine for %s even when an idle event or owner release is available',
    async (scenario) => {
      const { controller, client, lease, history } = quarantineHarness();
      if (scenario === 'busy' || scenario === 'retry')
        client.session.status = vi.fn(async () => ({ data: { child: { type: scenario } } }));
      if (scenario === 'abort-refused') client.session.abort = vi.fn(async () => ({ data: false }));
      if (scenario === 'abort-error')
        client.session.abort = vi.fn(async () => ({ data: true, error: 'unknown' }));
      if (scenario === 'metadata')
        client.session.get = vi.fn(async () => ({ data: { id: 'another-child' } }));
      if (scenario === 'missing-capability') delete client.session.status;
      if (scenario === 'history-error')
        client.session.messages = vi.fn(async () => ({ data: history, error: 'unreadable' }));
      if (scenario === 'wrong-session') history[1]!.info.sessionID = 'another-child';
      if (scenario === 'wrong-request') Object.assign(history[1]!.info, { parentID: 'msg_other' });
      if (scenario === 'missing-request') history.splice(0, 1);
      if (scenario === 'running-tool' || scenario === 'pending-tool') {
        client.session.messages = vi.fn(async () => ({
          data: [
            ...history,
            {
              info: { sessionID: 'child', role: 'assistant' },
              parts: [
                {
                  type: 'tool',
                  state: { status: scenario === 'running-tool' ? 'running' : 'pending' },
                },
              ],
            },
          ],
        }));
      }
      if (scenario === 'unfinished')
        Object.assign(history[1]!.info, { time: {}, finish: 'tool-calls' });
      if (scenario === 'changing-history')
        vi.mocked(client.session.messages!)
          .mockImplementationOnce(async () => ({ data: history }))
          .mockImplementationOnce(async () => ({
            data: history.map((entry) => ({ ...entry, parts: [] })),
          }));
      if (scenario === 'throw')
        client.session.status = vi.fn(async () => {
          throw new Error('host unavailable');
        });
      expect(await controller.reconcileQuarantine(client, 'child')).toBe(false);
      controller.release('child', lease);
      expect(controller.isQuarantined('child')).toBe(true);
      expect(() => controller.beforeTool({ sessionID: 'child', tool: 'read' })).toThrow();
    },
  );

  it('can retry after a bounded hanging observation, but time alone never unlocks', async () => {
    vi.useFakeTimers();
    const { controller, client, history } = quarantineHarness();
    let resolveOld: ((value: { data: { id: string } }) => void) | undefined;
    client.session.get = vi.fn(
      () =>
        new Promise<{ data: { id: string } }>((resolve) => {
          resolveOld = resolve;
        }),
    );
    const oldProbe = controller.reconcileQuarantine(client, 'child');
    await vi.advanceTimersByTimeAsync(1000);
    expect(await oldProbe).toBe(false);
    expect(controller.isQuarantined('child')).toBe(true);
    client.session.get = vi.fn(async () => ({ data: { id: 'child' } }));
    expect(await controller.reconcileQuarantine(client, 'child')).toBe(true);
    controller.begin('child', CAPTURE_MODEL, {
      attemptId: CAPTURE_ATTEMPT,
      obligationId: CAPTURE_OBLIGATION,
    });
    resolveOld?.({ data: { id: 'child' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.session.abort).toHaveBeenCalledTimes(1);
    expect(controller.isSafe('child')).toBe(true);
    expect(history).toHaveLength(2);
  });

  it('neither reconciles another child nor aborts an active non-quarantined capture', async () => {
    const { controller, client } = quarantineHarness();
    expect(await controller.reconcileQuarantine(client, 'another-child')).toBe(false);
    controller.begin('normal-child', CAPTURE_MODEL, {
      attemptId: CAPTURE_ATTEMPT,
      obligationId: CAPTURE_OBLIGATION,
    });
    expect(await controller.reconcileQuarantine(client, 'normal-child')).toBe(false);
    expect(client.session.abort).not.toHaveBeenCalled();
  });

  it('does not loop abort/idle and can reconcile on a later exact terminal message', async () => {
    const { controller, client, history } = quarantineHarness();
    client.session.status = vi.fn(async () => ({ data: { child: { type: 'busy' } } }));
    expect(await controller.reconcileOnIdle(client, 'child')).toBe(false);
    expect(await controller.reconcileOnIdle(client, 'child')).toBe(false);
    expect(client.session.abort).toHaveBeenCalledTimes(1);
    const terminal = history[1]!.info;
    expect(
      await controller.reconcileOnTerminalMessage(client, { ...terminal, parentID: 'msg_other' }),
    ).toBe(false);
    client.session.status = vi.fn(async () => ({ data: {} }));
    expect(await controller.reconcileOnTerminalMessage(client, terminal)).toBe(true);
    expect(await controller.reconcileOnTerminalMessage(client, terminal)).toBe(false);
    expect(client.session.abort).toHaveBeenCalledTimes(2);
    expect(controller.isQuarantined('child')).toBe(false);
  });

  it('deduplicates the same terminal event while retaining a still-busy quarantine', async () => {
    const { controller, client, history } = quarantineHarness();
    client.session.status = vi.fn(async () => ({ data: { child: { type: 'busy' } } }));
    expect(await controller.reconcileOnTerminalMessage(client, history[1]!.info)).toBe(false);
    expect(await controller.reconcileOnTerminalMessage(client, history[1]!.info)).toBe(false);
    expect(client.session.abort).toHaveBeenCalledTimes(1);
    expect(controller.isQuarantined('child')).toBe(true);
  });

  it('reclaims bounded capacity only after the exact quarantined request is confirmed terminal', async () => {
    const { controller, client } = quarantineHarness();
    for (let index = 0; index < 127; index++) {
      const child = `pending-${index}`;
      controller.begin(child, CAPTURE_MODEL, {
        attemptId: CAPTURE_ATTEMPT,
        obligationId: CAPTURE_OBLIGATION,
      });
      controller.quarantine(child);
    }
    expect(() =>
      controller.begin('overflow', CAPTURE_MODEL, {
        attemptId: CAPTURE_ATTEMPT,
        obligationId: CAPTURE_OBLIGATION,
      }),
    ).toThrow();
    expect(await controller.reconcileQuarantine(client, 'child')).toBe(true);
    expect(() =>
      controller.begin('next-child', CAPTURE_MODEL, {
        attemptId: CAPTURE_ATTEMPT,
        obligationId: CAPTURE_OBLIGATION,
      }),
    ).not.toThrow();
    expect(controller.isQuarantined('pending-0')).toBe(true);
    expect(controller.isQuarantined('pending-126')).toBe(true);
  });
});
