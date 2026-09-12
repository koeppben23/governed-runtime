/**
 * @module integration/review/orchestrator-timeout.test
 * @description Reviewer prompt timeout and orphan containment.
 *
 * F-13: an unresponsive host must not hang the review loop. The prompt is raced
 * against a bound, the attempt is classified as a retryable timeout, and the
 * child session is aborted best-effort.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 * @version v1
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetAgentResolutionCache } from './agent-resolution.js';
import { invokeReviewer, type OrchestratorClient } from './orchestrator.js';

function clientWith(session: OrchestratorClient['session']): OrchestratorClient {
  return {
    app: { agents: vi.fn().mockResolvedValue({ data: [{ id: 'flowguard-reviewer' }] }) },
    session,
  };
}

const neverResolving = () => new Promise<never>(() => {});

describe('invokeReviewer — prompt timeout and orphan containment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetAgentResolutionCache();
  });

  it('HAPPY: classifies an unresponsive prompt as a retryable timeout and aborts the child', async () => {
    const abort = vi.fn().mockResolvedValue({ data: true });
    const client = clientWith({
      create: vi.fn().mockResolvedValue({ data: { id: 'child-1' } }),
      prompt: vi.fn().mockImplementation(neverResolving),
      abort,
    } as unknown as OrchestratorClient['session']);
    const onFailed = vi.fn();

    const result = await invokeReviewer(client, 'prompt', 'parent-1', {
      reviewInvocationPolicy: 'sdk_allowed',
      maxRetries: 0,
      promptTimeoutMs: 5,
      _sleepFn: vi.fn().mockResolvedValue(undefined),
      _onAttemptFailed: onFailed,
    });

    expect(result).toBeNull();
    expect(abort).toHaveBeenCalledWith({ path: { id: 'child-1' } });
    expect(onFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        step: 'session_prompt',
        error: expect.objectContaining({
          code: 'REVIEWER_PROMPT_TIMEOUT',
          isRetryable: true,
        }),
      }),
    );
  });

  it('BAD: keeps the timeout classification when abort is unsupported or fails', async () => {
    const client = clientWith({
      create: vi.fn().mockResolvedValue({ data: { id: 'child-2' } }),
      prompt: vi.fn().mockImplementation(neverResolving),
      abort: vi.fn().mockRejectedValue(new Error('abort unsupported')),
    } as unknown as OrchestratorClient['session']);

    const result = await invokeReviewer(client, 'prompt', 'parent-1', {
      reviewInvocationPolicy: 'sdk_allowed',
      maxRetries: 0,
      promptTimeoutMs: 5,
      _sleepFn: vi.fn().mockResolvedValue(undefined),
    });

    expect(result).toBeNull();
    expect(client.session.abort).toHaveBeenCalledTimes(1);
  });

  it('CORNER: retries a timed-out attempt within the retry budget', async () => {
    let createCalls = 0;
    const client = clientWith({
      create: vi.fn().mockImplementation(async () => ({ data: { id: `child-${++createCalls}` } })),
      prompt: vi.fn().mockImplementation(neverResolving),
    } as unknown as OrchestratorClient['session']);

    const result = await invokeReviewer(client, 'prompt', 'parent-1', {
      reviewInvocationPolicy: 'sdk_allowed',
      maxRetries: 1,
      promptTimeoutMs: 5,
      _sleepFn: vi.fn().mockResolvedValue(undefined),
    });

    expect(result).toBeNull();
    expect(client.session.create).toHaveBeenCalledTimes(2);
  });

  it('EDGE: a non-positive timeout disables the bound (prompt result is used)', async () => {
    const findings = {
      overallVerdict: 'accept',
      blockingIssues: [],
      reviewedBy: { sessionId: 'child-3' },
    };
    const client = clientWith({
      create: vi.fn().mockResolvedValue({ data: { id: 'child-3' } }),
      prompt: vi.fn().mockResolvedValue({
        data: { parts: [], info: { structured_output: findings } },
      }),
    } as unknown as OrchestratorClient['session']);

    const result = await invokeReviewer(client, 'prompt', 'parent-1', {
      reviewInvocationPolicy: 'sdk_allowed',
      maxRetries: 0,
      promptTimeoutMs: 0,
      _sleepFn: vi.fn().mockResolvedValue(undefined),
    });

    expect(result && !result.blocked).toBe(true);
  });
});
