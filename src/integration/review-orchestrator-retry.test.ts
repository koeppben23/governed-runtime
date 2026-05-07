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
import { invokeReviewer, type OrchestratorClient } from './review-orchestrator.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Mock sleep function injected via options._sleepFn */
const mockSleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

/** Default test options that inject the mock sleep */
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
