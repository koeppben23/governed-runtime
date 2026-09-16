/**
 * @module adapters/host-adapter.test
 * @description Contract and negative-path tests for the Host-Agnostic Adapter Interface.
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
import {
  REQUIRED_INDEPENDENT_REVIEW_TRANSPORT,
  reviewTransportSatisfies,
} from './host-adapter.js';
import { OpenCodeHostAdapter } from '../integration/opencode-host-adapter.js';

function createMockClient(overrides: Record<string, unknown> = {}) {
  return {
    session: {
      create: vi.fn().mockResolvedValue({ sessionId: 'reviewer-session-1' }),
      prompt: vi.fn().mockResolvedValue({ text: '{}' }),
    },
    app: {
      agents: vi.fn().mockResolvedValue({ agents: ['flowguard-reviewer'], error: undefined }),
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
  return new OpenCodeHostAdapter({
    client: createMockClient(clientOverrides) as never,
    directory: '/project/root',
    worktree: '/project/worktree',
  });
}

function reviewerConfig(overrides: Partial<ReviewerSpawnConfig> = {}): ReviewerSpawnConfig {
  return {
    prompt: 'Review this change',
    parentSessionId: 'parent-session',
    authorizeDispatch: vi.fn(async () => {}),
    abandonDispatch: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('HostAdapter Contract', () => {
  let adapter: HostAdapter;

  beforeEach(() => {
    adapter = createAdapter();
  });

  describe('Interface compliance', () => {
    it('HAPPY: exposes host identity and scalar capabilities', () => {
      expect(adapter.platform).toBe('opencode');
      expect(adapter.enforcementLevel).toBe('synchronous');
      const caps: HostCapabilities = adapter.capabilities;
      expect(caps.preToolBlock).toBe(true);
      expect(caps.argMutation).toBe(true);
      expect(caps.outputReplacement).toBe(true);
      expect(caps.contextInjection).toBe(true);
      expect(caps.compactionInjection).toBe(true);
    });

    it('HAPPY: exposes the SDK reviewer capability as one indivisible transport', () => {
      expect(adapter.capabilities.reviewTransports).toEqual([
        {
          kind: 'sdk_structured_session',
          structuredOutput: true,
          parentVisible: false,
          transcriptNavigable: false,
          isolatedAgentIdentity: true,
          permissionIsolation: false,
          assurance: 'structured_high',
        },
      ]);
    });

    it('BAD: never composes SDK structure with visibility it does not own', () => {
      const sdk = adapter.capabilities.reviewTransports[0];
      expect(sdk).toBeDefined();
      expect(reviewTransportSatisfies(sdk!, REQUIRED_INDEPENDENT_REVIEW_TRANSPORT)).toBe(false);
    });

    it('HAPPY: exposes configured session paths and reviewer transport support', () => {
      expect(adapter.getWorkingDirectory()).toBe('/project/root');
      expect(adapter.getWorktree()).toBe('/project/worktree');
      expect(adapter.isReviewerSupported()).toBe(true);
    });
  });

  describe('Initialization — fail-closed', () => {
    it('BAD: rejects a missing client', async () => {
      const broken = new OpenCodeHostAdapter({
        client: null as never,
        directory: '/x',
        worktree: '/x',
      });
      await expect(broken.initialize()).rejects.toThrow(/initialization failed/i);
    });

    it('BAD: rejects missing or drifting session methods', async () => {
      const missingCreate = new OpenCodeHostAdapter({
        client: { session: { prompt: vi.fn() }, app: { agents: vi.fn() } } as never,
        directory: '/x',
        worktree: '/x',
      });
      await expect(missingCreate.initialize()).rejects.toThrow(/session\.create/);

      const drifting = new OpenCodeHostAdapter({
        client: {
          session: { create: 'not-a-function', prompt: { callable: true } },
          app: { agents: vi.fn() },
        } as never,
        directory: '/x',
        worktree: '/x',
      });
      await expect(drifting.initialize()).rejects.toThrow(/session\.(create|prompt)/);
    });

    it('HAPPY: accepts a valid client', async () => {
      await expect(adapter.initialize()).resolves.toBeUndefined();
    });
  });

  describe('Synchronous enforcement', () => {
    it('HAPPY: delivers a block synchronously with its code', () => {
      const decision: BlockDecision = {
        blocked: true,
        reason: 'Risk classification required',
        code: 'RISK_CLASSIFICATION_REQUIRED',
      };
      expect(() => adapter.deliverBlockDecision(createTestEvent(), decision)).toThrow(
        /RISK_CLASSIFICATION_REQUIRED/,
      );
    });

    it('HAPPY: argument and result projections remain non-throwing host hooks', () => {
      expect(() => adapter.deliverArgMutation(createTestEvent(), { command: 'ls' })).not.toThrow();
      expect(() =>
        adapter.mutateToolResult(createTestEvent(), { replaceOutput: 'blocked' }),
      ).not.toThrow();
    });
  });

  describe('validateCapabilities', () => {
    it('HAPPY: contract-attests the exact SDK review transport without runtime overclaim', async () => {
      const result: CapabilityValidationResult = await adapter.validateCapabilities();
      expect(result).toEqual({
        valid: true,
        mismatches: [],
        runtimeVerified: [],
        contractAttested: [
          'preToolBlock',
          'argMutation',
          'outputReplacement',
          'contextInjection',
          'reviewTransports.sdk_structured_session',
          'compactionInjection',
        ],
      });
    });

    it('HAPPY: does not perform re-entrant host I/O during boot validation', async () => {
      const client = createMockClient();
      client.app.agents.mockRejectedValue(new Error('must not run'));
      const adap = new OpenCodeHostAdapter({
        client: client as never,
        directory: '/x',
        worktree: '/x',
      });
      await adap.validateCapabilities();
      expect(client.app.agents).not.toHaveBeenCalled();
    });
  });

  describe('spawnReviewer — hard visible-review contract', () => {
    it('BAD: blocks before creating a hidden child when no single transport satisfies the contract', async () => {
      const client = createMockClient();
      const adap = new OpenCodeHostAdapter({
        client: client as never,
        directory: '/x',
        worktree: '/x',
      });

      const result = await adap.spawnReviewer(reviewerConfig());

      expect(result).toMatchObject({
        blocked: true,
        code: 'VISIBLE_REVIEW_TRANSPORT_UNAVAILABLE',
      });
      expect(client.session.create).not.toHaveBeenCalled();
      expect(client.session.prompt).not.toHaveBeenCalled();
      expect(client.app.agents).not.toHaveBeenCalled();
    });

    it('BAD: call sites cannot weaken the canonical visibility requirement', async () => {
      const client = createMockClient();
      const adap = new OpenCodeHostAdapter({
        client: client as never,
        directory: '/x',
        worktree: '/x',
      });

      const result = await adap.spawnReviewer(
        reviewerConfig({
          transportRequirements: {
            structuredOutput: true,
            parentVisible: false,
            transcriptNavigable: false,
            isolatedAgentIdentity: true,
            permissionIsolation: false,
          },
        }),
      );

      expect(result).toMatchObject({
        blocked: true,
        code: 'VISIBLE_REVIEW_TRANSPORT_UNAVAILABLE',
      });
      expect(client.session.create).not.toHaveBeenCalled();
    });
  });

  describe('Logging and lifecycle', () => {
    it('HAPPY: warn/error may notify the TUI without becoming authority', () => {
      const client = createMockClient();
      const adap = new OpenCodeHostAdapter({
        client: client as never,
        directory: '/x',
        worktree: '/x',
      });
      adap.log('warn', 'test warning');
      expect(client.tui.showToast).toHaveBeenCalled();
    });

    it('BAD: a toast failure never propagates', () => {
      const client = createMockClient();
      client.tui.showToast.mockRejectedValue(new Error('UI crash'));
      const adap = new OpenCodeHostAdapter({
        client: client as never,
        directory: '/x',
        worktree: '/x',
      });
      expect(() => adap.log('error', 'critical')).not.toThrow();
    });

    it('HAPPY: shutdown is idempotent and compaction injection is non-throwing', async () => {
      await adapter.shutdown();
      await expect(adapter.shutdown()).resolves.toBeUndefined();
      expect(() => adapter.injectCompactionContext?.('governance state')).not.toThrow();
    });
  });
});

describe('HAI Type Contract', () => {
  it('HAPPY: EnforcementLevel accepts all valid values', () => {
    const levels: EnforcementLevel[] = ['synchronous', 'hook_gated', 'advisory'];
    expect(levels).toHaveLength(3);
  });

  it('HAPPY: HostReviewerSuccessResult carries concrete transport provenance', () => {
    const result: HostReviewerSuccessResult = {
      sessionId: 'rev-1',
      rawResponse: '{}',
      findings: null,
      reviewOutputMode: 'structured_output',
      structuredOutputUsed: true,
      reviewAssuranceLevel: 'structured_high',
      reviewTransport: 'sdk_structured_session',
      hostVisible: false,
      transcriptNavigable: false,
    };
    expect(result.reviewTransport).toBe('sdk_structured_session');
    expect(result.hostVisible).toBe(false);
  });

  it('HAPPY: HostReviewerBlockedResult remains typed and explicit', () => {
    const result: HostReviewerBlockedResult = {
      blocked: true,
      code: 'VISIBLE_REVIEW_TRANSPORT_UNAVAILABLE',
      reason: 'No sufficient review transport',
    };
    expect(result.blocked).toBe(true);
  });
});
