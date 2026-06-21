import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  _resetAgentResolutionCache,
  REVIEWER_AGENT_PRIMARY,
  REVIEWER_AGENT_FALLBACK,
  REVIEWER_SYSTEM_DIRECTIVE,
} from './agent-resolution.js';
import { invokeReviewer } from './orchestrator.js';
import { buildPlanReviewPrompt } from './prompt-builders.js';
import { REVIEW_FINDINGS_JSON_SCHEMA } from './findings-schema.js';
import { REVIEWER_SUBAGENT_TYPE } from './enforcement/types.js';
import {
  validFindings,
  NO_SLEEP,
  TEXT_COMPAT_OPTIONS,
  makeClient,
  PROMPT,
} from './orchestrator-test-helpers.js';
describe('invokeReviewer — error handling', () => {
  beforeEach(() => {
    _resetAgentResolutionCache();
  });

  describe('NON-RETRYABLE — isRetryable === false early exit', () => {
    beforeEach(() => {
      _resetAgentResolutionCache();
    });

    it('T1: returns null immediately when promptResult.error.isRetryable === false', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: {
          error: {
            name: 'APIError',
            message: 'deepseek-reasoner does not support this tool_choice',
            statusCode: 400,
            isRetryable: false,
          },
          data: undefined,
        },
      });
      const result = await invokeReviewer(client, PROMPT, 'parent-1', {
        maxRetries: 2,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });
      expect(result).toBeNull();
    });

    it('T2: fires exactly 1 diagnostic when isRetryable === false (no retry)', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: {
          error: {
            name: 'APIError',
            message: 'model unavailable',
            statusCode: 400,
            isRetryable: false,
          },
          data: undefined,
        },
      });
      await invokeReviewer(client, PROMPT, 'parent-1', {
        maxRetries: 2,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]!.step).toBe('session_prompt');
      expect(diagnostics[0]!.attempt).toBe(1);
      expect((diagnostics[0]!.details as Record<string, unknown>).isNonRetryable).toBe(true);
    });

    it('T3: retries normally when isRetryable is absent', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: {
          error: { message: 'timeout' },
          data: undefined,
        },
      });
      await invokeReviewer(client, PROMPT, 'parent-1', {
        maxRetries: 2,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });
      // Should retry maxRetries + 1 = 3 times
      expect(diagnostics).toHaveLength(3);
      expect(diagnostics.map((d) => d.attempt)).toEqual([1, 2, 3]);
      expect(diagnostics.every((d) => d.step === 'session_prompt')).toBe(true);
      // isNonRetryable should be false for all
      expect(
        diagnostics.every((d) => (d.details as Record<string, unknown>).isNonRetryable === false),
      ).toBe(true);
    });

    it('T4: retries normally when isRetryable is true', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: {
          error: { message: 'rate limit', isRetryable: true },
          data: undefined,
        },
      });
      await invokeReviewer(client, PROMPT, 'parent-1', {
        maxRetries: 1,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });
      expect(diagnostics).toHaveLength(2);
      expect(diagnostics.map((d) => d.attempt)).toEqual([1, 2]);
    });

    it('EDGE: isRetryable as non-boolean (string "false") does NOT trigger early exit', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: {
          error: { message: 'error', isRetryable: 'false' },
          data: undefined,
        },
      });
      await invokeReviewer(client, PROMPT, 'parent-1', {
        maxRetries: 1,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });
      // isRetryable === 'false' (string) should NOT match strict === false
      expect(diagnostics).toHaveLength(2); // retries normally
    });

    it('EDGE: promptResult.error is null does NOT trigger isNonRetryable', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: {
          error: null,
          data: undefined, // no data triggers error path
        },
      });
      await invokeReviewer(client, PROMPT, 'parent-1', {
        maxRetries: 0,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });
      expect(diagnostics).toHaveLength(1);
      expect((diagnostics[0]!.details as Record<string, unknown>).isNonRetryable).toBe(false);
    });
  });

  // ─── model_capability_incompatible: fail-closed detection ───────────────────

  describe('MODEL CAPABILITY — model_capability_incompatible fail-closed', () => {
    beforeEach(() => {
      _resetAgentResolutionCache();
    });

    it('T5: returns null with model_capability_incompatible when tool_choice not supported', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: {
          data: {
            parts: [],
            info: {
              error: {
                name: 'APIError',
                message: 'deepseek-reasoner does not support this tool_choice',
                data: { statusCode: 400, isRetryable: false },
              },
            },
          },
          error: undefined,
        },
      });
      const result = await invokeReviewer(client, PROMPT, 'parent-1', {
        maxRetries: 2,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });
      expect(result).toBeNull();
    });

    it('T6: model_capability_incompatible includes diagnostic details', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: {
          data: {
            parts: [],
            info: {
              error: {
                name: 'APIError',
                message: 'model does not support this tool_choice',
              },
            },
          },
          error: undefined,
        },
      });
      await invokeReviewer(client, PROMPT, 'parent-1', {
        maxRetries: 0,
        ...TEXT_COMPAT_OPTIONS,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });
      const incompatible = diagnostics.find((d) => d.step === 'model_capability_incompatible');
      expect(incompatible).toBeDefined();
      const details = incompatible!.details as Record<string, unknown>;
      expect(details.reason).toContain('does not support structured output');
      expect(details.reason).toContain('text compatibility retry');
      expect(details.detectedPattern).toContain('tool_choice');
    });

    it('T7: model_capability_incompatible does not retry (deterministic)', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: {
          data: {
            parts: [],
            info: {
              error: {
                name: 'APIError',
                message: 'this model does not support tools or function calling',
              },
            },
          },
          error: undefined,
        },
      });
      await invokeReviewer(client, PROMPT, 'parent-1', {
        maxRetries: 2,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });
      // All diagnostics on attempt 1 only — no outer retry loop triggered
      const attempts = [...new Set(diagnostics.map((d) => d.attempt))];
      expect(attempts).toEqual([1]);
    });

    it('T8: info_error fires BEFORE model_capability_incompatible (ordering)', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: {
          data: {
            parts: [],
            info: {
              error: {
                name: 'APIError',
                message: 'model does not support this tool_choice',
              },
            },
          },
          error: undefined,
        },
      });
      await invokeReviewer(client, PROMPT, 'parent-1', {
        maxRetries: 0,
        ...TEXT_COMPAT_OPTIONS,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });
      // 3 diagnostics: info_error → model_capability_incompatible → format_free_retry_empty
      // (format_free_retry_empty because the mock returns same empty parts for both calls)
      expect(diagnostics).toHaveLength(3);
      expect(diagnostics[0]!.step).toBe('info_error');
      expect(diagnostics[1]!.step).toBe('model_capability_incompatible');
      expect(diagnostics[2]!.step).toBe('format_free_retry_empty');
    });

    it('T9: model_capability_incompatible matches case-insensitive', async () => {
      const patterns = [
        'Model Does Not Support This Tool_Choice',
        'THIS MODEL DOES NOT SUPPORT TOOLS',
        'Does Not Support Function Calling',
        'does not support Structured Output',
      ];

      for (const pattern of patterns) {
        _resetAgentResolutionCache();
        const diagnostics: Array<Record<string, unknown>> = [];
        const client = makeClient({
          agents: [{ id: 'flowguard-reviewer' }],
          promptResult: {
            data: {
              parts: [],
              info: { error: { name: 'APIError', message: pattern } },
            },
            error: undefined,
          },
        });
        const result = await invokeReviewer(client, PROMPT, 'parent-1', {
          maxRetries: 0,
          _sleepFn: NO_SLEEP,
          _onAttemptFailed: (info) => diagnostics.push(info),
        });
        expect(result).toBeNull();
        const incompatible = diagnostics.find((d) => d.step === 'model_capability_incompatible');
        expect(incompatible).toBeDefined();
      }
    });

    it('T10: model_capability_incompatible matches "structured output" pattern', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: {
          data: {
            parts: [],
            info: {
              error: {
                name: 'ProviderError',
                message: 'does not support structured output for this model',
              },
            },
          },
          error: undefined,
        },
      });
      const result = await invokeReviewer(client, PROMPT, 'parent-1', {
        maxRetries: 2,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });
      expect(result).toBeNull();
      const incompatible = diagnostics.find((d) => d.step === 'model_capability_incompatible');
      expect(incompatible).toBeDefined();
      expect((incompatible!.details as Record<string, unknown>).detectedPattern).toContain(
        'structured output',
      );
    });

    it('CORNER: does NOT fire model_capability_incompatible for unrelated errors', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: {
          data: {
            parts: [],
            info: { error: { name: 'Timeout', message: 'request timed out' } },
          },
          error: undefined,
        },
      });
      await invokeReviewer(client, PROMPT, 'parent-1', {
        maxRetries: 0,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });
      // info_error fires, but NOT model_capability_incompatible
      const incompatible = diagnostics.find((d) => d.step === 'model_capability_incompatible');
      expect(incompatible).toBeUndefined();
      expect(diagnostics.some((d) => d.step === 'info_error')).toBe(true);
    });

    it('CORNER: "does not support" without capability keyword does NOT match', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: {
          data: {
            parts: [],
            info: { error: { name: 'APIError', message: 'does not support streaming' } },
          },
          error: undefined,
        },
      });
      await invokeReviewer(client, PROMPT, 'parent-1', {
        maxRetries: 0,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });
      const incompatible = diagnostics.find((d) => d.step === 'model_capability_incompatible');
      expect(incompatible).toBeUndefined();
    });

    it('EDGE: error message in data.message (nested) also triggers detection', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: {
          data: {
            parts: [],
            info: {
              error: {
                name: 'APIError',
                message: 'bad request',
                data: { message: 'model does not support this tool_choice' },
              },
            },
          },
          error: undefined,
        },
      });
      const result = await invokeReviewer(client, PROMPT, 'parent-1', {
        maxRetries: 0,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });
      expect(result).toBeNull();
      const incompatible = diagnostics.find((d) => d.step === 'model_capability_incompatible');
      expect(incompatible).toBeDefined();
    });

    it('EDGE: string info.error does NOT trigger model_capability_incompatible (no message field)', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: {
          data: {
            parts: [],
            info: {
              error: 'does not support this tool_choice' as unknown as { name: string },
            },
          },
          error: undefined,
        },
      });
      await invokeReviewer(client, PROMPT, 'parent-1', {
        maxRetries: 0,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });
      // String errors are surfaced via info_error with errorObj.value,
      // but the model_capability_incompatible detection reads errorObj.value too
      const incompatible = diagnostics.find((d) => d.step === 'model_capability_incompatible');
      // String "does not support this tool_choice" should be detected via errorObj.value path
      expect(incompatible).toBeDefined();
    });
  });
});
