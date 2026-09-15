/**
 * @module integration/review/orchestrator-dispatch-authorization.test
 * @description Blocker 3: the durable dispatch authorization must be persisted
 * BEFORE the host releases `session.prompt`, and every host call that concludes
 * without bound evidence must be resolved as `outcome_unknown`. These tests pin
 * the ordering, the fail-closed authorization failure, and the abandon rules.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetAgentResolutionCache } from './agent-resolution.js';
import { invokeReviewer, type OrchestratorClient } from './orchestrator.js';

const NOW_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function validFindings(): Record<string, unknown> {
  return {
    iteration: 0,
    planVersion: 1,
    reviewMode: 'subagent',
    overallVerdict: 'accept',
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    challenges: [],
    attestation: { toolObligationId: '11111111-1111-4111-8111-111111111111' },
  };
}

function makeClient(session: Partial<OrchestratorClient['session']>): OrchestratorClient {
  return {
    app: { agents: vi.fn().mockResolvedValue({ data: [{ id: 'flowguard-reviewer' }] }) },
    session: {
      create: vi.fn(),
      prompt: vi.fn(),
      ...session,
    } as OrchestratorClient['session'],
  };
}

function makeDispatchHooks(events: string[]) {
  return {
    _authorizeDispatch: vi.fn(async (info: { childSessionId: string; invokedAt: string }) => {
      events.push(`authorize:${info.childSessionId}`);
    }),
    _abandonDispatch: vi.fn(async (info: { childSessionId: string }) => {
      events.push(`abandon:${info.childSessionId}`);
    }),
  };
}

describe('invokeReviewer — durable dispatch authorization ordering', () => {
  const PROMPT = 'Review this plan...';
  const PARENT_ID = 'parent-session-1';
  const sleep = vi.fn(async () => {});

  beforeEach(() => {
    vi.clearAllMocks();
    _resetAgentResolutionCache();
  });

  it('HAPPY: authorizes after session.create and before session.prompt', async () => {
    const events: string[] = [];
    const client = makeClient({
      create: vi.fn(async () => {
        events.push('create:child-1');
        return { data: { id: 'child-1' }, error: undefined } as never;
      }),
      prompt: vi.fn(async () => {
        events.push('prompt:child-1');
        return {
          data: { parts: [], info: { structured: validFindings() } },
          error: undefined,
        } as never;
      }),
    });
    const hooks = makeDispatchHooks(events);

    const result = await invokeReviewer(client, PROMPT, PARENT_ID, {
      ...hooks,
      _sleepFn: sleep,
    });

    expect(result && !result.blocked).toBe(true);
    expect(events).toEqual(['create:child-1', 'authorize:child-1', 'prompt:child-1']);
    expect(hooks._authorizeDispatch).toHaveBeenCalledWith({
      childSessionId: 'child-1',
      invokedAt: expect.stringMatching(NOW_ISO),
    });
    // A successful structured result leaves the entry for the atomic
    // evidence-recording completion — the transport never completes it.
    expect(hooks._abandonDispatch).not.toHaveBeenCalled();
  });

  it('BAD: an authorization failure prevents the prompt and blocks the attempt', async () => {
    const events: string[] = [];
    const client = makeClient({
      create: vi.fn(async () => {
        events.push('create:child-1');
        return { data: { id: 'child-1' }, error: undefined } as never;
      }),
      prompt: vi.fn(async () => {
        events.push('prompt:child-1');
        return { data: { parts: [], info: {} }, error: undefined } as never;
      }),
    });
    const _authorizeDispatch = vi.fn(async () => {
      throw new Error('state write lock unavailable');
    });
    const _abandonDispatch = vi.fn(async () => {});

    const result = await invokeReviewer(client, PROMPT, PARENT_ID, {
      _authorizeDispatch,
      _abandonDispatch,
      _sleepFn: sleep,
    });

    expect(client.session.prompt).not.toHaveBeenCalled();
    expect(events).toEqual(['create:child-1']);
    expect(result && result.blocked).toBe(true);
    if (!result || !result.blocked) throw new Error('expected blocked result');
    expect(result.code).toBe('REVIEW_DISPATCH_PERSISTENCE_FAILED');
    // Nothing was authorized, so nothing may be abandoned.
    expect(_abandonDispatch).not.toHaveBeenCalled();
  });

  it('EDGE: a retried transport failure abandons the first host call and authorizes the next', async () => {
    const events: string[] = [];
    const client = makeClient({
      create: vi
        .fn()
        .mockImplementationOnce(async () => {
          events.push('create:child-1');
          return { data: { id: 'child-1' }, error: undefined };
        })
        .mockImplementationOnce(async () => {
          events.push('create:child-2');
          return { data: { id: 'child-2' }, error: undefined };
        }),
      prompt: vi
        .fn()
        .mockImplementationOnce(async () => {
          events.push('prompt:child-1'); // transport failure, retryable
          return { error: { message: 'rate limited' }, data: undefined } as never;
        })
        .mockImplementationOnce(async () => {
          events.push('prompt:child-2');
          return {
            data: { parts: [], info: { structured: validFindings() } },
            error: undefined,
          } as never;
        }),
    });
    const hooks = makeDispatchHooks(events);

    const result = await invokeReviewer(client, PROMPT, PARENT_ID, {
      ...hooks,
      _sleepFn: sleep,
    });

    expect(result && !result.blocked).toBe(true);
    expect(events).toEqual([
      'create:child-1',
      'authorize:child-1',
      'prompt:child-1',
      'abandon:child-1',
      'create:child-2',
      'authorize:child-2',
      'prompt:child-2',
    ]);
    expect(hooks._abandonDispatch).toHaveBeenCalledTimes(1);
  });

  it('EDGE: a host contract violation abandons the concluded host call', async () => {
    const events: string[] = [];
    const client = makeClient({
      create: vi.fn(async () => ({ data: { id: 'child-1' }, error: undefined }) as never),
      prompt: vi.fn(async () => ({
        data: { parts: [{ type: 'text', text: 'prose without structured output' }], info: {} },
        error: undefined,
      })),
    });
    const hooks = makeDispatchHooks(events);

    const result = await invokeReviewer(client, PROMPT, PARENT_ID, {
      ...hooks,
      _sleepFn: sleep,
    });

    expect(result && result.blocked).toBe(true);
    if (!result || !result.blocked) throw new Error('expected blocked result');
    expect(result.code).toBe('HOST_STRUCTURED_OUTPUT_REQUIRED');
    expect(hooks._abandonDispatch).toHaveBeenCalledTimes(1);
    expect(hooks._abandonDispatch).toHaveBeenCalledWith({ childSessionId: 'child-1' });
  });

  it('CORNER: exhausted transport retries abandon every concluded host call', async () => {
    const events: string[] = [];
    const client = makeClient({
      create: vi.fn(async () => {
        const child = `child-${events.length}`;
        events.push(`create:${child}`);
        return { data: { id: child }, error: undefined } as never;
      }),
      prompt: vi.fn(async () => {
        events.push('prompt-failure');
        return { error: { message: 'rate limited' }, data: undefined } as never;
      }),
    });
    const hooks = makeDispatchHooks(events);

    const result = await invokeReviewer(client, PROMPT, PARENT_ID, {
      ...hooks,
      maxTransportRetries: 1,
      _sleepFn: sleep,
    });

    expect(result).toBeNull();
    expect(hooks._abandonDispatch).toHaveBeenCalledTimes(2);
    expect(hooks._authorizeDispatch).toHaveBeenCalledTimes(2);
  });
});
