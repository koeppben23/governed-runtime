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
  CapabilityValidationResult,
  EnforcementLevel,
} from './host-adapter.js';
import { REQUIRED_INDEPENDENT_REVIEW_TRANSPORT, reviewTransportSatisfies } from './host-adapter.js';
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

    it('HAPPY: exposes one native visible structured reviewer transport', () => {
      expect(adapter.capabilities.reviewTransports).toEqual([
        {
          kind: 'native_task_structured_followup',
          structuredOutput: true,
          parentVisible: true,
          transcriptNavigable: true,
          isolatedAgentIdentity: true,
          permissionIsolation: true,
          assurance: 'structured_high',
        },
      ]);
    });

    it('HAPPY: the single advertised transport satisfies the complete product contract', () => {
      const native = adapter.capabilities.reviewTransports[0];
      expect(native).toBeDefined();
      expect(reviewTransportSatisfies(native!, REQUIRED_INDEPENDENT_REVIEW_TRANSPORT)).toBe(true);
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

    it('BAD: rejects a missing same-child structured prompt capability', async () => {
      const missingPrompt = new OpenCodeHostAdapter({
        client: { session: {}, app: { agents: vi.fn() } } as never,
        directory: '/x',
        worktree: '/x',
      });
      await expect(missingPrompt.initialize()).rejects.toThrow(/session\.prompt/);
    });

    it('BAD: rejects a missing reviewer registry capability', async () => {
      const missingAgents = new OpenCodeHostAdapter({
        client: { session: { prompt: vi.fn() }, app: {} } as never,
        directory: '/x',
        worktree: '/x',
      });
      await expect(missingAgents.initialize()).rejects.toThrow(/app\.agents/);
    });

    it('HAPPY: does not require direct session.create because native Task owns child creation', async () => {
      const nativeOnly = new OpenCodeHostAdapter({
        client: { session: { prompt: vi.fn() }, app: { agents: vi.fn() } } as never,
        directory: '/x',
        worktree: '/x',
      });
      await expect(nativeOnly.initialize()).resolves.toBeUndefined();
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
    it('HAPPY: contract-attests the exact native review transport without runtime overclaim', async () => {
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
          'reviewTransports.native_task_structured_followup',
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
});

describe('reviewTransportSatisfies contract', () => {
  const TRANSPORT_FLAGS = [
    'structuredOutput',
    'parentVisible',
    'transcriptNavigable',
    'isolatedAgentIdentity',
    'permissionIsolation',
  ] as const;

  type TransportFlag = (typeof TRANSPORT_FLAGS)[number];

  function transport(
    overrides: Partial<Record<TransportFlag, boolean>> = {},
  ): Parameters<typeof reviewTransportSatisfies>[0] {
    return {
      kind: 'native_task_structured_followup',
      structuredOutput: true,
      parentVisible: true,
      transcriptNavigable: true,
      isolatedAgentIdentity: true,
      permissionIsolation: true,
      assurance: 'structured_high',
      ...overrides,
    };
  }

  function requirements(
    overrides: Partial<Record<TransportFlag, boolean>> = {},
  ): Parameters<typeof reviewTransportSatisfies>[1] {
    return {
      structuredOutput: false,
      parentVisible: false,
      transcriptNavigable: false,
      isolatedAgentIdentity: false,
      permissionIsolation: false,
      ...overrides,
    };
  }

  it('HAPPY: the fully required product contract is satisfied by a complete transport', () => {
    expect(reviewTransportSatisfies(transport(), REQUIRED_INDEPENDENT_REVIEW_TRANSPORT)).toBe(true);
  });

  it('BAD: rejects any transport missing one required flag', () => {
    for (const flag of TRANSPORT_FLAGS) {
      expect(
        reviewTransportSatisfies(
          transport({ [flag]: false }),
          REQUIRED_INDEPENDENT_REVIEW_TRANSPORT,
        ),
        flag,
      ).toBe(false);
    }
  });

  it('HAPPY: an unrequired flag does not constrain the transport', () => {
    const allMissing = transport({
      structuredOutput: false,
      parentVisible: false,
      transcriptNavigable: false,
      isolatedAgentIdentity: false,
      permissionIsolation: false,
    });

    expect(reviewTransportSatisfies(allMissing, requirements())).toBe(true);
  });

  it('HAPPY: only the required subset is evaluated', () => {
    for (const requiredFlag of TRANSPORT_FLAGS) {
      const required = requirements({ [requiredFlag]: true });
      expect(reviewTransportSatisfies(transport(), required), requiredFlag).toBe(true);
      expect(
        reviewTransportSatisfies(transport({ [requiredFlag]: false }), required),
        requiredFlag,
      ).toBe(false);
    }
  });

  it('BAD: a satisfied subset never upgrades a missing required flag', () => {
    const required = requirements({ permissionIsolation: true });
    const almostComplete = transport({ permissionIsolation: false });

    expect(reviewTransportSatisfies(almostComplete, required)).toBe(false);
  });
});
