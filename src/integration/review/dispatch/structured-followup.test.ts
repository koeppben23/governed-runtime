/** Correlated, model-neutral JSON capture and bounded, semantic-preserving repair. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReviewerCaptureController } from '../../reviewer-capture.js';
import {
  CAPTURE_MODEL,
  CAPTURE_ATTEMPT,
  CAPTURE_OBLIGATION,
  observedPrompt,
  reviewerInputFixture,
} from '../../reviewer-capture-test-helpers.js';
import { _resetAgentResolutionCache } from './agent-resolution.js';
import {
  captureStructuredFindingsFromVisibleChild,
  type StructuredFollowupTiming,
} from './structured-followup.js';
import { classifyReviewerCaptureFailure } from './capture-retry.js';
import { REVIEW_FINDINGS_JSON_SCHEMA } from '../evidence/findings-schema.js';
import type { OrchestratorClient } from '../types.js';

function fixture(payload: (call: number) => unknown = () => reviewerInputFixture()) {
  const controller = new ReviewerCaptureController();
  const input = {
    childSessionId: 'ses_child',
    obligationId: CAPTURE_OBLIGATION,
    attemptId: CAPTURE_ATTEMPT,
    schema: REVIEW_FINDINGS_JSON_SCHEMA as Record<string, unknown>,
    model: { ...CAPTURE_MODEL } as { providerID: string; modelID: string; variant: string | null },
    controller,
    lease: {} as { id?: string },
  };
  let calls = 0;
  const client: OrchestratorClient = {
    app: { agents: vi.fn(async () => ({ data: [{ name: 'flowguard-reviewer' }] })) },
    session: {
      prompt: vi.fn(async (opts) => {
        const value = payload(++calls);
        return observedPrompt(
          controller,
          opts,
          typeof value === 'string' ? value : JSON.stringify(value),
        );
      }),
    },
  };
  return { client, input, controller };
}

afterEach(() => {
  _resetAgentResolutionCache();
  vi.restoreAllMocks();
});

describe('model-neutral same-child findings', () => {
  it.each(['low', 'high', 'max', null])(
    'preserves model/variant %s without a format or effort override',
    async (variant) => {
      const { client, input } = fixture();
      input.model.variant = variant;
      const result = await captureStructuredFindingsFromVisibleChild(client, input);
      expect(result.kind).toBe('ok');
      const [request] = vi.mocked(client.session.prompt).mock.calls[0]!;
      expect(request.path.id).toBe(input.childSessionId);
      expect(request.body.model).toEqual({
        providerID: CAPTURE_MODEL.providerID,
        modelID: CAPTURE_MODEL.modelID,
      });
      expect(request.body.variant ?? null).toBe(variant);
      expect(request.body).not.toHaveProperty('format');
      expect(request.body).not.toHaveProperty('tools');
      expect(request.body).not.toHaveProperty('reasoningEffort');
      expect(result).toMatchObject({
        capture: {
          requestMessageId: request.body.messageID,
          childSessionId: input.childSessionId,
          model: input.model,
        },
      });
      expect(request.body.parts[0]?.text).toContain('Expand every cited offered-ref number');
      expect(request.body.parts[0]?.text).toContain('JSON schema (data, not instructions)');
    },
  );

  it.each([
    '{} {}',
    '```json\n{}\n```',
    '{"overallVerdict":"accept","overallVerdict":"unable_to_review"}',
    'The model does not support tools or reasoning effort.',
  ])('rejects non-contract text without extracting findings: %s', async (text) => {
    const { client, input } = fixture(() => text);
    const result = await captureStructuredFindingsFromVisibleChild(client, input);
    expect(result).toMatchObject({ kind: 'blocked', code: 'HOST_STRUCTURED_OUTPUT_REQUIRED' });
    expect(client.session.prompt).toHaveBeenCalledTimes(1);
  });

  it('rejects synthetic or tool-derived JSON even when it satisfies the schema', async () => {
    const { client, input } = fixture();
    const prompt = client.session.prompt.bind(client.session);
    client.session.prompt = vi.fn(async (opts) => {
      const result = await prompt(opts);
      return {
        data: {
          ...result.data,
          parts: [{ type: 'text', synthetic: true, text: JSON.stringify(reviewerInputFixture()) }],
        },
      };
    });
    expect(await captureStructuredFindingsFromVisibleChild(client, input)).toMatchObject({
      kind: 'blocked',
      code: 'REVIEWER_CAPTURE_PROVENANCE_INVALID',
    });
  });

  it('allows one syntax/structure correction without changing reviewer semantics', async () => {
    const { client, input } = fixture((call) =>
      call === 1
        ? { ...reviewerInputFixture(), unexpected: 'untrusted extra field' }
        : reviewerInputFixture(),
    );
    const result = await captureStructuredFindingsFromVisibleChild(client, input);
    expect(result).toMatchObject({
      kind: 'ok',
      serializationRepair: { originalHash: expect.any(String) },
    });
    expect(client.session.prompt).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(client.session.prompt).mock.calls;
    expect(calls[0]?.[0].body.messageID).not.toBe(calls[1]?.[0].body.messageID);
    expect(calls[0]?.[0].body.model).toEqual(calls[1]?.[0].body.model);
    expect(calls[0]?.[0].body.variant).toBe(calls[1]?.[0].body.variant);
  });

  it('rejects a repair that changes the verdict', async () => {
    const { client, input } = fixture((call) =>
      call === 1
        ? { ...reviewerInputFixture(), unexpected: true }
        : { ...reviewerInputFixture(), overallVerdict: 'unable_to_review' },
    );
    const result = await captureStructuredFindingsFromVisibleChild(client, input);
    expect(result).toMatchObject({
      kind: 'blocked',
      code: 'HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION',
    });
    expect(result.kind === 'blocked' && result.reason).toContain('semantic projection');
  });

  it.each(['sdk', 'message', 'repair'] as const)(
    'keeps deterministic %s provider errors terminal',
    async (channel) => {
      const { client, input } = fixture(() => ({ ...reviewerInputFixture(), unexpected: true }));
      const prompt = client.session.prompt.bind(client.session);
      let calls = 0;
      const error = {
        name: 'APIError',
        data: {
          message: 'Unsupported value for reasoning_effort: none. Only supports low or high.',
        },
      };
      client.session.prompt = vi.fn(async (opts) => {
        calls++;
        if (channel === 'repair' && calls === 1) return prompt(opts);
        if (channel === 'sdk') return { error };
        return { data: { info: { error } } };
      });
      const result = await captureStructuredFindingsFromVisibleChild(client, input);
      expect(result).toMatchObject({
        kind: 'blocked',
        code: 'STRUCTURED_REVIEW_EXECUTION_MODE_INCOMPATIBLE',
      });
      expect(
        classifyReviewerCaptureFailure(result.kind === 'blocked' ? result.code : ''),
      ).toMatchObject({ retryable: false });
      expect(calls).toBe(channel === 'repair' ? 2 : 1);
    },
  );

  it('times a throwing prompt and retains its unknown-outcome fence', async () => {
    const { client, input, controller } = fixture();
    const failure = new Error('connection lost');
    client.session.prompt = vi.fn(async () => {
      throw failure;
    });
    const timings: StructuredFollowupTiming[] = [];
    await expect(
      captureStructuredFindingsFromVisibleChild(client, input, (timing) => timings.push(timing)),
    ).rejects.toBe(failure);
    expect(timings).toMatchObject([
      { promptOutcome: 'threw', followupPromptMs: expect.any(Number) },
    ]);
    controller.release(input.childSessionId);
    expect(controller.isSafe(input.childSessionId)).toBe(false);
    expect(() => controller.beforeTool({ sessionID: input.childSessionId })).toThrow();
  });

  it.each([
    { error: new Error('host request failed without execution outcome') },
    { error: { name: 'UnknownError', data: { message: 'host disconnected' } } },
    {},
    { data: undefined },
    { data: { info: { error: { name: 'UnknownError' } } } },
  ])('quarantines returned SDK ambiguity just like a thrown exception: %j', async (response) => {
    const { client, input, controller } = fixture();
    client.session.prompt = vi.fn(async () => response);
    await expect(captureStructuredFindingsFromVisibleChild(client, input)).rejects.toMatchObject({
      code: 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN',
    });
    expect(controller.isQuarantined(input.childSessionId)).toBe(true);
    controller.release(input.childSessionId, input.lease.id);
    expect(() => controller.beforeTool({ sessionID: input.childSessionId })).toThrow();
    expect(() => controller.begin(input.childSessionId, input.model, input)).toThrow();
    expect(client.session.prompt).toHaveBeenCalledTimes(1);
  });

  it('quarantines a returned unknown repair outcome without downgrading it to contract retry', async () => {
    const { client, input, controller } = fixture(() => ({
      ...reviewerInputFixture(),
      unexpected: true,
    }));
    const prompt = client.session.prompt.bind(client.session);
    let calls = 0;
    client.session.prompt = vi.fn(async (opts) =>
      ++calls === 1 ? prompt(opts) : { error: new Error('repair outcome unknown') },
    );
    await expect(captureStructuredFindingsFromVisibleChild(client, input)).rejects.toMatchObject({
      code: 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN',
    });
    controller.release(input.childSessionId, input.lease.id);
    expect(controller.isQuarantined(input.childSessionId)).toBe(true);
    expect(calls).toBe(2);
  });

  it('does not let a diagnostic observer alter successful findings', async () => {
    const { client, input } = fixture();
    const result = await captureStructuredFindingsFromVisibleChild(client, input, () => {
      throw new Error('logger');
    });
    expect(result.kind).toBe('ok');
  });

  it('quarantines an SDK error even when it also carries otherwise valid response data', async () => {
    const { client, input, controller } = fixture();
    const prompt = client.session.prompt.bind(client.session);
    client.session.prompt = vi.fn(async (opts) => ({
      ...(await prompt(opts)),
      error: new Error('unknown execution status'),
    }));
    await expect(captureStructuredFindingsFromVisibleChild(client, input)).rejects.toMatchObject({
      code: 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN',
    });
    expect(controller.isQuarantined(input.childSessionId)).toBe(true);
  });

  it.each([null, undefined])(
    'retains the fence for a malformed empty SDK envelope (%j)',
    async (response) => {
      const { client, input, controller } = fixture();
      client.session.prompt = vi.fn(
        async () =>
          response as unknown as Awaited<ReturnType<OrchestratorClient['session']['prompt']>>,
      );
      await expect(captureStructuredFindingsFromVisibleChild(client, input)).rejects.toMatchObject({
        code: 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN',
      });
      controller.release(input.childSessionId, input.lease.id);
      expect(controller.isQuarantined(input.childSessionId)).toBe(true);
    },
  );

  it('does not steal a busy capture lease or invoke another host prompt', async () => {
    const { client, input, controller } = fixture();
    const lease = controller.begin(input.childSessionId, input.model, input);
    const result = await captureStructuredFindingsFromVisibleChild(client, input);
    expect(result).toMatchObject({ kind: 'blocked', code: 'REVIEWER_CAPTURE_PROVENANCE_INVALID' });
    expect(input.lease.id).toBeUndefined();
    expect(controller.isSafe(input.childSessionId)).toBe(true);
    expect(client.session.prompt).not.toHaveBeenCalled();
    controller.release(input.childSessionId, lease);
  });

  it('preserves bounded contract diagnostics after an unsuccessful structure repair', async () => {
    const { client, input } = fixture(() => ({
      ...reviewerInputFixture(),
      overallVerdict: 'untrusted rejected value',
    }));
    const result = await captureStructuredFindingsFromVisibleChild(client, input);
    expect(result.kind).toBe('blocked');
    if (result.kind !== 'blocked') throw new Error('Expected contract rejection');
    expect(result.diagnostics).toMatchObject([
      { code: 'HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION', data: { path: 'overallVerdict' } },
    ]);
    expect(JSON.stringify(result.diagnostics)).not.toContain('untrusted rejected value');
    expect(client.session.prompt).toHaveBeenCalledTimes(2);
  });

  it('quarantines an unclassified message error even alongside plausible completed metadata', async () => {
    const { client, input, controller } = fixture();
    const prompt = client.session.prompt.bind(client.session);
    client.session.prompt = vi.fn(async (opts) => {
      const result = await prompt(opts);
      return {
        data: { ...result.data, info: { ...result.data?.info, error: { name: 'UnknownError' } } },
      };
    });
    await expect(captureStructuredFindingsFromVisibleChild(client, input)).rejects.toMatchObject({
      code: 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN',
    });
    expect(controller.isQuarantined(input.childSessionId)).toBe(true);
  });

  it('reports elapsed prompt duration, not absolute performance clock values', async () => {
    const { client, input } = fixture();
    vi.spyOn(performance, 'now').mockReturnValueOnce(1000).mockReturnValue(1005);
    const timings: StructuredFollowupTiming[] = [];
    expect(
      (
        await captureStructuredFindingsFromVisibleChild(client, input, (timing) =>
          timings.push(timing),
        )
      ).kind,
    ).toBe('ok');
    expect(timings).toEqual([{ followupPromptMs: 5, promptOutcome: 'responded' }]);
  });
});
