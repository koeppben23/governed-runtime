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
describe('invokeReviewer — agent resolution + extraction', () => {
  beforeEach(() => {
    _resetAgentResolutionCache();
  });

  describe('HAPPY — primary path (flowguard-reviewer registered)', () => {
    it('sends agent: flowguard-reviewer without system directive', async () => {
      const client = makeClient({ agents: [{ id: 'flowguard-reviewer' }] });
      await invokeReviewer(client, PROMPT, 'parent-1', { _sleepFn: NO_SLEEP });

      expect(client.session.prompt).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            agent: 'flowguard-reviewer',
            parts: [{ type: 'text', text: PROMPT }],
            format: { type: 'json_schema', schema: REVIEW_FINDINGS_JSON_SCHEMA, retryCount: 1 },
          }),
        }),
      );

      // Verify NO system directive in primary path
      const call = (client.session.prompt as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.body.system).toBeUndefined();
    });

    it('returns findings from structured_output', async () => {
      const client = makeClient({ agents: [{ id: 'flowguard-reviewer' }] });
      const result = await invokeReviewer(client, PROMPT, 'parent-1', { _sleepFn: NO_SLEEP });

      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe('child-session-1');
      expect(result!.findings!.overallVerdict).toBe('accept');
    });

    it('probes only once across multiple invocations', async () => {
      const client = makeClient({ agents: [{ id: 'flowguard-reviewer' }] });

      await invokeReviewer(client, PROMPT, 'p1', { _sleepFn: NO_SLEEP });
      await invokeReviewer(client, PROMPT, 'p2', { _sleepFn: NO_SLEEP });
      await invokeReviewer(client, PROMPT, 'p3', { _sleepFn: NO_SLEEP });

      expect(client.app.agents).toHaveBeenCalledTimes(1);
    });
  });

  // ─── HAPPY: Fallback path ──────────────────────────────────────────────────

  describe('HAPPY — fallback path (general with system directive)', () => {
    it('sends agent: general WITH system directive when agent not registered', async () => {
      const client = makeClient({ agents: [] }); // no flowguard-reviewer
      await invokeReviewer(client, PROMPT, 'parent-1', { _sleepFn: NO_SLEEP });

      expect(client.session.prompt).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            agent: 'general',
            system: REVIEWER_SYSTEM_DIRECTIVE,
            parts: [{ type: 'text', text: PROMPT }],
            format: { type: 'json_schema', schema: REVIEW_FINDINGS_JSON_SCHEMA, retryCount: 1 },
          }),
        }),
      );
    });

    it('sends system directive when probe throws', async () => {
      const client = makeClient({ agentsThrows: true });
      await invokeReviewer(client, PROMPT, 'parent-1', { _sleepFn: NO_SLEEP });

      const call = (client.session.prompt as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.body.agent).toBe('general');
      expect(call.body.system).toBe(REVIEWER_SYSTEM_DIRECTIVE);
    });

    it('returns findings successfully in fallback mode', async () => {
      const client = makeClient({ agents: [] });
      const result = await invokeReviewer(client, PROMPT, 'parent-1', { _sleepFn: NO_SLEEP });

      expect(result).not.toBeNull();
      expect(result!.findings!.overallVerdict).toBe('accept');
    });
  });

  // ─── CORNER: Fail-closed — text fallback removed ─────────────────────────

  describe('CORNER — fail-closed: no text fallback when structured_output is absent', () => {
    it('returns null when structured_output is missing even if text parts contain valid JSON', async () => {
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: {
          data: {
            parts: [{ type: 'text', text: JSON.stringify(validFindings()) }],
            info: { structured_output: undefined },
          },
          error: undefined,
        },
      });
      const result = await invokeReviewer(client, PROMPT, 'parent-1', { _sleepFn: NO_SLEEP });
      // Fail-closed: text content is NOT accepted as structured output substitute
      expect(result).toBeNull();
    });

    it('returns null when text parts contain fenced JSON but no structured_output', async () => {
      const fenced = '```json\n' + JSON.stringify(validFindings()) + '\n```';
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: {
          data: {
            parts: [{ type: 'text', text: fenced }],
            info: {},
          },
          error: undefined,
        },
      });
      const result = await invokeReviewer(client, PROMPT, 'parent-1', { _sleepFn: NO_SLEEP });
      // Fail-closed: fenced JSON in text is NOT accepted
      expect(result).toBeNull();
    });

    it('returns null when text parts contain no valid JSON (unchanged behavior)', async () => {
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: {
          data: {
            parts: [{ type: 'text', text: 'I cannot perform this review.' }],
            info: {},
          },
          error: undefined,
        },
      });
      const result = await invokeReviewer(client, PROMPT, 'parent-1', { _sleepFn: NO_SLEEP });
      expect(result).toBeNull();
    });

    it('returns null when parts array is empty', async () => {
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: {
          data: { parts: [], info: {} },
          error: undefined,
        },
      });
      const result = await invokeReviewer(client, PROMPT, 'parent-1', { _sleepFn: NO_SLEEP });
      expect(result).toBeNull();
    });

    it('returns null when multiple text parts contain JSON but no structured_output', async () => {
      const json = JSON.stringify(validFindings(), null, 0);
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: {
          data: {
            parts: [
              { type: 'text', text: 'Here are my findings:' },
              { type: 'text', text: json },
            ],
            info: {},
          },
          error: undefined,
        },
      });
      const result = await invokeReviewer(client, PROMPT, 'parent-1', { _sleepFn: NO_SLEEP });
      // Fail-closed: even concatenated text with valid JSON is NOT accepted
      expect(result).toBeNull();
    });
  });

  // ─── EDGE: sessionId injection ─────────────────────────────────────────────

  describe('EDGE — sessionId injection on findings', () => {
    it('injects childSessionId into reviewedBy', async () => {
      const findings = validFindings({ reviewedBy: { sessionId: 'wrong' } });
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: {
          data: {
            parts: [],
            info: { structured: findings },
          },
          error: undefined,
        },
      });
      const result = await invokeReviewer(client, PROMPT, 'parent-1', { _sleepFn: NO_SLEEP });
      expect(result!.findings!.reviewedBy).toEqual({ sessionId: 'child-session-1' });
    });

    it('creates reviewedBy if missing', async () => {
      const findings = validFindings();
      delete findings.reviewedBy;
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: {
          data: { parts: [], info: { structured: findings } },
          error: undefined,
        },
      });
      const result = await invokeReviewer(client, PROMPT, 'parent-1', { _sleepFn: NO_SLEEP });
      expect(result!.findings!.reviewedBy).toEqual({ sessionId: 'child-session-1' });
    });
  });

  // ─── E2E: Full dual-path flow ──────────────────────────────────────────────

  describe('E2E — full review flow', () => {
    it('primary path: real prompt → structured output → findings', async () => {
      const realPrompt = buildPlanReviewPrompt({
        planText: 'Add auth middleware to /settings route',
        ticketText: 'TICKET-123: Settings auth',
        iteration: 0,
        planVersion: 1,
        obligationId: '22222222-2222-4222-8222-222222222222',
        criteriaVersion: 'p35-v1',
        mandateDigest: 'abc123',
      });

      const client = makeClient({ agents: [{ id: 'flowguard-reviewer' }] });
      const result = await invokeReviewer(client, realPrompt, 'sess-e2e', { _sleepFn: NO_SLEEP });

      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe('child-session-1');
      expect(result!.rawResponse).toBeTruthy();
      expect(JSON.parse(result!.rawResponse)).toHaveProperty('overallVerdict');

      // Primary path: no system directive
      const call = (client.session.prompt as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.body.agent).toBe('flowguard-reviewer');
      expect(call.body.system).toBeUndefined();
    });

    it('fallback path: real prompt → system directive → structured output', async () => {
      const realPrompt = buildPlanReviewPrompt({
        planText: 'Refactor database layer',
        ticketText: 'TICKET-456: DB refactor',
        iteration: 1,
        planVersion: 2,
        obligationId: '33333333-3333-4333-8333-333333333333',
        criteriaVersion: 'p35-v1',
        mandateDigest: 'def456',
      });

      const client = makeClient({ agents: [] }); // forces fallback
      const result = await invokeReviewer(client, realPrompt, 'sess-e2e-2', { _sleepFn: NO_SLEEP });

      expect(result).not.toBeNull();
      expect(result!.findings!.overallVerdict).toBe('accept');

      const call = (client.session.prompt as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.body.agent).toBe('general');
      expect(call.body.system).toBe(REVIEWER_SYSTEM_DIRECTIVE);
    });

    it('StructuredOutputError is not retried (deterministic failure)', async () => {
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: {
          data: {
            parts: [],
            info: { error: { name: 'StructuredOutputError', message: 'schema mismatch' } },
          },
          error: undefined,
        },
      });

      const result = await invokeReviewer(client, PROMPT, 'parent-1', {
        maxRetries: 2,
        _sleepFn: NO_SLEEP,
      });

      expect(result).toBeNull();
      // Only 1 attempt — StructuredOutputError exits immediately
      expect(client.session.prompt).toHaveBeenCalledTimes(1);
    });

    it('retries transient failures up to maxRetries then returns null', async () => {
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: { error: { message: 'timeout' } },
      });

      const result = await invokeReviewer(client, PROMPT, 'parent-1', {
        maxRetries: 2,
        _sleepFn: NO_SLEEP,
      });

      expect(result).toBeNull();
      // 3 attempts total (1 initial + 2 retries)
      expect(client.session.prompt).toHaveBeenCalledTimes(3);
    });
  });

  // ─── SMOKE: Regression guards ──────────────────────────────────────────────

  describe('SMOKE — regression guards', () => {
    it('never sends system directive in primary path regardless of findings', async () => {
      const client = makeClient({ agents: [{ id: 'flowguard-reviewer' }] });
      await invokeReviewer(client, PROMPT, 'parent-1', { _sleepFn: NO_SLEEP });

      const calls = (client.session.prompt as ReturnType<typeof vi.fn>).mock.calls;
      for (const call of calls) {
        expect(call[0].body).not.toHaveProperty('system');
      }
    });

    it('always sends system directive in fallback path', async () => {
      const client = makeClient({ agents: [] });
      await invokeReviewer(client, PROMPT, 'parent-1', { _sleepFn: NO_SLEEP });

      const calls = (client.session.prompt as ReturnType<typeof vi.fn>).mock.calls;
      for (const call of calls) {
        expect(call[0].body.system).toBe(REVIEWER_SYSTEM_DIRECTIVE);
      }
    });

    it('format field is always present regardless of path', async () => {
      // Primary path
      const client1 = makeClient({ agents: [{ id: 'flowguard-reviewer' }] });
      await invokeReviewer(client1, PROMPT, 'p1', { _sleepFn: NO_SLEEP });
      _resetAgentResolutionCache();

      // Fallback path
      const client2 = makeClient({ agents: [] });
      await invokeReviewer(client2, PROMPT, 'p2', { _sleepFn: NO_SLEEP });

      for (const client of [client1, client2]) {
        const call = (client.session.prompt as ReturnType<typeof vi.fn>).mock.calls[0][0];
        expect(call.body.format).toEqual({
          type: 'json_schema',
          schema: REVIEW_FINDINGS_JSON_SCHEMA,
          retryCount: 1,
        });
      }
    });

    it('REVIEWER_AGENT_PRIMARY matches the identifiers constant', () => {
      // Guards against accidental drift between orchestrator and identifiers
      expect(REVIEWER_AGENT_PRIMARY).toBe('flowguard-reviewer');
      expect(REVIEWER_SUBAGENT_TYPE).toBe('flowguard-reviewer');
    });
  });

  // ─── CRITICAL: structured field name compatibility (v2 SDK) ────────────────

  describe('CRITICAL — structured vs structured_output field name', () => {
    it('reads findings from info.structured_output (canonical docs field)', async () => {
      const findings = validFindings();
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: {
          data: {
            parts: [],
            info: { structured_output: findings },
          },
          error: undefined,
        },
      });
      const result = await invokeReviewer(client, PROMPT, 'parent-1', { _sleepFn: NO_SLEEP });
      expect(result).not.toBeNull();
      expect(result!.findings!.overallVerdict).toBe('accept');
      expect(result!.findings!.reviewMode).toBe('subagent');
    });

    it('reads findings from info.structured (server alias fallback)', async () => {
      const findings = validFindings();
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: {
          data: {
            parts: [],
            info: { structured: findings },
          },
          error: undefined,
        },
      });
      const result = await invokeReviewer(client, PROMPT, 'parent-1', { _sleepFn: NO_SLEEP });
      expect(result).not.toBeNull();
      expect(result!.findings!.overallVerdict).toBe('accept');
    });

    it('prefers info.structured_output over info.structured when both present', async () => {
      const canonicalFindings = validFindings({ overallVerdict: 'accept' });
      const aliasFallback = validFindings({ overallVerdict: 'changes_requested' });
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: {
          data: {
            parts: [],
            info: { structured_output: canonicalFindings, structured: aliasFallback },
          },
          error: undefined,
        },
      });
      const result = await invokeReviewer(client, PROMPT, 'parent-1', { _sleepFn: NO_SLEEP });
      expect(result).not.toBeNull();
      // Must use the canonical docs field (structured_output), not the server alias
      expect(result!.findings!.overallVerdict).toBe('accept');
    });

    it('returns null when both structured and structured_output are absent (fail-closed)', async () => {
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: {
          data: {
            parts: [{ type: 'text', text: JSON.stringify(validFindings()) }],
            info: { structured: undefined, structured_output: undefined },
          },
          error: undefined,
        },
      });
      const result = await invokeReviewer(client, PROMPT, 'parent-1', { _sleepFn: NO_SLEEP });
      // Fail-closed: no text fallback — must return null even though text parts have valid JSON
      expect(result).toBeNull();
    });

    it('returns null when info.structured is an array (not an object)', async () => {
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: {
          data: {
            parts: [],
            info: { structured: [1, 2, 3] },
          },
          error: undefined,
        },
      });
      const result = await invokeReviewer(client, PROMPT, 'parent-1', {
        maxRetries: 0,
        _sleepFn: NO_SLEEP,
      });
      expect(result).toBeNull();
    });

    it('returns null when info.structured is a primitive string', async () => {
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: {
          data: {
            parts: [],
            info: { structured: 'not-an-object' },
          },
          error: undefined,
        },
      });
      const result = await invokeReviewer(client, PROMPT, 'parent-1', {
        maxRetries: 0,
        _sleepFn: NO_SLEEP,
      });
      expect(result).toBeNull();
    });

    it('StructuredOutputError detected with v2 error shape (data.message)', async () => {
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: {
          data: {
            parts: [],
            info: {
              error: {
                name: 'StructuredOutputError',
                data: { message: 'schema validation failed', retries: 2 },
              },
            },
          },
          error: undefined,
        },
      });
      const result = await invokeReviewer(client, PROMPT, 'parent-1', {
        maxRetries: 2,
        _sleepFn: NO_SLEEP,
      });
      expect(result).toBeNull();
      // StructuredOutputError is deterministic — no retry
      expect(client.session.prompt).toHaveBeenCalledTimes(1);
    });
  });
});
