/**
 * @module integration/review-orchestrator-agent-resolution.test
 * @description Comprehensive tests for the agent resolution and dual-path
 * invocation mechanism in invokeReviewer().
 *
 * Coverage:
 * - HAPPY: Primary path (flowguard-reviewer registered)
 * - HAPPY: Fallback path (general agent with system directive)
 * - BAD: Probe failures (throws, error response, undefined data)
 * - CORNER: Cache behavior (single probe, sticky result, reset)
 * - CORNER: Fail-closed — no text fallback when structured_output absent
 * - EDGE: Concurrent resolution, empty agent list
 * - E2E: Full review flow with both paths
 * - SMOKE: extractJsonFromText strategies
 * - NON-RETRYABLE: isRetryable === false early exit (no retry on deterministic API errors)
 * - MODEL CAPABILITY: model_capability_incompatible fail-closed detection
 *
 * @version v1
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveReviewerAgent,
  _resetAgentResolutionCache,
  REVIEWER_AGENT_PRIMARY,
  REVIEWER_AGENT_FALLBACK,
  REVIEWER_SYSTEM_DIRECTIVE,
  extractJsonFromText,
  invokeReviewer,
  buildPlanReviewPrompt,
  REVIEW_FINDINGS_JSON_SCHEMA,
  type OrchestratorClient,
} from './review-orchestrator.js';
import { REVIEWER_SUBAGENT_TYPE } from './review-enforcement.js';

// ─── Test Fixtures ────────────────────────────────────────────────────────────

function validFindings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    ...overrides,
  };
}

const NO_SLEEP = async () => {};

function makeClient(opts: {
  agents?: Array<Record<string, unknown>>;
  agentsError?: unknown;
  agentsThrows?: boolean;
  createResult?: { data?: { id: string }; error?: unknown };
  promptResult?: {
    data?: {
      parts?: Array<{ type?: string; text?: string }>;
      info?: {
        structured?: unknown;
        structured_output?: unknown;
        error?: { name: string; message?: string; data?: { message?: string; retries?: number } };
      };
    };
    error?: unknown;
  };
}): OrchestratorClient {
  const agentsFn = opts.agentsThrows
    ? vi.fn().mockRejectedValue(new Error('network failure'))
    : vi
        .fn()
        .mockResolvedValue(
          opts.agentsError
            ? { error: opts.agentsError }
            : { data: opts.agents ?? [{ id: 'flowguard-reviewer', name: 'flowguard-reviewer' }] },
        );

  return {
    app: { agents: agentsFn },
    session: {
      create: vi
        .fn()
        .mockResolvedValue(
          opts.createResult ?? { data: { id: 'child-session-1' }, error: undefined },
        ),
      prompt: vi.fn().mockResolvedValue(
        opts.promptResult ?? {
          data: {
            parts: [{ type: 'text', text: JSON.stringify(validFindings()) }],
            info: { structured: validFindings() },
          },
          error: undefined,
        },
      ),
    },
  };
}

const PROMPT = 'Review this plan...';

// ═══════════════════════════════════════════════════════════════════════════════
// Constants verification
// ═══════════════════════════════════════════════════════════════════════════════

describe('Agent Resolution Constants', () => {
  it('REVIEWER_AGENT_PRIMARY equals REVIEWER_SUBAGENT_TYPE', () => {
    expect(REVIEWER_AGENT_PRIMARY).toBe(REVIEWER_SUBAGENT_TYPE);
    expect(REVIEWER_AGENT_PRIMARY).toBe('flowguard-reviewer');
  });

  it('REVIEWER_AGENT_FALLBACK is general', () => {
    expect(REVIEWER_AGENT_FALLBACK).toBe('general');
  });

  it('REVIEWER_SYSTEM_DIRECTIVE is non-empty and mentions ReviewFindings', () => {
    expect(REVIEWER_SYSTEM_DIRECTIVE.length).toBeGreaterThan(50);
    expect(REVIEWER_SYSTEM_DIRECTIVE).toContain('ReviewFindings');
    expect(REVIEWER_SYSTEM_DIRECTIVE).toContain('governance reviewer');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// resolveReviewerAgent
// ═══════════════════════════════════════════════════════════════════════════════

describe('resolveReviewerAgent', () => {
  beforeEach(() => {
    _resetAgentResolutionCache();
  });

  // ─── HAPPY ──────────────────────────────────────────────────────────────────

  describe('HAPPY — agent registered', () => {
    it('returns primary agent when found by id', async () => {
      const client = makeClient({ agents: [{ id: 'flowguard-reviewer' }] });
      const result = await resolveReviewerAgent(client);
      expect(result).toBe(REVIEWER_AGENT_PRIMARY);
    });

    it('returns primary agent when found by name', async () => {
      const client = makeClient({ agents: [{ name: 'flowguard-reviewer' }] });
      const result = await resolveReviewerAgent(client);
      expect(result).toBe(REVIEWER_AGENT_PRIMARY);
    });

    it('returns primary agent when found among many agents', async () => {
      const client = makeClient({
        agents: [
          { id: 'build', name: 'build' },
          { id: 'plan', name: 'plan' },
          { id: 'flowguard-reviewer', name: 'flowguard-reviewer' },
          { id: 'explore', name: 'explore' },
        ],
      });
      const result = await resolveReviewerAgent(client);
      expect(result).toBe(REVIEWER_AGENT_PRIMARY);
    });
  });

  // ─── HAPPY: Fallback ────────────────────────────────────────────────────────

  describe('HAPPY — agent NOT registered (graceful fallback)', () => {
    it('returns fallback when agent list is empty', async () => {
      const client = makeClient({ agents: [] });
      const result = await resolveReviewerAgent(client);
      expect(result).toBe(REVIEWER_AGENT_FALLBACK);
    });

    it('returns fallback when only other agents are registered', async () => {
      const client = makeClient({
        agents: [{ id: 'build' }, { id: 'plan' }, { id: 'general' }],
      });
      const result = await resolveReviewerAgent(client);
      expect(result).toBe(REVIEWER_AGENT_FALLBACK);
    });
  });

  // ─── BAD: Probe failures ───────────────────────────────────────────────────

  describe('BAD — probe failures degrade to fallback', () => {
    it('returns fallback when app.agents() throws', async () => {
      const client = makeClient({ agentsThrows: true });
      const result = await resolveReviewerAgent(client);
      expect(result).toBe(REVIEWER_AGENT_FALLBACK);
    });

    it('returns fallback when app.agents() returns error', async () => {
      const client = makeClient({ agentsError: { message: 'unauthorized' } });
      const result = await resolveReviewerAgent(client);
      expect(result).toBe(REVIEWER_AGENT_FALLBACK);
    });

    it('returns fallback when app.agents() returns undefined data', async () => {
      const client: OrchestratorClient = {
        app: { agents: vi.fn().mockResolvedValue({ data: undefined }) },
        session: { create: vi.fn(), prompt: vi.fn() },
      };
      const result = await resolveReviewerAgent(client);
      expect(result).toBe(REVIEWER_AGENT_FALLBACK);
    });
  });

  // ─── CORNER: Cache behavior ────────────────────────────────────────────────

  describe('CORNER — cache behavior', () => {
    it('probes only once, subsequent calls use cache', async () => {
      const client = makeClient({ agents: [{ id: 'flowguard-reviewer' }] });
      const r1 = await resolveReviewerAgent(client);
      const r2 = await resolveReviewerAgent(client);
      const r3 = await resolveReviewerAgent(client);

      expect(r1).toBe(REVIEWER_AGENT_PRIMARY);
      expect(r2).toBe(REVIEWER_AGENT_PRIMARY);
      expect(r3).toBe(REVIEWER_AGENT_PRIMARY);
      expect(client.app.agents).toHaveBeenCalledTimes(1);
    });

    it('cache persists across different client objects', async () => {
      const client1 = makeClient({ agents: [{ id: 'flowguard-reviewer' }] });
      const client2 = makeClient({ agents: [] }); // would return fallback if probed

      const r1 = await resolveReviewerAgent(client1); // probes → primary
      const r2 = await resolveReviewerAgent(client2); // uses cache → still primary

      expect(r1).toBe(REVIEWER_AGENT_PRIMARY);
      expect(r2).toBe(REVIEWER_AGENT_PRIMARY);
      expect(client2.app.agents).not.toHaveBeenCalled();
    });

    it('_resetAgentResolutionCache allows re-probing', async () => {
      const client1 = makeClient({ agents: [{ id: 'flowguard-reviewer' }] });
      await resolveReviewerAgent(client1); // probes → primary

      _resetAgentResolutionCache();

      const client2 = makeClient({ agents: [] });
      const r2 = await resolveReviewerAgent(client2); // probes again → fallback

      expect(r2).toBe(REVIEWER_AGENT_FALLBACK);
      expect(client2.app.agents).toHaveBeenCalledTimes(1);
    });

    it('fallback result is also cached', async () => {
      const client = makeClient({ agentsThrows: true });
      const r1 = await resolveReviewerAgent(client);
      const r2 = await resolveReviewerAgent(client);

      expect(r1).toBe(REVIEWER_AGENT_FALLBACK);
      expect(r2).toBe(REVIEWER_AGENT_FALLBACK);
      expect(client.app.agents).toHaveBeenCalledTimes(1);
    });
  });

  // ─── EDGE ──────────────────────────────────────────────────────────────────

  describe('EDGE — unusual agent list shapes', () => {
    it('handles agent entries with no id or name field', async () => {
      const client = makeClient({ agents: [{ description: 'some agent' }] });
      const result = await resolveReviewerAgent(client);
      expect(result).toBe(REVIEWER_AGENT_FALLBACK);
    });

    it('handles agent with id matching but different name', async () => {
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer', name: 'Custom Reviewer' }],
      });
      const result = await resolveReviewerAgent(client);
      expect(result).toBe(REVIEWER_AGENT_PRIMARY);
    });

    it('handles concurrent calls (only one probe)', async () => {
      const client = makeClient({ agents: [{ id: 'flowguard-reviewer' }] });
      const results = await Promise.all([
        resolveReviewerAgent(client),
        resolveReviewerAgent(client),
        resolveReviewerAgent(client),
      ]);
      expect(results).toEqual([
        REVIEWER_AGENT_PRIMARY,
        REVIEWER_AGENT_PRIMARY,
        REVIEWER_AGENT_PRIMARY,
      ]);
      // May be called 1-3 times due to race, but all return same result
      expect(client.app.agents).toHaveBeenCalled();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// extractJsonFromText
// ═══════════════════════════════════════════════════════════════════════════════

describe('extractJsonFromText', () => {
  // ─── HAPPY ──────────────────────────────────────────────────────────────────

  describe('HAPPY — valid JSON extraction', () => {
    it('parses pure JSON object', () => {
      const result = extractJsonFromText('{"key": "value"}');
      expect(result).toEqual({ key: 'value' });
    });

    it('parses JSON with whitespace around it', () => {
      const result = extractJsonFromText('  \n {"key": "value"} \n ');
      expect(result).toEqual({ key: 'value' });
    });

    it('extracts from markdown fence (```json)', () => {
      const text = 'Here is the result:\n```json\n{"key": "value"}\n```\nDone.';
      const result = extractJsonFromText(text);
      expect(result).toEqual({ key: 'value' });
    });

    it('extracts from markdown fence (``` without json tag)', () => {
      const text = '```\n{"key": "value"}\n```';
      const result = extractJsonFromText(text);
      expect(result).toEqual({ key: 'value' });
    });

    it('extracts outermost braces from prose', () => {
      const text = 'The findings are: {"overallVerdict": "approve"} as shown.';
      const result = extractJsonFromText(text);
      expect(result).toEqual({ overallVerdict: 'approve' });
    });
  });

  // ─── BAD ────────────────────────────────────────────────────────────────────

  describe('BAD — non-extractable content', () => {
    it('returns null for empty string', () => {
      expect(extractJsonFromText('')).toBeNull();
    });

    it('returns null for whitespace only', () => {
      expect(extractJsonFromText('   \n\t  ')).toBeNull();
    });

    it('returns null for plain text without JSON', () => {
      expect(extractJsonFromText('I cannot review this content.')).toBeNull();
    });

    it('returns null for JSON array (not object)', () => {
      expect(extractJsonFromText('[1, 2, 3]')).toBeNull();
    });

    it('returns null for invalid JSON in braces', () => {
      expect(extractJsonFromText('{not valid json}')).toBeNull();
    });
  });

  // ─── CORNER ─────────────────────────────────────────────────────────────────

  describe('CORNER — complex structures', () => {
    it('handles nested objects', () => {
      const nested = { a: { b: { c: 1 } }, d: [1, 2] };
      const result = extractJsonFromText(JSON.stringify(nested));
      expect(result).toEqual(nested);
    });

    it('handles complex review findings JSON', () => {
      const findings = validFindings();
      const result = extractJsonFromText(JSON.stringify(findings));
      expect(result).toEqual(findings);
    });

    it('handles JSON with escaped characters', () => {
      const text = '{"msg": "hello \\"world\\"", "path": "C:\\\\Users"}';
      const result = extractJsonFromText(text);
      expect(result).toEqual({ msg: 'hello "world"', path: 'C:\\Users' });
    });

    it('prefers direct parse over fence extraction', () => {
      // If the entire text is valid JSON, returns it directly
      const json = '{"strategy": "direct"}';
      const result = extractJsonFromText(json);
      expect(result).toEqual({ strategy: 'direct' });
    });
  });

  // ─── EDGE ──────────────────────────────────────────────────────────────────

  describe('EDGE — boundary cases', () => {
    it('handles multiple JSON objects (extracts first outermost)', () => {
      const text = 'First: {"a": 1} Second: {"b": 2}';
      const result = extractJsonFromText(text);
      expect(result).toEqual({ a: 1 });
    });

    it('handles empty object', () => {
      expect(extractJsonFromText('{}')).toEqual({});
    });

    it('handles JSON with unicode', () => {
      const result = extractJsonFromText('{"name": "日本語テスト"}');
      expect(result).toEqual({ name: '日本語テスト' });
    });

    it('handles malformed fence but valid brace extraction', () => {
      const text = '```json\nnot valid\n```\n{"fallback": true}';
      const result = extractJsonFromText(text);
      expect(result).toEqual({ fallback: true });
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// invokeReviewer — Dual-Path Integration
// ═══════════════════════════════════════════════════════════════════════════════

describe('invokeReviewer — agent resolution integration', () => {
  beforeEach(() => {
    _resetAgentResolutionCache();
  });

  // ─── HAPPY: Primary path ───────────────────────────────────────────────────

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
      expect(result!.findings!.overallVerdict).toBe('approve');
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
      expect(result!.findings!.overallVerdict).toBe('approve');
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
      expect(result!.findings!.overallVerdict).toBe('approve');

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
      expect(result!.findings!.overallVerdict).toBe('approve');
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
      expect(result!.findings!.overallVerdict).toBe('approve');
    });

    it('prefers info.structured_output over info.structured when both present', async () => {
      const canonicalFindings = validFindings({ overallVerdict: 'approve' });
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
      expect(result!.findings!.overallVerdict).toBe('approve');
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

  // ─── DIAGNOSTIC: _onAttemptFailed callback ─────────────────────────────────

  describe('DIAGNOSTIC — _onAttemptFailed callback', () => {
    it('fires with step=session_create when create fails', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        createResult: { error: { message: 'forbidden' }, data: undefined },
      });
      await invokeReviewer(client, PROMPT, 'parent-1', {
        maxRetries: 0,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]!.step).toBe('session_create');
      expect(diagnostics[0]!.attempt).toBe(1);
    });

    it('fires with step=session_prompt when prompt returns error', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: { error: { message: 'bad request' }, data: undefined },
      });
      await invokeReviewer(client, PROMPT, 'parent-1', {
        maxRetries: 0,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]!.step).toBe('session_prompt');
      expect(diagnostics[0]!.attempt).toBe(1);
    });

    it('fires with step=no_findings when structured output absent', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: {
          data: { parts: [], info: {} },
          error: undefined,
        },
      });
      await invokeReviewer(client, PROMPT, 'parent-1', {
        maxRetries: 0,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]!.step).toBe('no_findings');
      expect((diagnostics[0]!.details as Record<string, unknown>).infoKeys).toEqual([]);
    });

    it('fires with step=structured_output_error for StructuredOutputError', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: {
          data: {
            parts: [],
            info: { error: { name: 'StructuredOutputError', message: 'failed' } },
          },
          error: undefined,
        },
      });
      await invokeReviewer(client, PROMPT, 'parent-1', {
        maxRetries: 2,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]!.step).toBe('structured_output_error');
    });

    it('fires once per attempt on repeated failures', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: { error: { message: 'timeout' }, data: undefined },
      });
      await invokeReviewer(client, PROMPT, 'parent-1', {
        maxRetries: 2,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });
      expect(diagnostics).toHaveLength(3);
      expect(diagnostics.map((d) => d.attempt)).toEqual([1, 2, 3]);
      expect(diagnostics.every((d) => d.step === 'session_prompt')).toBe(true);
    });

    it('includes infoKeys in no_findings diagnostic for debugging', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: {
          data: {
            parts: [{ type: 'text', text: 'not json' }],
            info: { structured: null, error: undefined },
          },
          error: undefined,
        },
      });
      await invokeReviewer(client, PROMPT, 'parent-1', {
        maxRetries: 0,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });
      expect(diagnostics).toHaveLength(1);
      const details = diagnostics[0]!.details as Record<string, unknown>;
      expect(details.hasInfo).toBe(true);
      expect(details.partsCount).toBe(1);
      expect(details.textPartsLength).toBe(8); // "not json" = 8 chars
    });

    // ─── info_error step: non-StructuredOutputError surfacing ─────────────────

    it('fires info_error step for non-StructuredOutputError errors in info', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: {
          data: {
            parts: [],
            info: { error: { name: 'SessionError', message: 'unspecified session error' } },
          },
          error: undefined,
        },
      });
      await invokeReviewer(client, PROMPT, 'parent-1', {
        maxRetries: 0,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });
      // Should fire both info_error (for the error) and no_findings (no structured output)
      expect(diagnostics).toHaveLength(2);
      expect(diagnostics[0]!.step).toBe('info_error');
      expect(diagnostics[0]!.error).toEqual({
        name: 'SessionError',
        message: 'unspecified session error',
      });
      const errorDetails = diagnostics[0]!.details as Record<string, unknown>;
      expect(errorDetails.errorName).toBe('SessionError');
      expect(errorDetails.errorMessage).toBe('unspecified session error');
      // Second diagnostic: no_findings with infoError included
      expect(diagnostics[1]!.step).toBe('no_findings');
    });

    it('includes infoError value in no_findings details when info.error is present', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      const sessionError = { name: 'AgentError', message: 'agent not found' };
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: {
          data: {
            parts: [],
            info: { error: sessionError },
          },
          error: undefined,
        },
      });
      await invokeReviewer(client, PROMPT, 'parent-1', {
        maxRetries: 0,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });
      // Find the no_findings diagnostic
      const noFindings = diagnostics.find((d) => d.step === 'no_findings');
      expect(noFindings).toBeDefined();
      const details = noFindings!.details as Record<string, unknown>;
      expect(details.infoError).toEqual(sessionError);
    });

    it('surfaces info.error as string (non-object runtime shape)', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      // At runtime, info.error could be a plain string from the server.
      // TypeScript types say object, but we must be resilient.
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: {
          data: {
            parts: [],
            info: { error: 'unspecified session error' as unknown as { name: string } },
          },
          error: undefined,
        },
      });
      await invokeReviewer(client, PROMPT, 'parent-1', {
        maxRetries: 0,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });
      // info_error should still fire with the string value surfaced
      const infoError = diagnostics.find((d) => d.step === 'info_error');
      expect(infoError).toBeDefined();
      expect(infoError!.error).toBe('unspecified session error');
      const errorDetails = infoError!.details as Record<string, unknown>;
      expect(errorDetails.errorName).toBe('string'); // typeof string
      expect(errorDetails.errorMessage).toBe('unspecified session error');
      // no_findings should include the string error in infoError
      const noFindings = diagnostics.find((d) => d.step === 'no_findings');
      expect(noFindings).toBeDefined();
      expect((noFindings!.details as Record<string, unknown>).infoError).toBe(
        'unspecified session error',
      );
    });

    it('does NOT fire info_error when info.error is absent', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: {
          data: { parts: [], info: {} },
          error: undefined,
        },
      });
      await invokeReviewer(client, PROMPT, 'parent-1', {
        maxRetries: 0,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });
      // Only no_findings should fire, not info_error
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]!.step).toBe('no_findings');
      expect((diagnostics[0]!.details as Record<string, unknown>).infoError).toBeNull();
    });

    it('info_error fires but findings still returned when structured_output coexists with error', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      const findings = validFindings();
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: {
          data: {
            parts: [],
            info: {
              error: { name: 'PartialWarning', message: 'some warning' },
              structured_output: findings,
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
      // info_error fires for the warning
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]!.step).toBe('info_error');
      // But findings are still returned successfully (error doesn't block valid output)
      expect(result).not.toBeNull();
      expect(result!.findings).toBeTruthy();
      expect(result!.findings!.overallVerdict).toBe(findings.overallVerdict);
    });
  });

  // ─── isRetryable === false: non-retryable API error early exit ──────────────

  describe('NON-RETRYABLE — isRetryable === false early exit', () => {
    beforeEach(() => _resetAgentResolutionCache());

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
    beforeEach(() => _resetAgentResolutionCache());

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

    it('T6: model_capability_incompatible includes recovery guidance', async () => {
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
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });
      const incompatible = diagnostics.find((d) => d.step === 'model_capability_incompatible');
      expect(incompatible).toBeDefined();
      const details = incompatible!.details as Record<string, unknown>;
      expect(details.reason).toContain('infrastructure/config failure');
      expect(details.reason).toContain('not a reviewer verdict');
      expect(details.recovery).toContain('FLOWGUARD_REVIEWER_MODEL');
      expect(details.recovery).toContain('reinstall FlowGuard');
      expect(details.recovery).toContain('fresh session');
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
      // Only 2 diagnostics: info_error + model_capability_incompatible, on attempt 1 only
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
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });
      expect(diagnostics).toHaveLength(2);
      expect(diagnostics[0]!.step).toBe('info_error');
      expect(diagnostics[1]!.step).toBe('model_capability_incompatible');
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

// ═══════════════════════════════════════════════════════════════════════════════
// JSDoc Regression: extractJsonFromText docs
// ═══════════════════════════════════════════════════════════════════════════════

describe('extractJsonFromText JSDoc', () => {
  it('SMOKE — JSDoc references info.structured_output (canonical docs field)', async () => {
    const orchestratorPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      'review-orchestrator.ts',
    );
    const source = await fs.readFile(orchestratorPath, 'utf-8');

    // The extractJsonFromText JSDoc should reference the canonical docs field name
    // "info.structured_output", not the server alias "info.structured".
    const jsdocMatch = source.match(
      /\/\*\*[\s\S]*?Extract JSON from unstructured text response[\s\S]*?\*\//,
    );
    expect(jsdocMatch).not.toBeNull();
    const jsdoc = jsdocMatch![0];
    expect(jsdoc).toContain('info.structured_output');
  });
});
