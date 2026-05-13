/**
 * @module integration/review-orchestrator-retry.test
 * @description Tests for invokeReviewer retry logic (Fix 1).
 *
 * Validates:
 * - Retry on transient session.create failures (HAPPY recovery after retries)
 * - Retry on transient session.prompt failures (HAPPY recovery after retries)
 * - Retry on missing structured_output (HAPPY recovery after retries)
 * - NO retry on StructuredOutputError (deterministic, immediate null)
 * - Max retries exhaustion (returns null after all attempts)
 * - Exponential backoff timing
 * - Backward compatibility (no options = defaults)
 * - Custom retry configuration
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all categories present.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { invokeReviewer, type OrchestratorClient } from './orchestrator.js';
import {
  _resetAgentResolutionCache,
  _resetModelCapabilityCache,
  REVIEWER_AGENT_FALLBACK,
  REVIEWER_SYSTEM_DIRECTIVE,
} from './agent-resolution.js';
import {
  makeClient,
  NO_SLEEP,
  TEXT_COMPAT_OPTIONS,
  validFindings as sharedValidFindings,
  PROMPT as SHARED_PROMPT,
} from './orchestrator-test-helpers.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Mock sleep function injected via options._sleepFn */
const mockSleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

/** Default test options: SDK allowed for deterministic tests + mock sleep */
const TEST_OPTS = { _sleepFn: mockSleep } as const;

function validFindings(): Record<string, unknown> {
  return {
    iteration: 0,
    planVersion: 1,
    reviewMode: 'subagent',
    overallVerdict: 'approve',
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    reviewedBy: { sessionId: 'child-session-1' },
    reviewedAt: '2026-05-07T12:00:00.000Z',
    attestation: {
      mandateDigest: 'test-mandate-digest',
      criteriaVersion: 'p35-v1',
      toolObligationId: '11111111-1111-4111-8111-111111111111',
      iteration: 0,
      planVersion: 1,
      reviewedBy: 'flowguard-reviewer',
    },
  };
}

function successCreateResult() {
  return { data: { id: 'child-session-1' }, error: undefined };
}

