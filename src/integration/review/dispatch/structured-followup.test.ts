/** Semantic port and current capture-validator tests, not installed V2 provenance proof. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReviewerCaptureController } from '../../reviewer-capture.js';
import {
  CAPTURE_MODEL,
  CAPTURE_ATTEMPT,
  CAPTURE_OBLIGATION,
  observedPrompt,
  reviewerInputFixture,
} from '../../reviewer-capture-test-helpers.js';
import { createReviewClient } from '../../opencode-v2-test-helpers.js';
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
  const reply = async (opts: Parameters<OrchestratorClient['executeReviewerPrompt']>[0]) => {
    const value = payload(++calls);
    return observedPrompt(
      controller,
      opts,
      typeof value === 'string' ? value : JSON.stringify(value),
    );
  };
  const client = createReviewClient({
    listAgents: vi.fn(async () => [{ id: 'flowguard-reviewer' }]),
    executeReviewerPrompt: vi.fn(reply),
  });
  return { client, input, controller, reply, prompt: vi.mocked(client.executeReviewerPrompt) };
}

const providerError = {
  type: 'provider',
  message: 'Unsupported value for reasoning_effort: none. Only supports low or high.',
};
afterEach(() => vi.restoreAllMocks());

describe('model-neutral same-child findings through the semantic host port', () => {
  it.each(['low', 'high', 'max', null])(
    'preserves model/variant %s without a format or effort override',
    async (variant) => {
      const { client, input, prompt } = fixture();
      input.model.variant = variant;
      const result = await captureStructuredFindingsFromVisibleChild(client, input);
      expect(result.kind).toBe('ok');
      const [request] = prompt.mock.calls[0]!;
      expect(request.sessionId).toBe(input.childSessionId);
      expect(request.model).toEqual({
        providerID: CAPTURE_MODEL.providerID,
        modelID: CAPTURE_MODEL.modelID,
        variant,
      });
      expect(request).not.toHaveProperty('format');
      expect(request).not.toHaveProperty('tools');
      expect(request).not.toHaveProperty('reasoningEffort');
      expect(request).not.toHaveProperty('path');
      expect(request).not.toHaveProperty('body');
      expect(result).toMatchObject({
        capture: {
          requestMessageId: request.requestId,
          childSessionId: input.childSessionId,
          model: input.model,
        },
      });
      expect(request.text).toContain('Expand every cited offered-ref number');
      expect(request.text).toContain('JSON schema (data, not instructions)');
      expect(client.listAgents).toHaveBeenCalledWith(input.childSessionId);
    },
  );

  it.each([
    '{} {}',
    '```json\n{}\n```',
    '{"overallVerdict":"accept","overallVerdict":"unable_to_review"}',
    'The model does not support tools or reasoning effort.',
  ])('rejects non-contract text without treating it as provider authority: %s', async (text) => {
    const { client, input, prompt } = fixture(() => text);
    expect(await captureStructuredFindingsFromVisibleChild(client, input)).toMatchObject({
      kind: 'blocked',
      code: 'HOST_STRUCTURED_OUTPUT_REQUIRED',
    });
    expect(prompt).toHaveBeenCalledOnce();
  });

  it('rejects synthetic or tool-derived JSON even when schema-valid', async () => {
    const { client, input, prompt, reply } = fixture();
    prompt.mockImplementation(async (opts) => ({
      ...(await reply(opts)),
      parts: [{ type: 'text', synthetic: true, text: JSON.stringify(reviewerInputFixture()) }],
    }));
    expect(await captureStructuredFindingsFromVisibleChild(client, input)).toMatchObject({
      kind: 'blocked',
      code: 'REVIEWER_CAPTURE_PROVENANCE_INVALID',
    });
  });

  it('allows one structure correction while preserving reviewer semantics and model selection', async () => {
    const { client, input, prompt } = fixture((call) =>
      call === 1
        ? { ...reviewerInputFixture(), unexpected: 'untrusted extra field' }
        : reviewerInputFixture(),
    );
    expect(await captureStructuredFindingsFromVisibleChild(client, input)).toMatchObject({
      kind: 'ok',
      serializationRepair: { originalHash: expect.any(String) },
    });
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(prompt.mock.calls[0]![0].requestId).not.toBe(prompt.mock.calls[1]![0].requestId);
    expect(prompt.mock.calls[0]![0].model).toEqual(prompt.mock.calls[1]![0].model);
  });

  it('rejects a structure repair that changes the verdict', async () => {
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

  it.each(['thrown', 'message', 'repair'] as const)(
    'keeps deterministic %s errors terminal without releasing an unproved fence',
    async (channel) => {
      const { client, input, controller, prompt, reply } = fixture(() => ({
        ...reviewerInputFixture(),
        unexpected: true,
      }));
      let calls = 0;
      prompt.mockImplementation(async (opts) => {
        calls++;
        if (channel === 'repair' && calls === 1) return reply(opts);
        if (channel === 'thrown') throw providerError;
        return { info: { error: providerError } };
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
      controller.release(input.childSessionId, input.lease.id);
      expect(controller.isQuarantined(input.childSessionId)).toBe(true);
      expect(() => controller.beforeTool({ sessionID: input.childSessionId })).toThrow();
    },
  );

  it('releases a classified message failure only with exact terminal assistant proof', async () => {
    const { client, input, controller, prompt, reply } = fixture();
    prompt.mockImplementation(async (opts) => {
      const base = await reply(opts);
      return { ...base, info: { ...base.info, finish: 'error', error: providerError } };
    });
    expect(await captureStructuredFindingsFromVisibleChild(client, input)).toMatchObject({
      kind: 'blocked',
      code: 'STRUCTURED_REVIEW_EXECUTION_MODE_INCOMPATIBLE',
    });
    expect(controller.isQuarantined(input.childSessionId)).toBe(false);
    controller.release(input.childSessionId, input.lease.id);
    expect(() => controller.beforeTool({ sessionID: input.childSessionId })).not.toThrow();
  });

  it('quarantines a classified failure whose terminal request identity is stale', async () => {
    const { client, input, controller, prompt, reply } = fixture();
    prompt.mockImplementation(async (opts) => {
      const base = await reply(opts);
      return {
        ...base,
        info: { ...base.info, parentID: 'msg_other', finish: 'error', error: providerError },
      };
    });
    expect(await captureStructuredFindingsFromVisibleChild(client, input)).toMatchObject({
      kind: 'blocked',
      code: 'STRUCTURED_REVIEW_EXECUTION_MODE_INCOMPATIBLE',
    });
    expect(controller.isQuarantined(input.childSessionId)).toBe(true);
  });

  it('times a throwing prompt and retains the unknown-outcome fence', async () => {
    const { client, input, controller, prompt } = fixture();
    const error = new Error('connection lost');
    prompt.mockRejectedValue(error);
    const timings: StructuredFollowupTiming[] = [];
    await expect(
      captureStructuredFindingsFromVisibleChild(client, input, (timing) => timings.push(timing)),
    ).rejects.toBe(error);
    expect(timings).toMatchObject([
      { promptOutcome: 'threw', followupPromptMs: expect.any(Number) },
    ]);
    controller.release(input.childSessionId);
    expect(controller.isSafe(input.childSessionId)).toBe(false);
    expect(() => controller.beforeTool({ sessionID: input.childSessionId })).toThrow();
  });

  it.each([
    { error: new Error('unknown') },
    { data: { info: {} } },
    {},
    { id: 'inbox', type: 'user' },
    { info: { error: { type: 'unknown', message: 'host disconnected' } } },
  ])('quarantines ambiguity, admission and old envelopes: %j', async (response) => {
    const { client, input, controller, prompt } = fixture();
    prompt.mockResolvedValue(response);
    await expect(captureStructuredFindingsFromVisibleChild(client, input)).rejects.toMatchObject({
      code: 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN',
    });
    expect(controller.isQuarantined(input.childSessionId)).toBe(true);
    controller.release(input.childSessionId, input.lease.id);
    expect(() => controller.beforeTool({ sessionID: input.childSessionId })).toThrow();
    expect(() => controller.begin(input.childSessionId, input.model, input)).toThrow();
    expect(prompt).toHaveBeenCalledOnce();
  });

  it('does not turn an unknown repair outcome into a retryable contract defect', async () => {
    const { client, input, controller, prompt, reply } = fixture(() => ({
      ...reviewerInputFixture(),
      unexpected: true,
    }));
    let calls = 0;
    prompt.mockImplementation(async (opts) =>
      ++calls === 1 ? reply(opts) : { error: new Error('unknown repair outcome') },
    );
    await expect(captureStructuredFindingsFromVisibleChild(client, input)).rejects.toMatchObject({
      code: 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN',
    });
    controller.release(input.childSessionId, input.lease.id);
    expect(controller.isQuarantined(input.childSessionId)).toBe(true);
    expect(calls).toBe(2);
  });

  it('does not let a diagnostic observer change successful findings', async () => {
    const { client, input } = fixture();
    expect(
      (
        await captureStructuredFindingsFromVisibleChild(client, input, () => {
          throw new Error('logger');
        })
      ).kind,
    ).toBe('ok');
  });

  it('rejects a top-level error even alongside plausible completed response data', async () => {
    const { client, input, controller, prompt, reply } = fixture();
    prompt.mockImplementation(async (opts) => ({
      ...(await reply(opts)),
      error: new Error('unknown execution status'),
    }));
    await expect(captureStructuredFindingsFromVisibleChild(client, input)).rejects.toMatchObject({
      code: 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN',
    });
    expect(controller.isQuarantined(input.childSessionId)).toBe(true);
  });

  it.each([null, undefined])('retains the fence for an empty reply (%j)', async (response) => {
    const { client, input, controller, prompt } = fixture();
    prompt.mockResolvedValue(response);
    await expect(captureStructuredFindingsFromVisibleChild(client, input)).rejects.toMatchObject({
      code: 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN',
    });
    controller.release(input.childSessionId, input.lease.id);
    expect(controller.isQuarantined(input.childSessionId)).toBe(true);
  });

  it('never steals a busy capture lease or invokes another prompt', async () => {
    const { client, input, controller, prompt } = fixture();
    const lease = controller.begin(input.childSessionId, input.model, input);
    expect(await captureStructuredFindingsFromVisibleChild(client, input)).toMatchObject({
      kind: 'blocked',
      code: 'REVIEWER_CAPTURE_PROVENANCE_INVALID',
    });
    expect(input.lease.id).toBeUndefined();
    expect(controller.isSafe(input.childSessionId)).toBe(true);
    expect(prompt).not.toHaveBeenCalled();
    controller.release(input.childSessionId, lease);
  });

  it('preserves bounded diagnostics after unsuccessful structure repair', async () => {
    const { client, input, prompt } = fixture(() => ({
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
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it('quarantines an unclassified message failure despite plausible completed metadata', async () => {
    const { client, input, controller, prompt, reply } = fixture();
    prompt.mockImplementation(async (opts) => {
      const base = await reply(opts);
      return { ...base, info: { ...base.info, error: { type: 'unknown', message: 'unknown' } } };
    });
    await expect(captureStructuredFindingsFromVisibleChild(client, input)).rejects.toMatchObject({
      code: 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN',
    });
    expect(controller.isQuarantined(input.childSessionId)).toBe(true);
  });

  it('reports elapsed duration, not an absolute performance-clock value', async () => {
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
