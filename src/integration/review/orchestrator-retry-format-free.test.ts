import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetAgentResolutionCache } from './agent-resolution.js';
import {
  invokeReviewer,
  type OrchestratorClient,
  type ReviewerResult,
  type ReviewerSuccessResult,
} from './orchestrator.js';
import {
  NO_SLEEP,
  TEXT_COMPAT_OPTIONS,
  validFindings,
  PROMPT,
} from './orchestrator-test-helpers.js';

function assertSuccessfulResult(
  result: ReviewerResult | null,
): asserts result is ReviewerSuccessResult & { findings: Record<string, unknown> } {
  expect(result).not.toBeNull();
  if (!result || result.blocked) throw new TypeError('Expected reviewer invocation to succeed');
  expect(result.findings).not.toBeNull();
  if (!result.findings) throw new TypeError('Expected reviewer findings');
}

function makeSequentialClient(opts?: {
  formatFreeText?: string;
  formatFreeError?: unknown;
  capabilityMessage?: string;
}): OrchestratorClient {
  const prompt = vi
    .fn()
    .mockResolvedValueOnce({
      data: {
        parts: [],
        info: {
          error: {
            name: 'APIError',
            message: opts?.capabilityMessage ?? 'model does not support this tool_choice',
          },
        },
      },
      error: undefined,
    })
    .mockResolvedValueOnce(
      opts?.formatFreeError
        ? { data: undefined, error: opts.formatFreeError }
        : {
            data: {
              parts:
                opts?.formatFreeText === ''
                  ? []
                  : [
                      {
                        type: 'text',
                        text: opts?.formatFreeText ?? JSON.stringify(validFindings()),
                      },
                    ],
              info: {},
            },
            error: undefined,
          },
    );
  return {
    app: { agents: vi.fn().mockResolvedValue({ data: [{ id: 'flowguard-reviewer' }] }) },
    session: {
      create: vi
        .fn()
        .mockResolvedValueOnce({ data: { id: 'structured-session' }, error: undefined })
        .mockResolvedValueOnce({ data: { id: 'format-free-session' }, error: undefined }),
      prompt,
    },
  };
}