function successPromptResult() {
  return {
    data: {
      parts: [{ type: 'text', text: JSON.stringify(validFindings()) }],
      info: { structured_output: validFindings() },
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
    data: {
      parts: [{ type: 'text', text: 'some text' }],
      info: { structured_output: undefined },
    },
    error: undefined,
  };
}

function structuredOutputErrorResult() {
  return {
    data: {
      parts: [],
      info: {
        structured_output: undefined,
        error: { name: 'StructuredOutputError', message: 'schema validation failed' },
      },
    },
    error: undefined,
  };
}

// ─── Mock retrySleep via dependency injection (options._sleepFn) ─────────────
// No vi.mock needed — the injected mockSleep is used directly by invokeReviewer.

// ═══════════════════════════════════════════════════════════════════════════════
// invokeReviewer — Retry Logic
// ═══════════════════════════════════════════════════════════════════════════════

describe('invokeReviewer — retry logic', () => {
  const PROMPT = 'Review this plan...';
  const PARENT_ID = 'parent-session-1';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── HAPPY: Recovery after transient failures ─────────────────────────────

  describe('HAPPY: transient recovery', () => {
    it('succeeds on first attempt without retries (baseline)', async () => {
      const client: OrchestratorClient = {
        session: {
          create: vi.fn().mockResolvedValue(successCreateResult()),
          prompt: vi.fn().mockResolvedValue(successPromptResult()),
        },
      };

      const result = await invokeReviewer(client, PROMPT, PARENT_ID, TEST_OPTS);

      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe('child-session-1');
      expect(result!.findings!.overallVerdict).toBe('approve');
      expect(client.session.create).toHaveBeenCalledTimes(1);
      expect(client.session.prompt).toHaveBeenCalledTimes(1);
      expect(mockSleep).not.toHaveBeenCalled();
    });

    it('recovers after 1 session.create failure', async () => {
      const client: OrchestratorClient = {
        session: {
          create: vi
            .fn()
            .mockResolvedValueOnce(failCreateResult())
            .mockResolvedValueOnce(successCreateResult()),
          prompt: vi.fn().mockResolvedValue(successPromptResult()),
        },
      };

      const result = await invokeReviewer(client, PROMPT, PARENT_ID, TEST_OPTS);

      expect(result).not.toBeNull();
      expect(result!.findings!.overallVerdict).toBe('approve');
      expect(client.session.create).toHaveBeenCalledTimes(2);
      expect(mockSleep).toHaveBeenCalledTimes(1);
    });

    it('recovers after 2 session.create failures (max retries default=2)', async () => {
      const client: OrchestratorClient = {
        session: {
          create: vi
            .fn()
            .mockResolvedValueOnce(failCreateResult())
            .mockResolvedValueOnce(failCreateResult())
            .mockResolvedValueOnce(successCreateResult()),
          prompt: vi.fn().mockResolvedValue(successPromptResult()),
        },
      };

      const result = await invokeReviewer(client, PROMPT, PARENT_ID, TEST_OPTS);

      expect(result).not.toBeNull();
      expect(client.session.create).toHaveBeenCalledTimes(3);
      expect(mockSleep).toHaveBeenCalledTimes(2);
    });

    it('recovers after 1 session.prompt failure', async () => {
      const client: OrchestratorClient = {
        session: {
          create: vi.fn().mockResolvedValue(successCreateResult()),
          prompt: vi
            .fn()
            .mockResolvedValueOnce(failPromptResult())
            .mockResolvedValueOnce(successPromptResult()),
        },
      };

      const result = await invokeReviewer(client, PROMPT, PARENT_ID, TEST_OPTS);

      expect(result).not.toBeNull();
      // Create is called on each retry attempt (fresh session each time)
      expect(client.session.create).toHaveBeenCalledTimes(2);
      expect(client.session.prompt).toHaveBeenCalledTimes(2);
    });

    it('recovers after missing structured_output on first attempt', async () => {
      const client: OrchestratorClient = {
        session: {
          create: vi.fn().mockResolvedValue(successCreateResult()),
          prompt: vi
            .fn()
            .mockResolvedValueOnce(noStructuredOutputResult())
            .mockResolvedValueOnce(successPromptResult()),
        },
      };

      const result = await invokeReviewer(client, PROMPT, PARENT_ID, TEST_OPTS);

      expect(result).not.toBeNull();
      expect(result!.findings!.overallVerdict).toBe('approve');
    });
  });

  // ─── BAD: All retries exhausted ───────────────────────────────────────────

  describe('BAD: retries exhausted', () => {
    it('returns null after all create attempts fail (default 3 total)', async () => {
      const client: OrchestratorClient = {
        session: {
          create: vi.fn().mockResolvedValue(failCreateResult()),
          prompt: vi.fn().mockResolvedValue(successPromptResult()),
        },
      };

      const result = await invokeReviewer(client, PROMPT, PARENT_ID, TEST_OPTS);

      expect(result).toBeNull();
      expect(client.session.create).toHaveBeenCalledTimes(3); // 1 + 2 retries
      expect(client.session.prompt).not.toHaveBeenCalled();
    });

    it('returns null after all prompt attempts fail (default 3 total)', async () => {
      const client: OrchestratorClient = {
        session: {
          create: vi.fn().mockResolvedValue(successCreateResult()),
          prompt: vi.fn().mockResolvedValue(failPromptResult()),
        },
      };

      const result = await invokeReviewer(client, PROMPT, PARENT_ID, TEST_OPTS);

      expect(result).toBeNull();
      expect(client.session.create).toHaveBeenCalledTimes(3);
      expect(client.session.prompt).toHaveBeenCalledTimes(3);
    });

    it('returns null after all attempts have no structured_output', async () => {
      const client: OrchestratorClient = {
        session: {
          create: vi.fn().mockResolvedValue(successCreateResult()),
          prompt: vi.fn().mockResolvedValue(noStructuredOutputResult()),
        },
      };

      const result = await invokeReviewer(client, PROMPT, PARENT_ID, TEST_OPTS);

      expect(result).toBeNull();
      expect(client.session.prompt).toHaveBeenCalledTimes(3);
    });
  });

  // ─── EDGE: StructuredOutputError — no retry ───────────────────────────────

  describe('EDGE: StructuredOutputError (deterministic, no retry)', () => {
    it('returns null immediately without retrying on StructuredOutputError', async () => {
      const client: OrchestratorClient = {
        session: {
          create: vi.fn().mockResolvedValue(successCreateResult()),
          prompt: vi.fn().mockResolvedValue(structuredOutputErrorResult()),
        },
      };

      const result = await invokeReviewer(client, PROMPT, PARENT_ID, TEST_OPTS);

      expect(result).toBeNull();
      // Only 1 attempt — no retry for deterministic failures
      expect(client.session.create).toHaveBeenCalledTimes(1);
      expect(client.session.prompt).toHaveBeenCalledTimes(1);
      expect(mockSleep).not.toHaveBeenCalled();
    });
  });

  // ─── CORNER: Custom options ───────────────────────────────────────────────

  describe('CORNER: custom retry options', () => {
    it('respects maxRetries=0 (no retries)', async () => {
      const client: OrchestratorClient = {
        session: {
          create: vi.fn().mockResolvedValue(failCreateResult()),
          prompt: vi.fn().mockResolvedValue(successPromptResult()),
        },
      };

      const result = await invokeReviewer(client, PROMPT, PARENT_ID, {
        maxRetries: 0,
        _sleepFn: mockSleep,
      });

      expect(result).toBeNull();
      expect(client.session.create).toHaveBeenCalledTimes(1);
      expect(mockSleep).not.toHaveBeenCalled();
    });

    it('respects maxRetries=5 (5 retries = 6 total attempts)', async () => {
      const client: OrchestratorClient = {
        session: {
          create: vi
            .fn()
            .mockResolvedValueOnce(failCreateResult())
            .mockResolvedValueOnce(failCreateResult())
            .mockResolvedValueOnce(failCreateResult())
            .mockResolvedValueOnce(failCreateResult())
            .mockResolvedValueOnce(failCreateResult())
            .mockResolvedValueOnce(successCreateResult()),
          prompt: vi.fn().mockResolvedValue(successPromptResult()),
        },
      };

      const result = await invokeReviewer(client, PROMPT, PARENT_ID, {
        maxRetries: 5,
        _sleepFn: mockSleep,
      });

      expect(result).not.toBeNull();
      expect(client.session.create).toHaveBeenCalledTimes(6);
    });

    it('uses custom baseDelayMs for backoff', async () => {
      const client: OrchestratorClient = {
        session: {
          create: vi
            .fn()
            .mockResolvedValueOnce(failCreateResult())
            .mockResolvedValueOnce(failCreateResult())
            .mockResolvedValueOnce(successCreateResult()),
          prompt: vi.fn().mockResolvedValue(successPromptResult()),
        },
      };

      await invokeReviewer(client, PROMPT, PARENT_ID, { baseDelayMs: 500, _sleepFn: mockSleep });

      // Backoff: attempt 2 = 500 * 2^0 = 500, attempt 3 = 500 * 2^1 = 1000
      expect(mockSleep).toHaveBeenCalledTimes(2);
      expect(mockSleep).toHaveBeenNthCalledWith(1, 500);
      expect(mockSleep).toHaveBeenNthCalledWith(2, 1000);
    });
  });

  // ─── CORNER: Exponential backoff verification ─────────────────────────────

  describe('CORNER: exponential backoff timing', () => {
    it('applies exponential backoff with default baseDelayMs=1000', async () => {
      const client: OrchestratorClient = {
        session: {
          create: vi.fn().mockResolvedValue(failCreateResult()),
          prompt: vi.fn().mockResolvedValue(successPromptResult()),
        },
      };

      await invokeReviewer(client, PROMPT, PARENT_ID, TEST_OPTS);

      // Default: 2 retries → 2 sleeps
      // Attempt 2: 1000 * 2^(2-2) = 1000 * 1 = 1000
      // Attempt 3: 1000 * 2^(3-2) = 1000 * 2 = 2000
      expect(mockSleep).toHaveBeenCalledTimes(2);
      expect(mockSleep).toHaveBeenNthCalledWith(1, 1000);
      expect(mockSleep).toHaveBeenNthCalledWith(2, 2000);
    });
  });

  // ─── EDGE: Mixed failure modes across attempts ────────────────────────────

  describe('EDGE: mixed failure modes', () => {
    it('create fails then prompt fails then succeeds', async () => {
      const client: OrchestratorClient = {
        session: {
          create: vi
            .fn()
            .mockResolvedValueOnce(failCreateResult())
            .mockResolvedValueOnce(successCreateResult())
            .mockResolvedValueOnce(successCreateResult()),
          prompt: vi
            .fn()
            .mockResolvedValueOnce(failPromptResult())
            .mockResolvedValueOnce(successPromptResult()),
        },
      };

      const result = await invokeReviewer(client, PROMPT, PARENT_ID, TEST_OPTS);

      expect(result).not.toBeNull();
      expect(result!.findings!.overallVerdict).toBe('approve');
    });

    it('StructuredOutputError on second attempt after transient failure returns null immediately', async () => {
      // First attempt: transient create failure (retryable)
      // Second attempt: create succeeds, prompt returns StructuredOutputError (not retryable)
      const client: OrchestratorClient = {
        session: {
          create: vi
            .fn()
            .mockResolvedValueOnce(failCreateResult())
            .mockResolvedValueOnce(successCreateResult()),
          prompt: vi.fn().mockResolvedValue(structuredOutputErrorResult()),
        },
      };

      const result = await invokeReviewer(client, PROMPT, PARENT_ID, TEST_OPTS);

      expect(result).toBeNull();
      // 2 create attempts (1 fail + 1 success), then StructuredOutputError stops immediately
      expect(client.session.create).toHaveBeenCalledTimes(2);
      expect(client.session.prompt).toHaveBeenCalledTimes(1);
    });
  });

  // ─── EDGE: Backward compatibility ────────────────────────────────────────

  describe('EDGE: backward compatibility', () => {
    it('works without options parameter (uses defaults)', async () => {
      const client: OrchestratorClient = {
        session: {
          create: vi.fn().mockResolvedValue(successCreateResult()),
          prompt: vi.fn().mockResolvedValue(successPromptResult()),
        },
      };

      const result = await invokeReviewer(client, PROMPT, PARENT_ID);

      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe('child-session-1');
    });

    it('injects authoritative sessionId into findings.reviewedBy', async () => {
      const client: OrchestratorClient = {
        session: {
          create: vi.fn().mockResolvedValue(successCreateResult()),
          prompt: vi.fn().mockResolvedValue(successPromptResult()),
        },
      };

      const result = await invokeReviewer(client, PROMPT, PARENT_ID);

      expect(result).not.toBeNull();
      const reviewedBy = result!.findings!.reviewedBy as Record<string, unknown>;
      expect(reviewedBy.sessionId).toBe('child-session-1');
    });
  });
});

describe('invokeReviewer — format-free retry fallback', () => {
  /**
   * Helper: creates a client where the first prompt call triggers
   * model_capability_incompatible, and the second call (format-free retry)
   * returns a configurable text response.
   */
  function makeSequentialClient(opts: {
    agents?: Array<Record<string, unknown>>;
    formatFreeResult?: {
      data?: {
        parts?: Array<{ type?: string; text?: string }>;
        info?: Record<string, unknown>;
      };
      error?: unknown;
    };
    errorMessage?: string;
  }): OrchestratorClient {
    const errorMsg = opts.errorMessage ?? 'deepseek-reasoner does not support this tool_choice';

    // First call: returns tool_choice incompatibility error
    // Second call: returns the format-free retry result
    const promptFn = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          parts: [],
          info: {
            error: {
              name: 'APIError',
              message: errorMsg,
              data: { statusCode: 400, isRetryable: false },
            },
          },
        },
        error: undefined,
      })
      .mockResolvedValueOnce(
        opts.formatFreeResult ?? {
          data: {
            parts: [{ type: 'text', text: JSON.stringify(sharedValidFindings()) }],
            info: {},
          },
          error: undefined,
        },
      );

    return {
      app: {
        agents: vi.fn().mockResolvedValue({
          data: opts.agents ?? [{ id: 'flowguard-reviewer', name: 'flowguard-reviewer' }],
        }),
      },
      session: {
        create: vi
          .fn()
          .mockResolvedValueOnce({ data: { id: 'child-session-1' }, error: undefined })
          .mockResolvedValueOnce({ data: { id: 'retry-session-1' }, error: undefined }),
        prompt: promptFn,
      },
    };
  }

  beforeEach(() => {
    _resetAgentResolutionCache();
    _resetModelCapabilityCache();
  });

  // ─── HAPPY ──────────────────────────────────────────────────────────────────

  describe('HAPPY — format-free retry succeeds', () => {
    it('T11: returns valid findings when format-free retry produces pure JSON text', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      const client = makeSequentialClient({});
      const result = await invokeReviewer(client, SHARED_PROMPT, 'parent-1', {
        maxRetries: 0,
        ...TEXT_COMPAT_OPTIONS,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });

      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe('retry-session-1');
      expect(result!.findings.overallVerdict).toBe('approve');
      expect(result!.findings.reviewMode).toBe('subagent');
      expect(result!.reviewOutputMode).toBe('text_compat');
      expect(result!.structuredOutputUsed).toBe(false);
      expect(result!.reviewAssuranceLevel).toBe('text_compat_lower');
      expect(result!.extractionMethod).toBe('direct_json');
      expect(result!.modelCapabilityError).toContain('tool_choice');
    });

    it('T11b: blocks text compatibility when policy requires structured output', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      const client = makeSequentialClient({});
      const result = await invokeReviewer(client, SHARED_PROMPT, 'parent-1', {
        maxRetries: 0,
        _sleepFn: NO_SLEEP,
        reviewOutputPolicy: 'structured_required',
        _onAttemptFailed: (info) => diagnostics.push(info),
      });

      expect(result).toBeNull();
      expect(diagnostics.some((d) => d.step === 'model_capability_incompatible')).toBe(true);
      expect(diagnostics.some((d) => d.step === 'text_compat_blocked_by_policy')).toBe(true);
      expect(client.session.prompt).toHaveBeenCalledTimes(1);
    });

    it('T11c: defaults to structured_required and does not retry text compatibility', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      const client = makeSequentialClient({});
      const result = await invokeReviewer(client, SHARED_PROMPT, 'parent-1', {
        maxRetries: 0,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });

      expect(result).toBeNull();
      expect(diagnostics.some((d) => d.step === 'model_capability_incompatible')).toBe(true);
      expect(diagnostics.some((d) => d.step === 'text_compat_blocked_by_policy')).toBe(true);
      expect(client.session.create).toHaveBeenCalledTimes(1);
      expect(client.session.prompt).toHaveBeenCalledTimes(1);
    });

    it('T12: parses JSON from markdown code-fenced response', async () => {
      const fencedJson = '```json\n' + JSON.stringify(sharedValidFindings()) + '\n```';
      const client = makeSequentialClient({
        formatFreeResult: {
          data: {
            parts: [{ type: 'text', text: fencedJson }],
            info: {},
          },
          error: undefined,
        },
      });
      const result = await invokeReviewer(client, SHARED_PROMPT, 'parent-1', {
        maxRetries: 0,
        ...TEXT_COMPAT_OPTIONS,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: () => {},
      });

      expect(result).not.toBeNull();
      expect(result!.findings.overallVerdict).toBe('approve');
    });

    it('T13: parses JSON via brace-extraction when text has preamble', async () => {
      const withPreamble =
        'Here is my review:\n\n' + JSON.stringify(sharedValidFindings()) + '\n\nEnd of review.';
      const client = makeSequentialClient({
        formatFreeResult: {
          data: {
            parts: [{ type: 'text', text: withPreamble }],
            info: {},
          },
          error: undefined,
        },
      });
      const result = await invokeReviewer(client, SHARED_PROMPT, 'parent-1', {
        maxRetries: 0,
        ...TEXT_COMPAT_OPTIONS,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: () => {},
      });

      expect(result).not.toBeNull();
      expect(result!.findings.overallVerdict).toBe('approve');
      expect(result!.findings.blockingIssues).toEqual([]);
    });

    it('T14: authoritatively injects sessionId on format-free retry path', async () => {
      const findingsWithWrongSession = sharedValidFindings({
        reviewedBy: { sessionId: 'wrong-session-id' },
      });
      const client = makeSequentialClient({
        formatFreeResult: {
          data: {
            parts: [{ type: 'text', text: JSON.stringify(findingsWithWrongSession) }],
            info: {},
          },
          error: undefined,
        },
      });
      const result = await invokeReviewer(client, SHARED_PROMPT, 'parent-1', {
        maxRetries: 0,
        ...TEXT_COMPAT_OPTIONS,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: () => {},
      });

      expect(result).not.toBeNull();
      // Authoritative injection overwrites subagent's guess
      expect((result!.findings.reviewedBy as Record<string, unknown>).sessionId).toBe(
        'retry-session-1',
      );
    });

    it('T14b: injects sessionId when reviewedBy is missing entirely', async () => {
      const findingsNoReviewedBy = sharedValidFindings();
      delete findingsNoReviewedBy.reviewedBy;
      const client = makeSequentialClient({
        formatFreeResult: {
          data: {
            parts: [{ type: 'text', text: JSON.stringify(findingsNoReviewedBy) }],
            info: {},
          },
          error: undefined,
        },
      });
      const result = await invokeReviewer(client, SHARED_PROMPT, 'parent-1', {
        maxRetries: 0,
        ...TEXT_COMPAT_OPTIONS,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: () => {},
      });

      expect(result).not.toBeNull();
      expect((result!.findings.reviewedBy as Record<string, unknown>).sessionId).toBe(
        'retry-session-1',
      );
    });

    it('T14c: joins multiple text parts into single JSON', async () => {
      const fullJson = JSON.stringify(sharedValidFindings());
      const half1 = fullJson.slice(0, Math.floor(fullJson.length / 2));
      const half2 = fullJson.slice(Math.floor(fullJson.length / 2));
      const client = makeSequentialClient({
        formatFreeResult: {
          data: {
            parts: [
              { type: 'text', text: half1 },
              { type: 'text', text: half2 },
            ],
            info: {},
          },
          error: undefined,
        },
      });
      const result = await invokeReviewer(client, SHARED_PROMPT, 'parent-1', {
        maxRetries: 0,
        ...TEXT_COMPAT_OPTIONS,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: () => {},
      });

      expect(result).not.toBeNull();
      expect(result!.findings.overallVerdict).toBe('approve');
    });
  });

  // ─── BAD ────────────────────────────────────────────────────────────────────

  describe('BAD — format-free retry failures', () => {
    it('T15: returns null when format-free retry prompt returns error', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      const client = makeSequentialClient({
        formatFreeResult: {
          data: undefined,
          error: { message: 'rate limit exceeded', statusCode: 429 },
        },
      });
      const result = await invokeReviewer(client, SHARED_PROMPT, 'parent-1', {
        maxRetries: 0,
        ...TEXT_COMPAT_OPTIONS,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });

      expect(result).toBeNull();
      const retryFailed = diagnostics.find((d) => d.step === 'format_free_retry_failed');
      expect(retryFailed).toBeDefined();
      expect(retryFailed!.error).toEqual({ message: 'rate limit exceeded', statusCode: 429 });
      expect((retryFailed!.details as Record<string, unknown>).childSessionId).toBe(
        'retry-session-1',
      );
    });

    it('T16: returns null when format-free retry returns empty text', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      const client = makeSequentialClient({
        formatFreeResult: {
          data: { parts: [], info: {} },
          error: undefined,
        },
      });
      const result = await invokeReviewer(client, SHARED_PROMPT, 'parent-1', {
        maxRetries: 0,
        ...TEXT_COMPAT_OPTIONS,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });

      expect(result).toBeNull();
      const retryEmpty = diagnostics.find((d) => d.step === 'format_free_retry_empty');
      expect(retryEmpty).toBeDefined();
      expect((retryEmpty!.details as Record<string, unknown>).partsCount).toBe(0);
    });

    it('T16b: returns null when parts contain only non-text types', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      const client = makeSequentialClient({
        formatFreeResult: {
          data: {
            parts: [
              { type: 'tool_call', text: undefined },
              { type: 'image', text: undefined },
            ],
            info: {},
          },
          error: undefined,
        },
      });
      const result = await invokeReviewer(client, SHARED_PROMPT, 'parent-1', {
        maxRetries: 0,
        ...TEXT_COMPAT_OPTIONS,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });

      expect(result).toBeNull();
      const retryEmpty = diagnostics.find((d) => d.step === 'format_free_retry_empty');
      expect(retryEmpty).toBeDefined();
    });

    it('T17: returns null when format-free retry text is not parseable JSON', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      const client = makeSequentialClient({
        formatFreeResult: {
          data: {
            parts: [{ type: 'text', text: 'I cannot produce a review in JSON format.' }],
            info: {},
          },
          error: undefined,
        },
      });
      const result = await invokeReviewer(client, SHARED_PROMPT, 'parent-1', {
        maxRetries: 0,
        ...TEXT_COMPAT_OPTIONS,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });

      expect(result).toBeNull();
      const parseFailed = diagnostics.find((d) => d.step === 'format_free_retry_parse_failed');
      expect(parseFailed).toBeDefined();
      const details = parseFailed!.details as Record<string, unknown>;
      expect(details.textLength).toBeGreaterThan(0);
      expect(details.textPreview).toContain('cannot produce');
    });

    it('T17b: returns null when text contains invalid JSON (malformed braces)', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      const client = makeSequentialClient({
        formatFreeResult: {
          data: {
            parts: [{ type: 'text', text: '{"overallVerdict": "approve", "broken' }],
            info: {},
          },
          error: undefined,
        },
      });
      const result = await invokeReviewer(client, SHARED_PROMPT, 'parent-1', {
        maxRetries: 0,
        ...TEXT_COMPAT_OPTIONS,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });

      expect(result).toBeNull();
      const parseFailed = diagnostics.find((d) => d.step === 'format_free_retry_parse_failed');
      expect(parseFailed).toBeDefined();
    });

    it('T17c: returns null when promptResult.data is null', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      const client = makeSequentialClient({
        formatFreeResult: {
          data: null as unknown as undefined,
          error: undefined,
        },
      });
      const result = await invokeReviewer(client, SHARED_PROMPT, 'parent-1', {
        maxRetries: 0,
        ...TEXT_COMPAT_OPTIONS,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });

      expect(result).toBeNull();
      const retryFailed = diagnostics.find((d) => d.step === 'format_free_retry_failed');
      expect(retryFailed).toBeDefined();
    });
  });

  // ─── CORNER ─────────────────────────────────────────────────────────────────

  describe('CORNER — edge conditions on format-free retry', () => {
    it('T18: format-free retry does NOT fire for unrelated info.error', async () => {
      // Unrelated error: "request timed out" — no "does not support" + capability keyword
      const diagnostics: Array<Record<string, unknown>> = [];
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: {
          data: {
            parts: [],
            info: { error: { name: 'TimeoutError', message: 'request timed out' } },
          },
          error: undefined,
        },
      });
      await invokeReviewer(client, SHARED_PROMPT, 'parent-1', {
        maxRetries: 0,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });

      // info_error + no_findings fire, but NO format_free_retry_* steps
      const formatFreeSteps = diagnostics.filter((d) =>
        (d.step as string).startsWith('format_free_retry'),
      );
      expect(formatFreeSteps).toHaveLength(0);
      expect(diagnostics.some((d) => d.step === 'info_error')).toBe(true);
      expect(diagnostics.some((d) => d.step === 'no_findings')).toBe(true);
    });

    it('T18b: format-free retry fires only ONCE (no retry loop within retry)', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      const client = makeSequentialClient({
        formatFreeResult: {
          data: {
            parts: [{ type: 'text', text: 'not json at all' }],
            info: {},
          },
          error: undefined,
        },
      });
      await invokeReviewer(client, SHARED_PROMPT, 'parent-1', {
        maxRetries: 2, // outer retries available but NOT used
        ...TEXT_COMPAT_OPTIONS,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });

      // prompt called exactly 2 times: original + format-free retry (no outer retry)
      expect(client.session.prompt).toHaveBeenCalledTimes(2);
      // All on attempt 1
      const attempts = [...new Set(diagnostics.map((d) => d.attempt))];
      expect(attempts).toEqual([1]);
    });

    it('T19: format-free retry injects system directive for fallback agent', async () => {
      _resetAgentResolutionCache();
      _resetModelCapabilityCache();
      // No 'flowguard-reviewer' in agents list → falls back to 'general'
      const promptFn = vi
        .fn()
        .mockResolvedValueOnce({
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
        })
        .mockResolvedValueOnce({
          data: {
            parts: [{ type: 'text', text: JSON.stringify(sharedValidFindings()) }],
            info: {},
          },
          error: undefined,
        });

      const client: OrchestratorClient = {
        app: {
          agents: vi.fn().mockResolvedValue({ data: [{ id: 'build' }, { id: 'plan' }] }),
        },
        session: {
          create: vi.fn().mockResolvedValue({ data: { id: 'child-session-1' }, error: undefined }),
          prompt: promptFn,
        },
      };

      const result = await invokeReviewer(client, SHARED_PROMPT, 'parent-1', {
        maxRetries: 0,
        ...TEXT_COMPAT_OPTIONS,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: () => {},
      });

      expect(result).not.toBeNull();

      // Verify format-free retry call includes system directive
      const secondCall = promptFn.mock.calls[1]!;
      const secondBody = secondCall[0].body;
      expect(secondBody.system).toBe(REVIEWER_SYSTEM_DIRECTIVE);
      expect(secondBody.agent).toBe(REVIEWER_AGENT_FALLBACK);
      // No format field
      expect(secondBody.format).toBeUndefined();
    });

    it('T19b: format-free retry does NOT inject system directive for primary agent', async () => {
      const client = makeSequentialClient({});
      await invokeReviewer(client, SHARED_PROMPT, 'parent-1', {
        maxRetries: 0,
        ...TEXT_COMPAT_OPTIONS,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: () => {},
      });

      // Second call (format-free retry) should NOT have system field
      const promptFn = client.session.prompt as ReturnType<typeof vi.fn>;
      const secondCall = promptFn.mock.calls[1]!;
      const secondBody = secondCall[0].body;
      expect(secondBody.system).toBeUndefined();
      expect(secondBody.agent).toBe('flowguard-reviewer');
    });

    it('T20: format-free retry body has no format field', async () => {
      const client = makeSequentialClient({});
      await invokeReviewer(client, SHARED_PROMPT, 'parent-1', {
        maxRetries: 0,
        ...TEXT_COMPAT_OPTIONS,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: () => {},
      });

      const promptFn = client.session.prompt as ReturnType<typeof vi.fn>;
      // First call has format
      const firstBody = promptFn.mock.calls[0]![0].body;
      expect(firstBody.format).toBeDefined();
      expect(firstBody.format.type).toBe('json_schema');
      // Second call (format-free) has NO format
      const secondBody = promptFn.mock.calls[1]![0].body;
      expect(secondBody.format).toBeUndefined();
    });

    it('T21: rawResponse is JSON.stringify of extracted findings', async () => {
      const client = makeSequentialClient({});
      const result = await invokeReviewer(client, SHARED_PROMPT, 'parent-1', {
        maxRetries: 0,
        ...TEXT_COMPAT_OPTIONS,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: () => {},
      });

      expect(result).not.toBeNull();
      const parsed = JSON.parse(result!.rawResponse);
      expect(parsed.overallVerdict).toBe('approve');
      expect(parsed.reviewedBy.sessionId).toBe('retry-session-1');
    });
  });

  // ─── EDGE ───────────────────────────────────────────────────────────────────

  describe('EDGE — boundary conditions', () => {
    it('T22: format-free retry with whitespace-only text returns null', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      const client = makeSequentialClient({
        formatFreeResult: {
          data: {
            parts: [{ type: 'text', text: '   \n\t  \n  ' }],
            info: {},
          },
          error: undefined,
        },
      });
      const result = await invokeReviewer(client, SHARED_PROMPT, 'parent-1', {
        maxRetries: 0,
        ...TEXT_COMPAT_OPTIONS,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });

      expect(result).toBeNull();
      const parseFailed = diagnostics.find((d) => d.step === 'format_free_retry_parse_failed');
      expect(parseFailed).toBeDefined();
    });

    it('T23: format-free retry with only primitive JSON (no object) returns null', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      const client = makeSequentialClient({
        formatFreeResult: {
          data: {
            // Pure string, number, or boolean JSON — no braces at all
            parts: [{ type: 'text', text: '"just a string value"' }],
            info: {},
          },
          error: undefined,
        },
      });
      const result = await invokeReviewer(client, SHARED_PROMPT, 'parent-1', {
        maxRetries: 0,
        ...TEXT_COMPAT_OPTIONS,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });

      // extractJsonFromText returns null for non-object JSON
      expect(result).toBeNull();
      const parseFailed = diagnostics.find((d) => d.step === 'format_free_retry_parse_failed');
      expect(parseFailed).toBeDefined();
    });

    it('T24: format-free retry with "tools" variant error message also triggers', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      const promptFn = vi
        .fn()
        .mockResolvedValueOnce({
          data: {
            parts: [],
            info: {
              error: {
                name: 'APIError',
                message: 'This model does not support tools in the current configuration',
              },
            },
          },
          error: undefined,
        })
        .mockResolvedValueOnce({
          data: {
            parts: [{ type: 'text', text: JSON.stringify(sharedValidFindings()) }],
            info: {},
          },
          error: undefined,
        });

      const client: OrchestratorClient = {
        app: {
          agents: vi.fn().mockResolvedValue({
            data: [{ id: 'flowguard-reviewer', name: 'flowguard-reviewer' }],
          }),
        },
        session: {
          create: vi.fn().mockResolvedValue({ data: { id: 'child-session-1' }, error: undefined }),
          prompt: promptFn,
        },
      };

      const result = await invokeReviewer(client, SHARED_PROMPT, 'parent-1', {
        maxRetries: 0,
        ...TEXT_COMPAT_OPTIONS,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });

      expect(result).not.toBeNull();
      expect(result!.findings.overallVerdict).toBe('approve');
      expect(diagnostics.some((d) => d.step === 'model_capability_incompatible')).toBe(true);
    });

    it('T25: format-free retry uses NEW childSessionId (separate from primary attempt)', async () => {
      const client = makeSequentialClient({});
      await invokeReviewer(client, SHARED_PROMPT, 'parent-1', {
        maxRetries: 0,
        ...TEXT_COMPAT_OPTIONS,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: () => {},
      });

      const promptFn = client.session.prompt as ReturnType<typeof vi.fn>;
      // First call: original session
      expect(promptFn.mock.calls[0]![0].path.id).toBe('child-session-1');
      // Second call: NEW retry session (different ID for UI visibility)
      expect(promptFn.mock.calls[1]![0].path.id).toBe('retry-session-1');
    });

    it('T26: format-free retry uses same prompt text as original call', async () => {
      const client = makeSequentialClient({});
      await invokeReviewer(client, SHARED_PROMPT, 'parent-1', {
        maxRetries: 0,
        ...TEXT_COMPAT_OPTIONS,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: () => {},
      });

      const promptFn = client.session.prompt as ReturnType<typeof vi.fn>;
      const firstParts = promptFn.mock.calls[0]![0].body.parts;
      const secondParts = promptFn.mock.calls[1]![0].body.parts;
      expect(firstParts[0].text).toBe(SHARED_PROMPT);
      expect(secondParts[0].text).toBe(SHARED_PROMPT);
    });
  });

  // ─── E2E ────────────────────────────────────────────────────────────────────

  describe('E2E — full format-free retry flow', () => {
    it('T27: complete flow: incompatible model → format-free retry → valid findings', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      const findings = sharedValidFindings({
        overallVerdict: 'changes_requested',
        blockingIssues: [{ title: 'Missing error handling', severity: 'high' }],
      });
      const client = makeSequentialClient({
        formatFreeResult: {
          data: {
            parts: [
              { type: 'text', text: 'Here is my structured review:\n```json\n' },
              { type: 'text', text: JSON.stringify(findings) },
              { type: 'text', text: '\n```\n' },
            ],
            info: {},
          },
          error: undefined,
        },
      });

      const result = await invokeReviewer(client, SHARED_PROMPT, 'parent-1', {
        maxRetries: 2,
        ...TEXT_COMPAT_OPTIONS,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });

      // Success
      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe('retry-session-1');
      expect(result!.findings.overallVerdict).toBe('changes_requested');
      expect(result!.findings.blockingIssues).toHaveLength(1);

      // Diagnostics sequence: info_error → model_capability_incompatible (no retry steps since success)
      expect(diagnostics).toHaveLength(2);
      expect(diagnostics[0]!.step).toBe('info_error');
      expect(diagnostics[1]!.step).toBe('model_capability_incompatible');

      // New architecture: create called TWICE (original + retry session), prompt called twice
      expect(client.session.create).toHaveBeenCalledTimes(2);
      expect(client.session.prompt).toHaveBeenCalledTimes(2);
    });

    it('T28: complete flow with fallback agent (general) and system directive', async () => {
      _resetAgentResolutionCache();
      _resetModelCapabilityCache();
      const diagnostics: Array<Record<string, unknown>> = [];

      const promptFn = vi
        .fn()
        .mockResolvedValueOnce({
          data: {
            parts: [],
            info: {
              error: {
                name: 'APIError',
                message: 'does not support structured output',
              },
            },
          },
          error: undefined,
        })
        .mockResolvedValueOnce({
          data: {
            parts: [{ type: 'text', text: JSON.stringify(sharedValidFindings()) }],
            info: {},
          },
          error: undefined,
        });

      const client: OrchestratorClient = {
        app: {
          agents: vi.fn().mockResolvedValue({ data: [] }), // empty → fallback to 'general'
        },
        session: {
          create: vi.fn().mockResolvedValue({ data: { id: 'child-session-2' }, error: undefined }),
          prompt: promptFn,
        },
      };

      const result = await invokeReviewer(client, SHARED_PROMPT, 'parent-1', {
        maxRetries: 0,
        ...TEXT_COMPAT_OPTIONS,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });

      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe('child-session-2');
      expect((result!.findings.reviewedBy as Record<string, unknown>).sessionId).toBe(
        'child-session-2',
      );

      // Both calls use fallback agent with system directive
      const firstBody = promptFn.mock.calls[0]![0].body;
      const secondBody = promptFn.mock.calls[1]![0].body;
      expect(firstBody.agent).toBe('general');
      expect(secondBody.agent).toBe('general');
      expect(firstBody.system).toBe(REVIEWER_SYSTEM_DIRECTIVE);
      expect(secondBody.system).toBe(REVIEWER_SYSTEM_DIRECTIVE);
    });
  });

  // ─── SMOKE ──────────────────────────────────────────────────────────────────

  describe('SMOKE — format-free retry diagnostic completeness', () => {
    it('T29: all diagnostic steps are valid step union members', () => {
      const validSteps = [
        'agent_probe',
        'session_create',
        'session_prompt',
        'structured_output_error',
        'info_error',
        'model_capability_incompatible',
        'format_free_retry_session_create',
        'format_free_retry_failed',
        'format_free_retry_empty',
        'format_free_retry_parse_failed',
        'no_findings',
      ];
      // Every format_free_retry step is in the valid set
      expect(validSteps).toContain('format_free_retry_session_create');
      expect(validSteps).toContain('format_free_retry_failed');
      expect(validSteps).toContain('format_free_retry_empty');
      expect(validSteps).toContain('format_free_retry_parse_failed');
    });

    it('T30: format-free retry diagnostics include childSessionId for traceability', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      const client = makeSequentialClient({
        formatFreeResult: {
          data: {
            parts: [{ type: 'text', text: 'unparseable garbage' }],
            info: {},
          },
          error: undefined,
        },
      });
      await invokeReviewer(client, SHARED_PROMPT, 'parent-1', {
        maxRetries: 0,
        ...TEXT_COMPAT_OPTIONS,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });

      const parseFailed = diagnostics.find((d) => d.step === 'format_free_retry_parse_failed');
      expect(parseFailed).toBeDefined();
      expect((parseFailed!.details as Record<string, unknown>).childSessionId).toBe(
        'retry-session-1',
      );
      expect((parseFailed!.details as Record<string, unknown>).textLength).toBeGreaterThan(0);
      expect((parseFailed!.details as Record<string, unknown>).textPreview).toBeDefined();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// MODEL CAPABILITY CACHE — removed global state guard
// ═══════════════════════════════════════════════════════════════════════════════
