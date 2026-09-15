import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetAgentResolutionCache } from './agent-resolution.js';
import {
  invokeReviewer,
  type OrchestratorClient,
  type ReviewerSuccessResult,
} from './orchestrator.js';

const mockSleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
const TEST_OPTS = { _sleepFn: mockSleep } as const;

function expectReviewerSuccess(
  result: Awaited<ReturnType<typeof invokeReviewer>>,
): ReviewerSuccessResult {
  expect(result && !result.blocked).toBe(true);
  if (!result || result.blocked) throw new Error('Expected reviewer success result');
  return result;
}

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
    attestation: {
      toolObligationId: '11111111-1111-4111-8111-111111111111',
    },
  };
}

function successCreateResult(id = 'child-session-1') {
  return { data: { id }, error: undefined };
}

function successPromptResult() {
  return {
    data: {
      parts: [{ type: 'text', text: JSON.stringify(validFindings()) }],
      info: { structured: validFindings() },
    },
    error: undefined,
  };
}

function failCreateResult() {
  return { error: { message: 'connection timeout' }, data: undefined };
}

function failPromptResult() {
  return { error: { message: 'rate limited' }, data: undefined };
}

function noStructuredOutputResult() {
  return {
    data: { parts: [{ type: 'text', text: 'some text' }], info: {} },
    error: undefined,
  };
}

function structuredOutputErrorResult() {
  return {
    data: {
      parts: [],
      info: { error: { name: 'StructuredOutputError', message: 'schema validation failed' } },
    },
    error: undefined,
  };
}

function makeRetryClient(session: OrchestratorClient['session']): OrchestratorClient {
  return {
    app: { agents: vi.fn().mockResolvedValue({ data: [{ id: 'flowguard-reviewer' }] }) },
    session,
  };
}