describe('invokeReviewer — text compatibility on isolated reviewer', () => {
  beforeEach(() => {
    _resetAgentResolutionCache();
  });

  it('uses a fresh child session and the same isolated reviewer for text compatibility', async () => {
    const client = makeSequentialClient();
    const result = await invokeReviewer(client, PROMPT, 'parent-1', {
      maxRetries: 0,
      ...TEXT_COMPAT_OPTIONS,
      _sleepFn: NO_SLEEP,
    });

    assertSuccessfulResult(result);
    expect(result.sessionId).toBe('format-free-session');
    expect(result.reviewOutputMode).toBe('text_compat');
    expect(result.reviewAssuranceLevel).toBe('text_compat_lower');
    expect(client.session.create).toHaveBeenCalledTimes(2);

    const promptFn = client.session.prompt as ReturnType<typeof vi.fn>;
    const firstBody = promptFn.mock.calls[0]![0].body;
    const secondBody = promptFn.mock.calls[1]![0].body;
    expect(firstBody.agent).toBe('flowguard-reviewer');
    expect(secondBody.agent).toBe('flowguard-reviewer');
    expect(firstBody.system).toBeUndefined();
    expect(secondBody.system).toBeUndefined();
    expect(firstBody.format).toBeDefined();
    expect(secondBody.format).toBeUndefined();
  });

  it('blocks text compatibility when structured output is required', async () => {
    const client = makeSequentialClient();
    const result = await invokeReviewer(client, PROMPT, 'parent-1', {
      reviewInvocationPolicy: 'sdk_allowed',
      reviewOutputPolicy: 'structured_required',
      maxRetries: 0,
      _sleepFn: NO_SLEEP,
    });
    expect(result).toMatchObject({
      blocked: true,
      code: 'REVIEWER_INVOCATION_EXHAUSTED',
      reviewInvocation: { status: 'blocked_capability_mismatch' },
    });
    expect(client.session.prompt).toHaveBeenCalledTimes(1);
  });

  it('parses direct JSON in explicitly allowed text compatibility mode', async () => {
    const client = makeSequentialClient();
    const result = await invokeReviewer(client, PROMPT, 'parent-1', {
      maxRetries: 0,
      ...TEXT_COMPAT_OPTIONS,
      _sleepFn: NO_SLEEP,
    });
    assertSuccessfulResult(result);
    expect(result.extractionMethod).toBe('direct_json');
    expect(result.findings.overallVerdict).toBe('accept');
  });

  it('parses fenced JSON in explicitly allowed text compatibility mode', async () => {
    const client = makeSequentialClient({
      formatFreeText: `\`\`\`json\n${JSON.stringify(validFindings())}\n\`\`\``,
    });
    const result = await invokeReviewer(client, PROMPT, 'parent-1', {
      maxRetries: 0,
      ...TEXT_COMPAT_OPTIONS,
      _sleepFn: NO_SLEEP,
    });
    assertSuccessfulResult(result);
    expect(result.extractionMethod).toBe('json_fence');
  });

  it('parses an outermost JSON object when the compatibility response has prose', async () => {
    const client = makeSequentialClient({
      formatFreeText: `Review follows:\n${JSON.stringify(validFindings())}\nEnd.`,
    });
    const result = await invokeReviewer(client, PROMPT, 'parent-1', {
      maxRetries: 0,
      ...TEXT_COMPAT_OPTIONS,
      _sleepFn: NO_SLEEP,
    });
    assertSuccessfulResult(result);
    expect(result.extractionMethod).toBe('outermost_braces');
  });

  it('returns null when the format-free response is empty', async () => {
    const diagnostics: Array<Record<string, unknown>> = [];
    const client = makeSequentialClient({ formatFreeText: '' });
    const result = await invokeReviewer(client, PROMPT, 'parent-1', {
      maxRetries: 0,
      ...TEXT_COMPAT_OPTIONS,
      _sleepFn: NO_SLEEP,
      _onAttemptFailed: (info) => diagnostics.push(info),
    });
    expect(result).toBeNull();
    expect(diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ step: 'format_free_retry_empty' })]),
    );
  });

  it('returns null when the format-free response is not parseable JSON', async () => {
    const diagnostics: Array<Record<string, unknown>> = [];
    const client = makeSequentialClient({ formatFreeText: 'No structured findings available.' });
    const result = await invokeReviewer(client, PROMPT, 'parent-1', {
      maxRetries: 0,
      ...TEXT_COMPAT_OPTIONS,
      _sleepFn: NO_SLEEP,
      _onAttemptFailed: (info) => diagnostics.push(info),
    });
    expect(result).toBeNull();
    expect(diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ step: 'format_free_retry_parse_failed' })]),
    );
  });

  it('returns null when the format-free prompt transport fails', async () => {
    const client = makeSequentialClient({ formatFreeError: { message: 'rate limited' } });
    const result = await invokeReviewer(client, PROMPT, 'parent-1', {
      maxRetries: 0,
      ...TEXT_COMPAT_OPTIONS,
      _sleepFn: NO_SLEEP,
    });
    expect(result).toBeNull();
  });

  it('does not enter text compatibility when isolated reviewer capability is unavailable', async () => {
    const client: OrchestratorClient = {
      app: { agents: vi.fn().mockResolvedValue({ data: [{ id: 'general' }] }) },
      session: { create: vi.fn(), prompt: vi.fn() },
    };
    const result = await invokeReviewer(client, PROMPT, 'parent-1', {
      maxRetries: 0,
      ...TEXT_COMPAT_OPTIONS,
      _sleepFn: NO_SLEEP,
    });
    expect(result).toMatchObject({ blocked: true, code: 'REVIEWER_INVOCATION_EXHAUSTED' });
    expect(client.session.create).not.toHaveBeenCalled();
    expect(client.session.prompt).not.toHaveBeenCalled();
  });
});
