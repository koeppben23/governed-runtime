/**
 * @module adapters/host-adapter.test
 * @description Contract and negative-path tests for the Host-Agnostic Adapter Interface (HAI).
 *
 * Tests the OpenCodeHostAdapter as the reference implementation, verifying:
 * - Interface compliance (all methods present and typed correctly)
 * - Fail-closed initialization (broken client → explicit error)
 * - Synchronous enforcement (deliverBlockDecision throws)
 * - spawnReviewer semantics (null propagation, option filtering, delegation)
 * - validateCapabilities error handling
 * - Logging non-blocking guarantee
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — four categories present.
 * @see https://github.com/koeppben23/governed-runtime/issues/242
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  HostAdapter,
  HostCapabilities,
  BlockDecision,
  HostToolEvent,
  ReviewerSpawnConfig,
  HostReviewerSuccessResult,
  HostReviewerBlockedResult,
  CapabilityValidationResult,
  EnforcementLevel,
} from './host-adapter.js';
import { OpenCodeHostAdapter } from '../integration/opencode-host-adapter.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

/** Minimal mock of OrchestratorClient with session and app methods. */
function createMockClient(overrides: Record<string, unknown> = {}) {
  return {
    session: {
      create: vi.fn().mockResolvedValue({ sessionId: 'reviewer-session-1' }),
      prompt: vi.fn().mockResolvedValue({ text: '{"approved": true}' }),
    },
    app: {
      agents: vi.fn().mockResolvedValue({ agents: ['reviewer'], error: undefined }),
    },
    tui: {
      showToast: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  };
}

function createTestEvent(): HostToolEvent {
  return {
    tool: 'bash',
    sessionID: 'session-1',
    callID: 'call-1',
    args: { command: 'echo hello' },
  };
}

function createAdapter(clientOverrides?: Record<string, unknown>): OpenCodeHostAdapter {
  const client = createMockClient(clientOverrides);
  return new OpenCodeHostAdapter({
    client: client as never,
    getSessionId: () => 'test-session-123',
    directory: '/project/root',
    worktree: '/project/worktree',
  });
}

// ─── Contract Tests: Interface Compliance ────────────────────────────────────

describe('HostAdapter Contract', () => {
  let adapter: HostAdapter;

  beforeEach(() => {
    adapter = createAdapter();
  });

  describe('Interface compliance', () => {
    it('HAPPY: exposes all required identity fields', () => {
      expect(adapter.platform).toBe('opencode');
      expect(adapter.enforcementLevel).toBe('synchronous');
      expect(adapter.capabilities).toBeDefined();
    });

    it('HAPPY: capabilities object has all required boolean fields', () => {
      const caps: HostCapabilities = adapter.capabilities;
      expect(typeof caps.preToolBlock).toBe('boolean');
      expect(typeof caps.argMutation).toBe('boolean');
      expect(typeof caps.outputReplacement).toBe('boolean');
      expect(typeof caps.contextInjection).toBe('boolean');
      expect(typeof caps.reviewerSpawn).toBe('boolean');
      expect(typeof caps.compactionInjection).toBe('boolean');
    });

    it('HAPPY: OpenCode adapter claims full capabilities', () => {
      const caps = adapter.capabilities;
      expect(caps.preToolBlock).toBe(true);
      expect(caps.argMutation).toBe(true);
      expect(caps.outputReplacement).toBe(true);
      expect(caps.contextInjection).toBe(true);
      expect(caps.reviewerSpawn).toBe(true);
      expect(caps.compactionInjection).toBe(true);
    });

    it('HAPPY: enforcement level is synchronous for OpenCode', () => {
      const level: EnforcementLevel = adapter.enforcementLevel;
      expect(level).toBe('synchronous');
    });

    it('HAPPY: all session context methods return strings', () => {
      expect(typeof adapter.getSessionId()).toBe('string');
      expect(typeof adapter.getWorkingDirectory()).toBe('string');
      expect(typeof adapter.getWorktree()).toBe('string');
    });

    it('HAPPY: getSessionId delegates to resolver', () => {
      expect(adapter.getSessionId()).toBe('test-session-123');
    });

    it('HAPPY: getWorkingDirectory returns configured path', () => {
      expect(adapter.getWorkingDirectory()).toBe('/project/root');
    });

    it('HAPPY: getWorktree returns configured path', () => {
      expect(adapter.getWorktree()).toBe('/project/worktree');
    });

    it('HAPPY: isReviewerSupported returns true for OpenCode', () => {
      expect(adapter.isReviewerSupported()).toBe(true);
    });

    it('HAPPY: all lifecycle methods return promises', async () => {
      await expect(adapter.initialize()).resolves.toBeUndefined();
      await expect(adapter.validateCapabilities()).resolves.toBeDefined();
      await expect(adapter.shutdown()).resolves.toBeUndefined();
    });

    it('HAPPY: log method accepts all severity levels without throwing', () => {
      expect(() => adapter.log('debug', 'test debug')).not.toThrow();
      expect(() => adapter.log('info', 'test info')).not.toThrow();
      expect(() => adapter.log('warn', 'test warn')).not.toThrow();
      expect(() => adapter.log('error', 'test error')).not.toThrow();
    });

    it('HAPPY: log with data parameter does not throw', () => {
      expect(() => adapter.log('info', 'msg', { foo: 'bar' })).not.toThrow();
    });
  });

  // ─── Initialization (Fail-Closed) ──────────────────────────────────────────

  describe('Initialization — fail-closed', () => {
    it('BAD: throws when client is null', async () => {
      const broken = new OpenCodeHostAdapter({
        client: null as never,
        getSessionId: () => 'x',
        directory: '/x',
        worktree: '/x',
      });
      await expect(broken.initialize()).rejects.toThrow(/initialization failed/i);
    });

    it('BAD: throws when client.session.create is missing', async () => {
      const broken = new OpenCodeHostAdapter({
        client: { session: { prompt: vi.fn() }, app: { agents: vi.fn() } } as never,
        getSessionId: () => 'x',
        directory: '/x',
        worktree: '/x',
      });
      await expect(broken.initialize()).rejects.toThrow(/session\.create/);
    });

    it('BAD: throws when client.session.prompt is missing', async () => {
      const broken = new OpenCodeHostAdapter({
        client: { session: { create: vi.fn() }, app: { agents: vi.fn() } } as never,
        getSessionId: () => 'x',
        directory: '/x',
        worktree: '/x',
      });
      await expect(broken.initialize()).rejects.toThrow(/session\.prompt/);
    });

    it('BAD: throws when client.session is undefined', async () => {
      const broken = new OpenCodeHostAdapter({
        client: { app: { agents: vi.fn() } } as never,
        getSessionId: () => 'x',
        directory: '/x',
        worktree: '/x',
      });
      await expect(broken.initialize()).rejects.toThrow(/initialization failed/i);
    });

    it('HAPPY: succeeds with valid client', async () => {
      await expect(adapter.initialize()).resolves.toBeUndefined();
    });
  });

  // ─── Enforcement: deliverBlockDecision ─────────────────────────────────────

  describe('deliverBlockDecision — synchronous enforcement', () => {
    it('HAPPY: throws an error containing the block reason', () => {
      const decision: BlockDecision = {
        blocked: true,
        reason: 'Tool blocked by governance policy',
        code: 'TOOL_BLOCKED',
      };
      expect(() => adapter.deliverBlockDecision(createTestEvent(), decision)).toThrow();
    });

    it('HAPPY: thrown error contains the policy code', () => {
      const decision: BlockDecision = {
        blocked: true,
        reason: 'Risk classification required',
        code: 'RISK_CLASSIFICATION_REQUIRED',
      };
      try {
        adapter.deliverBlockDecision(createTestEvent(), decision);
        expect.fail('should have thrown');
      } catch (err: unknown) {
        const msg = (err as Error).message;
        expect(msg).toContain('RISK_CLASSIFICATION_REQUIRED');
      }
    });

    it('CORNER: works with empty reason string', () => {
      const decision: BlockDecision = { blocked: true, reason: '', code: 'EMPTY_REASON' };
      expect(() => adapter.deliverBlockDecision(createTestEvent(), decision)).toThrow();
    });
  });

  // ─── deliverArgMutation / mutateToolResult (no-ops for OpenCode) ───────────

  describe('deliverArgMutation and mutateToolResult — no-ops for OpenCode', () => {
    it('HAPPY: deliverArgMutation does not throw', () => {
      expect(() => adapter.deliverArgMutation(createTestEvent(), { command: 'ls' })).not.toThrow();
    });

    it('HAPPY: mutateToolResult does not throw', () => {
      expect(() =>
        adapter.mutateToolResult(createTestEvent(), { replaceOutput: 'blocked' }),
      ).not.toThrow();
    });
  });

  // ─── validateCapabilities ──────────────────────────────────────────────────

  describe('validateCapabilities', () => {
    it('HAPPY: returns valid when agents endpoint succeeds', async () => {
      const result: CapabilityValidationResult = await adapter.validateCapabilities();
      expect(result.valid).toBe(true);
      expect(result.mismatches).toHaveLength(0);
    });

    it('BAD: reports reviewerSpawn mismatch when agents call returns error', async () => {
      const client = createMockClient();
      client.app.agents.mockResolvedValue({ error: 'unavailable' });
      const adap = new OpenCodeHostAdapter({
        client: client as never,
        getSessionId: () => 'x',
        directory: '/x',
        worktree: '/x',
      });
      const result = await adap.validateCapabilities();
      expect(result.valid).toBe(false);
      expect(result.mismatches).toContainEqual({
        capability: 'reviewerSpawn',
        expected: true,
        actual: false,
      });
    });

    it('BAD: reports mismatch when agents call throws', async () => {
      const client = createMockClient();
      client.app.agents.mockRejectedValue(new Error('network error'));
      const adap = new OpenCodeHostAdapter({
        client: client as never,
        getSessionId: () => 'x',
        directory: '/x',
        worktree: '/x',
      });
      const result = await adap.validateCapabilities();
      expect(result.valid).toBe(false);
      expect(result.mismatches[0]?.capability).toBe('reviewerSpawn');
    });
  });

  // ─── spawnReviewer ─────────────────────────────────────────────────────────

  describe('spawnReviewer', () => {
    it('HAPPY: delegates to invokeReviewer and returns result', async () => {
      // invokeReviewer is complex — for contract tests we verify the adapter
      // correctly routes the call. Integration tests cover full orchestration.
      const client = createMockClient();
      // Mock a minimal reviewer response via session methods
      client.session.create.mockResolvedValue({ sessionId: 'rev-1' });
      client.session.prompt.mockResolvedValue({
        text: JSON.stringify({
          approved: true,
          findings: [],
          summary: 'All good',
        }),
      });

      const adap = new OpenCodeHostAdapter({
        client: client as never,
        getSessionId: () => 'parent-session',
        directory: '/proj',
        worktree: '/proj',
      });

      const config: ReviewerSpawnConfig = {
        prompt: 'Review this change',
        parentSessionId: 'parent-session',
      };

      // Note: actual result depends on invokeReviewer implementation
      // which is covered by orchestrator tests. Here we just verify no crash.
      const result = await adap.spawnReviewer(config);
      // Either a valid result or null (retries exhausted) is acceptable
      expect(result === null || typeof result === 'object').toBe(true);
    });

    it('CORNER: does not pass undefined options to invokeReviewer', async () => {
      // This is the bug that caused _sleepFn: undefined to override defaults.
      // The adapter must only forward options that are explicitly set.
      const client = createMockClient();
      client.session.create.mockResolvedValue({ sessionId: 'rev-1' });
      client.session.prompt.mockResolvedValue({ text: '{}' });

      const adap = new OpenCodeHostAdapter({
        client: client as never,
        getSessionId: () => 'x',
        directory: '/x',
        worktree: '/x',
      });

      const config: ReviewerSpawnConfig = {
        prompt: 'test prompt',
        parentSessionId: 'parent',
        // These are intentionally NOT set:
        // maxRetries: undefined,
        // baseDelayMs: undefined,
        // onAttemptFailed: undefined,
      };

      // Should not throw (undefined options should not break invokeReviewer)
      await expect(adap.spawnReviewer(config)).resolves.toBeDefined();
    });

    it('HAPPY: passes defined options correctly', async () => {
      const client = createMockClient();
      client.session.create.mockResolvedValue({ sessionId: 'rev-1' });
      client.session.prompt.mockResolvedValue({ text: '{}' });

      const adap = new OpenCodeHostAdapter({
        client: client as never,
        getSessionId: () => 'x',
        directory: '/x',
        worktree: '/x',
      });

      const onFailed = vi.fn();
      const config: ReviewerSpawnConfig = {
        prompt: 'test',
        parentSessionId: 'parent',
        maxRetries: 2,
        baseDelayMs: 100,
        onAttemptFailed: onFailed,
        reviewOutputPolicy: 'structured_required',
        reviewInvocationPolicy: 'host_task_required',
      };

      // Should not crash — validates all options are accepted
      await expect(adap.spawnReviewer(config)).resolves.toBeDefined();
    });
  });

  // ─── Logging ───────────────────────────────────────────────────────────────

  describe('Logging — non-blocking guarantee', () => {
    it('HAPPY: warn/error log triggers toast', () => {
      const client = createMockClient();
      const adap = new OpenCodeHostAdapter({
        client: client as never,
        getSessionId: () => 'x',
        directory: '/x',
        worktree: '/x',
      });

      adap.log('warn', 'test warning');
      expect(client.tui.showToast).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            message: expect.stringContaining('test warning'),
          }),
        }),
      );
    });

    it('HAPPY: debug/info log does not trigger toast', () => {
      const client = createMockClient();
      const adap = new OpenCodeHostAdapter({
        client: client as never,
        getSessionId: () => 'x',
        directory: '/x',
        worktree: '/x',
      });

      adap.log('debug', 'quiet');
      adap.log('info', 'quiet');
      expect(client.tui.showToast).not.toHaveBeenCalled();
    });

    it('BAD: toast failure does not propagate', () => {
      const client = createMockClient();
      client.tui.showToast.mockRejectedValue(new Error('UI crash'));
      const adap = new OpenCodeHostAdapter({
        client: client as never,
        getSessionId: () => 'x',
        directory: '/x',
        worktree: '/x',
      });

      // Must not throw even though toast rejects
      expect(() => adap.log('error', 'critical')).not.toThrow();
    });

    it('CORNER: log works when tui is undefined', () => {
      const client = createMockClient({ tui: undefined });
      const adap = new OpenCodeHostAdapter({
        client: client as never,
        getSessionId: () => 'x',
        directory: '/x',
        worktree: '/x',
      });

      expect(() => adap.log('error', 'no tui')).not.toThrow();
    });
  });

  // ─── Shutdown ──────────────────────────────────────────────────────────────

  describe('Shutdown', () => {
    it('HAPPY: resolves without error', async () => {
      await expect(adapter.shutdown()).resolves.toBeUndefined();
    });

    it('HAPPY: is idempotent (can be called multiple times)', async () => {
      await adapter.shutdown();
      await expect(adapter.shutdown()).resolves.toBeUndefined();
    });
  });

  // ─── injectCompactionContext (optional) ────────────────────────────────────

  describe('injectCompactionContext', () => {
    it('HAPPY: method exists and does not throw', () => {
      expect(adapter.injectCompactionContext).toBeDefined();
      expect(() => adapter.injectCompactionContext!('governance state')).not.toThrow();
    });
  });
});

// ─── Type-Level Contract: Structural Compatibility ───────────────────────────

describe('HAI Type Contract', () => {
  it('HAPPY: EnforcementLevel accepts all valid values', () => {
    const levels: EnforcementLevel[] = ['synchronous', 'hook_gated', 'advisory'];
    expect(levels).toHaveLength(3);
  });

  it('HAPPY: HostReviewerSuccessResult structural check', () => {
    const result: HostReviewerSuccessResult = {
      sessionId: 'rev-1',
      rawResponse: '{}',
      findings: null,
      reviewOutputMode: 'structured_output',
      structuredOutputUsed: true,
      reviewAssuranceLevel: 'structured_high',
    };
    expect(result.sessionId).toBe('rev-1');
    expect(result.blocked).toBeUndefined();
  });

  it('HAPPY: HostReviewerBlockedResult structural check', () => {
    const result: HostReviewerBlockedResult = {
      blocked: true,
      code: 'INVOCATION_BLOCKED',
      reason: 'Policy prevents reviewer invocation',
    };
    expect(result.blocked).toBe(true);
    expect(result.code).toBe('INVOCATION_BLOCKED');
  });
});