describe('invokeReviewer — retry core', () => {
  const PROMPT = 'Review this plan...';
  const PARENT_ID = 'parent-session-1';

  beforeEach(() => {
    vi.clearAllMocks();
    _resetAgentResolutionCache();
  });

  it('succeeds without retries on the isolated reviewer', async () => {
    const client = makeRetryClient({
      create: vi.fn().mockResolvedValue(successCreateResult()),
      prompt: vi.fn().mockResolvedValue(successPromptResult()),
    });
    const result = await invokeReviewer(client, PROMPT, PARENT_ID, TEST_OPTS);
    expect(expectReviewerSuccess(result).findings?.overallVerdict).toBe('accept');
    expect(client.session.create).toHaveBeenCalledTimes(1);
    expect(mockSleep).not.toHaveBeenCalled();
  });

  it('recovers after a transient session.create failure', async () => {
    const client = makeRetryClient({
      create: vi
        .fn()
        .mockResolvedValueOnce(failCreateResult())
        .mockResolvedValueOnce(successCreateResult()),
      prompt: vi.fn().mockResolvedValue(successPromptResult()),
    });
    const result = await invokeReviewer(client, PROMPT, PARENT_ID, TEST_OPTS);
    expect(expectReviewerSuccess(result).findings?.overallVerdict).toBe('accept');
    expect(client.session.create).toHaveBeenCalledTimes(2);
    expect(mockSleep).toHaveBeenNthCalledWith(1, 1000);
  });

  it('recovers after a transient session.prompt failure using a fresh child session', async () => {
    const client = makeRetryClient({
      create: vi
        .fn()
        .mockResolvedValueOnce(successCreateResult('child-1'))
        .mockResolvedValueOnce(successCreateResult('child-2')),
      prompt: vi
        .fn()
        .mockResolvedValueOnce(failPromptResult())
        .mockResolvedValueOnce(successPromptResult()),
    });
    const result = await invokeReviewer(client, PROMPT, PARENT_ID, TEST_OPTS);
    expect(expectReviewerSuccess(result).findings?.overallVerdict).toBe('accept');
    expect(client.session.create).toHaveBeenCalledTimes(2);
    expect(client.session.prompt).toHaveBeenCalledTimes(2);
  });

  it('blocks missing structured output without parsing text as a substitute', async () => {
    const client = makeRetryClient({
      create: vi.fn().mockResolvedValue(successCreateResult()),
      prompt: vi.fn().mockResolvedValueOnce(noStructuredOutputResult()),
    });
    const result = await invokeReviewer(client, PROMPT, PARENT_ID, TEST_OPTS);
    expect(result).toMatchObject({ blocked: true, code: 'HOST_STRUCTURED_OUTPUT_REQUIRED' });
    expect(client.session.prompt).toHaveBeenCalledTimes(1);
  });

  it('returns null after create retries are exhausted', async () => {
    const client = makeRetryClient({
      create: vi.fn().mockResolvedValue(failCreateResult()),
      prompt: vi.fn().mockResolvedValue(successPromptResult()),
    });
    const result = await invokeReviewer(client, PROMPT, PARENT_ID, TEST_OPTS);
    expect(result).toBeNull();
    expect(client.session.create).toHaveBeenCalledTimes(3);
    expect(client.session.prompt).not.toHaveBeenCalled();
  });

  it('returns null after prompt retries are exhausted', async () => {
    const client = makeRetryClient({
      create: vi.fn().mockResolvedValue(successCreateResult()),
      prompt: vi.fn().mockResolvedValue(failPromptResult()),
    });
    const result = await invokeReviewer(client, PROMPT, PARENT_ID, TEST_OPTS);
    expect(result).toBeNull();
    expect(client.session.prompt).toHaveBeenCalledTimes(3);
  });

  it('does not retry deterministic StructuredOutputError', async () => {
    const client = makeRetryClient({
      create: vi.fn().mockResolvedValue(successCreateResult()),
      prompt: vi.fn().mockResolvedValue(structuredOutputErrorResult()),
    });
    const result = await invokeReviewer(client, PROMPT, PARENT_ID, TEST_OPTS);
    expect(result).toBeNull();
    expect(client.session.create).toHaveBeenCalledTimes(1);
    expect(client.session.prompt).toHaveBeenCalledTimes(1);
    expect(mockSleep).not.toHaveBeenCalled();
  });

  it('respects maxTransportRetries=0', async () => {
    const client = makeRetryClient({
      create: vi.fn().mockResolvedValue(failCreateResult()),
      prompt: vi.fn(),
    });
    const result = await invokeReviewer(client, PROMPT, PARENT_ID, {
      maxTransportRetries: 0,
      _sleepFn: mockSleep,
    });
    expect(result).toBeNull();
    expect(client.session.create).toHaveBeenCalledTimes(1);
  });

  it('uses exponential backoff with a custom base delay', async () => {
    const client = makeRetryClient({
      create: vi
        .fn()
        .mockResolvedValueOnce(failCreateResult())
        .mockResolvedValueOnce(failCreateResult())
        .mockResolvedValueOnce(successCreateResult()),
      prompt: vi.fn().mockResolvedValue(successPromptResult()),
    });
    await invokeReviewer(client, PROMPT, PARENT_ID, {
      baseDelayMs: 500,
      _sleepFn: mockSleep,
    });
    expect(mockSleep).toHaveBeenNthCalledWith(1, 500);
    expect(mockSleep).toHaveBeenNthCalledWith(2, 1000);
  });

  it('blocks before retry machinery when isolated reviewer capability is unavailable', async () => {
    const client: OrchestratorClient = {
      app: { agents: vi.fn().mockResolvedValue({ data: [{ id: 'general' }] }) },
      session: { create: vi.fn(), prompt: vi.fn() },
    };
    const result = await invokeReviewer(client, PROMPT, PARENT_ID, TEST_OPTS);
    expect(result).toMatchObject({
      blocked: true,
      code: 'STRUCTURED_REVIEW_CAPABILITY_UNAVAILABLE',
    });
    expect(client.session.create).not.toHaveBeenCalled();
    expect(mockSleep).not.toHaveBeenCalled();
  });
});
