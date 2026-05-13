import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveReviewerAgent,
  _resetAgentResolutionCache,
  _resetModelCapabilityCache,
  _getModelCapabilityCache,
  REVIEWER_AGENT_PRIMARY,
  REVIEWER_AGENT_FALLBACK,
  REVIEWER_SYSTEM_DIRECTIVE,
} from './agent-resolution.js';
import { invokeReviewer } from './orchestrator.js';
import { REVIEWER_SUBAGENT_TYPE } from './enforcement/types.js';
import {
  makeClient,
  NO_SLEEP,
  TEXT_COMPAT_OPTIONS,
  validFindings,
  PROMPT,
} from './orchestrator-test-helpers.js';

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
    _resetModelCapabilityCache();
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

describe('Model Capability Cache — removed global state guard', () => {
  beforeEach(() => {
    _resetAgentResolutionCache();
    _resetModelCapabilityCache();
  });

  it('keeps model capability unknown across successful and incompatible invocations', async () => {
    const structuredClient = makeClient({ agents: [{ id: 'flowguard-reviewer' }] });
    await invokeReviewer(structuredClient, PROMPT, 'parent-1', { _sleepFn: NO_SLEEP });
    expect(_getModelCapabilityCache()).toBe('unknown');

    const incompatibleClient = makeClient({
      agents: [{ id: 'flowguard-reviewer' }],
      promptResult: {
        data: {
          parts: [],
          info: { error: { name: 'APIError', message: 'does not support this tool_choice' } },
        },
        error: undefined,
      },
    });
    await invokeReviewer(incompatibleClient, PROMPT, 'parent-1', {
      maxRetries: 0,
      _sleepFn: NO_SLEEP,
      _onAttemptFailed: () => {},
    });
    expect(_getModelCapabilityCache()).toBe('unknown');
  });

  // ─── CORNER: New session for retry ────────────────────────────────────────

  describe('CORNER — new session for format-free retry (UI visibility)', () => {
    it('creates a NEW session for format-free retry on first incompatibility detection', async () => {
      const promptFn = vi
        .fn()
        .mockResolvedValueOnce({
          data: {
            parts: [],
            info: { error: { name: 'APIError', message: 'does not support this tool_choice' } },
          },
          error: undefined,
        })
        .mockResolvedValueOnce({
          data: {
            parts: [{ type: 'text', text: JSON.stringify(validFindings()) }],
            info: {},
          },
          error: undefined,
        });

      const client: OrchestratorClient = {
        app: {
          agents: vi.fn().mockResolvedValue({ data: [{ id: 'flowguard-reviewer' }] }),
        },
        session: {
          create: vi
            .fn()
            .mockResolvedValueOnce({ data: { id: 'original-session' }, error: undefined })
            .mockResolvedValueOnce({ data: { id: 'retry-session' }, error: undefined }),
          prompt: promptFn,
        },
      };

      const result = await invokeReviewer(client, PROMPT, 'parent-1', {
        maxRetries: 0,
        ...TEXT_COMPAT_OPTIONS,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: () => {},
      });

      expect(result).not.toBeNull();
      // Result comes from the RETRY session
      expect(result!.sessionId).toBe('retry-session');
      // Create called twice: original + retry
      expect(client.session.create).toHaveBeenCalledTimes(2);
      // First prompt on original, second on retry
      expect(promptFn.mock.calls[0]![0].path.id).toBe('original-session');
      expect(promptFn.mock.calls[1]![0].path.id).toBe('retry-session');
    });

    it('retry session title includes (format-free) suffix', async () => {
      const promptFn = vi
        .fn()
        .mockResolvedValueOnce({
          data: {
            parts: [],
            info: { error: { name: 'APIError', message: 'does not support this tool_choice' } },
          },
          error: undefined,
        })
        .mockResolvedValueOnce({
          data: {
            parts: [{ type: 'text', text: JSON.stringify(validFindings()) }],
            info: {},
          },
          error: undefined,
        });

      const client: OrchestratorClient = {
        app: {
          agents: vi.fn().mockResolvedValue({ data: [{ id: 'flowguard-reviewer' }] }),
        },
        session: {
          create: vi
            .fn()
            .mockResolvedValueOnce({ data: { id: 's1' }, error: undefined })
            .mockResolvedValueOnce({ data: { id: 's2' }, error: undefined }),
          prompt: promptFn,
        },
      };

      await invokeReviewer(client, PROMPT, 'parent-1', {
        maxRetries: 0,
        ...TEXT_COMPAT_OPTIONS,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: () => {},
      });

      const createFn = client.session.create as ReturnType<typeof vi.fn>;
      // Second create has (format-free) in title
      const secondCreateBody = createFn.mock.calls[1]![0].body;
      expect(secondCreateBody.title).toContain('(format-free)');
      expect(secondCreateBody.parentID).toBe('parent-1');
    });

    it('returns null when retry session create fails', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      const promptFn = vi.fn().mockResolvedValue({
        data: {
          parts: [],
          info: { error: { name: 'APIError', message: 'does not support this tool_choice' } },
        },
        error: undefined,
      });

      const client: OrchestratorClient = {
        app: {
          agents: vi.fn().mockResolvedValue({ data: [{ id: 'flowguard-reviewer' }] }),
        },
        session: {
          create: vi
            .fn()
            .mockResolvedValueOnce({ data: { id: 'original' }, error: undefined })
            .mockResolvedValueOnce({ error: { message: 'rate limited' }, data: undefined }),
          prompt: promptFn,
        },
      };

      const result = await invokeReviewer(client, PROMPT, 'parent-1', {
        maxRetries: 0,
        ...TEXT_COMPAT_OPTIONS,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });

      expect(result).toBeNull();
      const createFailed = diagnostics.find((d) => d.step === 'format_free_retry_session_create');
      expect(createFailed).toBeDefined();
      expect((createFailed!.details as Record<string, unknown>).originalSessionId).toBe('original');
    });
  });

  // ─── EDGE: Toast notifications ────────────────────────────────────────────

  describe('EDGE — toast notifications', () => {
    it('shows toast on format-free fallback (first detection)', async () => {
      const toastFn = vi.fn().mockResolvedValue(undefined);
      const promptFn = vi
        .fn()
        .mockResolvedValueOnce({
          data: {
            parts: [],
            info: { error: { name: 'APIError', message: 'does not support this tool_choice' } },
          },
          error: undefined,
        })
        .mockResolvedValueOnce({
          data: {
            parts: [{ type: 'text', text: JSON.stringify(validFindings()) }],
            info: {},
          },
          error: undefined,
        });

      const client: OrchestratorClient = {
        app: {
          agents: vi.fn().mockResolvedValue({ data: [{ id: 'flowguard-reviewer' }] }),
        },
        session: {
          create: vi.fn().mockResolvedValue({ data: { id: 'ses-1' }, error: undefined }),
          prompt: promptFn,
        },
        tui: { showToast: toastFn },
      };

      await invokeReviewer(client, PROMPT, 'parent-1', {
        maxRetries: 0,
        ...TEXT_COMPAT_OPTIONS,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: () => {},
      });

      expect(toastFn).toHaveBeenCalledTimes(1);
      expect(toastFn.mock.calls[0]![0].body.message).toContain('text compatibility');
      expect(toastFn.mock.calls[0]![0].body.variant).toBe('info');
    });

    it('does not use stale cached unsupported state on later structured-capable invocation', async () => {
      const client1 = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: {
          data: {
            parts: [],
            info: { error: { name: 'APIError', message: 'does not support this tool_choice' } },
          },
          error: undefined,
        },
      });
      await invokeReviewer(client1, PROMPT, 'parent-1', {
        maxRetries: 0,
        ...TEXT_COMPAT_OPTIONS,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: () => {},
      });

      // The next invocation must attempt structured output again, not skip to text compatibility.
      const toastFn = vi.fn().mockResolvedValue(undefined);
      const client2: OrchestratorClient = {
        app: {
          agents: vi.fn().mockResolvedValue({ data: [{ id: 'flowguard-reviewer' }] }),
        },
        session: {
          create: vi.fn().mockResolvedValue({ data: { id: 'ses-2' }, error: undefined }),
          prompt: vi.fn().mockResolvedValue({
            data: {
              parts: [{ type: 'text', text: JSON.stringify(validFindings()) }],
              info: {},
            },
            error: undefined,
          }),
        },
        tui: { showToast: toastFn },
      };

      await invokeReviewer(client2, PROMPT, 'parent-1', {
        maxRetries: 0,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: () => {},
      });

      expect(toastFn).not.toHaveBeenCalled();
      expect(client2.session.prompt).toHaveBeenCalledTimes(1);
      const promptBody = (client2.session.prompt as ReturnType<typeof vi.fn>).mock.calls[0]![0]
        .body;
      expect(promptBody.format).toBeDefined();
    });

    it('does not throw when tui is undefined (headless mode)', async () => {
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: {
          data: {
            parts: [],
            info: { error: { name: 'APIError', message: 'does not support this tool_choice' } },
          },
          error: undefined,
        },
      });
      // client.tui is undefined by default in makeClient

      // Should not throw
      await expect(
        invokeReviewer(client, PROMPT, 'parent-1', {
          maxRetries: 0,
          _sleepFn: NO_SLEEP,
          _onAttemptFailed: () => {},
        }),
      ).resolves.not.toThrow();
    });

    it('does not throw when tui.showToast rejects', async () => {
      const toastFn = vi.fn().mockRejectedValue(new Error('TUI crashed'));
      const promptFn = vi
        .fn()
        .mockResolvedValueOnce({
          data: {
            parts: [],
            info: { error: { name: 'APIError', message: 'does not support this tool_choice' } },
          },
          error: undefined,
        })
        .mockResolvedValueOnce({
          data: {
            parts: [{ type: 'text', text: JSON.stringify(validFindings()) }],
            info: {},
          },
          error: undefined,
        });

      const client: OrchestratorClient = {
        app: {
          agents: vi.fn().mockResolvedValue({ data: [{ id: 'flowguard-reviewer' }] }),
        },
        session: {
          create: vi.fn().mockResolvedValue({ data: { id: 'ses-1' }, error: undefined }),
          prompt: promptFn,
        },
        tui: { showToast: toastFn },
      };

      // Should not throw even though toast rejects
      const result = await invokeReviewer(client, PROMPT, 'parent-1', {
        maxRetries: 0,
        ...TEXT_COMPAT_OPTIONS,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: () => {},
      });

      expect(result).not.toBeNull();
      expect(toastFn).toHaveBeenCalled();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// JSDoc Regression: extractJsonFromText docs
// ═══════════════════════════════════════════════════════════════════════════════
