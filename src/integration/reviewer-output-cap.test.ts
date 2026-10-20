/**
 * @module integration/reviewer-output-cap.test
 * @description Unit contract for the OpenCode reviewer output-cap hook.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createReviewerOutputCapHook,
  ReviewerOutputCapError,
  type ReviewerOutputCapFailure,
} from './reviewer-output-cap.js';
import { REVIEWER_SUBAGENT_TYPE } from '../shared/flowguard-identifiers.js';

type HookInput = Parameters<ReturnType<typeof createReviewerOutputCapHook>>[0];
type HookOutput = Parameters<ReturnType<typeof createReviewerOutputCapHook>>[1];

const DEFAULT_MODEL = {
  id: 'deepseek-chat',
  providerID: 'deepseek',
  limit: { context: 1_000_000, output: 393_216 },
};

function output(): HookOutput {
  return {
    temperature: 0.2,
    topP: 0.9,
    topK: 40,
    maxOutputTokens: 32_000,
    options: { reasoningEffort: 'max' },
  };
}

function runHook(
  input: {
    sessionID?: string;
    agent?: string;
    model?: Record<string, unknown>;
  },
  outputValue = output(),
  options: {
    outputTokenMax?: number;
    configReadError?: unknown;
    failures?: Map<string, ReviewerOutputCapFailure>;
    persistFailure?: (
      childSessionID: string,
      failure: ReviewerOutputCapFailure,
    ) => Promise<boolean>;
  } = {},
) {
  const log = { info: vi.fn(), error: vi.fn() };
  const failures = options.failures ?? new Map<string, ReviewerOutputCapFailure>();
  const hook = createReviewerOutputCapHook({
    config: { reviewer: { outputTokenMax: options.outputTokenMax ?? 65_536 } },
    ...(options.configReadError !== undefined ? { configReadError: options.configReadError } : {}),
    log,
    failures,
    ...(options.persistFailure !== undefined ? { persistFailure: options.persistFailure } : {}),
  });
  const inputValue = {
    sessionID: input.sessionID ?? 'ses_reviewer',
    agent: input.agent ?? REVIEWER_SUBAGENT_TYPE,
    model: input.model ?? DEFAULT_MODEL,
    provider: {},
    message: {},
  } as unknown as HookInput;
  return { hook, inputValue, outputValue, log, failures };
}

describe('reviewer output-cap hook', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('HAPPY: applies the configured cap to the reviewer only', async () => {
    const { hook, inputValue, outputValue, log } = runHook({});
    await hook(inputValue, outputValue);

    expect(outputValue.maxOutputTokens).toBe(65_536);
    expect(outputValue.temperature).toBe(0.2);
    expect(outputValue.topP).toBe(0.9);
    expect(outputValue.topK).toBe(40);
    expect(outputValue.options).toEqual({ reasoningEffort: 'max' });
    expect(log.info).toHaveBeenCalledWith(
      'review',
      'reviewer output cap applied',
      expect.objectContaining({
        sessionID: 'ses_reviewer',
        model: 'deepseek/deepseek-chat',
        modelLimit: 393_216,
        configured: 65_536,
        previous: 32_000,
        effective: 65_536,
      }),
    );
  });

  it('HAPPY: honors a configured 32K cap', async () => {
    const { hook, inputValue, outputValue } = runHook({}, output(), { outputTokenMax: 32_000 });
    await hook(inputValue, outputValue);
    expect(outputValue.maxOutputTokens).toBe(32_000);
  });

  it('HAPPY: leaves every non-reviewer agent untouched', async () => {
    const { hook, inputValue, outputValue, log } = runHook({ agent: 'build' });
    await hook(inputValue, outputValue);
    expect(outputValue.maxOutputTokens).toBe(32_000);
    expect(outputValue).toEqual(output());
    expect(log.info).not.toHaveBeenCalled();
  });

  it('HAPPY: the host environment cap cannot override the reviewer config', async () => {
    vi.stubEnv('OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX', '32000');
    const { hook, inputValue, outputValue } = runHook({});
    await hook(inputValue, outputValue);
    expect(outputValue.maxOutputTokens).toBe(65_536);
  });

  it('BAD: a model limit below the configured cap fails closed', async () => {
    const { hook, inputValue, outputValue, log, failures } = runHook({
      model: { ...DEFAULT_MODEL, limit: { context: 1_000_000, output: 32_768 } },
    });

    await expect(hook(inputValue, outputValue)).rejects.toMatchObject({
      name: 'ReviewerOutputCapError',
      code: 'REVIEWER_OUTPUT_CAP_MODEL_LIMIT_TOO_SMALL',
    });
    expect(outputValue.maxOutputTokens).toBe(32_000);
    expect(log.error).toHaveBeenCalledWith(
      'review',
      'reviewer output cap rejected',
      expect.objectContaining({
        modelLimit: 32_768,
        configured: 65_536,
        code: 'REVIEWER_OUTPUT_CAP_MODEL_LIMIT_TOO_SMALL',
      }),
    );
    expect(failures.get('ses_reviewer')).toMatchObject({
      code: 'REVIEWER_OUTPUT_CAP_MODEL_LIMIT_TOO_SMALL',
      modelLimit: 32_768,
      configured: 65_536,
    });
  });

  it('BAD: an unknown model limit fails closed', async () => {
    const { hook, inputValue, outputValue } = runHook({
      model: { id: 'mystery', providerID: 'probe', limit: {} },
    });
    await expect(hook(inputValue, outputValue)).rejects.toBeInstanceOf(ReviewerOutputCapError);
    expect(outputValue.maxOutputTokens).toBe(32_000);
  });

  it('BAD: an unreadable config fails closed with the original reason', async () => {
    const { hook, inputValue, outputValue, failures } = runHook({}, output(), {
      configReadError: new Error('flowguard.json is malformed'),
    });
    await expect(hook(inputValue, outputValue)).rejects.toMatchObject({
      code: 'REVIEWER_OUTPUT_CAP_CONFIG_UNREADABLE',
    });
    expect(failures.get('ses_reviewer')?.reason).toContain('flowguard.json is malformed');
  });

  it('HAPPY: persists the terminal failure and does not retain the fallback map', async () => {
    const persistFailure = vi.fn(async () => true);
    const { hook, inputValue, outputValue, failures } = runHook(
      { model: { ...DEFAULT_MODEL, limit: { context: 1_000_000, output: 32_768 } } },
      output(),
      { persistFailure },
    );
    await expect(hook(inputValue, outputValue)).rejects.toMatchObject({
      code: 'REVIEWER_OUTPUT_CAP_MODEL_LIMIT_TOO_SMALL',
    });
    expect(persistFailure).toHaveBeenCalledWith(
      'ses_reviewer',
      expect.objectContaining({ code: 'REVIEWER_OUTPUT_CAP_MODEL_LIMIT_TOO_SMALL' }),
    );
    expect(failures.size).toBe(0);
  });

  it('BAD: a persistence failure leaves the after-hook fallback map', async () => {
    const persistFailure = vi.fn(async () => false);
    const { hook, inputValue, outputValue, failures } = runHook(
      { model: { ...DEFAULT_MODEL, limit: { context: 1_000_000, output: 32_768 } } },
      output(),
      { persistFailure },
    );
    await expect(hook(inputValue, outputValue)).rejects.toBeInstanceOf(ReviewerOutputCapError);
    expect(failures.get('ses_reviewer')).toMatchObject({
      code: 'REVIEWER_OUTPUT_CAP_MODEL_LIMIT_TOO_SMALL',
    });
  });

  it('BAD: an invalid configured cap fails closed', async () => {
    const { hook, inputValue, outputValue } = runHook({}, output(), { outputTokenMax: 0 });
    await expect(hook(inputValue, outputValue)).rejects.toMatchObject({
      code: 'REVIEWER_OUTPUT_CAP_CONFIG_INVALID',
    });
    expect(outputValue.maxOutputTokens).toBe(32_000);
  });
});
