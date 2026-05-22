/**
 * @file plugin-task-evidence.test.ts
 * @description Unit tests for plugin-task-evidence.ts host-task evidence handler.
 *
 * Covers handleHostTaskEvidence across required/preferred policy modes,
 * null-sessDir, null-state, evidence-bound, evidence-missing, and error paths.
 *
 * Mock strategy: vi.mock for external deps (persistence, evidence-binding,
 * assurance, helpers). PluginWorkspace methods mocked via vi.fn().
 *
 * @version v1
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockReadState,
  mockBuildHostTaskEvidence,
  mockAppendInvocationEvidence,
  mockEnsureReviewAssurance,
  mockStrictBlockedOutput,
} = vi.hoisted(() => ({
  mockReadState: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  mockBuildHostTaskEvidence: vi.fn<(...args: unknown[]) => unknown>(),
  mockAppendInvocationEvidence: vi.fn<(...args: unknown[]) => unknown>(),
  mockEnsureReviewAssurance: vi.fn<(...args: unknown[]) => unknown>(),
  mockStrictBlockedOutput: vi.fn<(code: string, detail: Record<string, string>) => string>(),
}));

vi.mock('../adapters/persistence.js', () => ({
  readState: mockReadState,
}));

vi.mock('./review/evidence-binding.js', () => ({
  buildHostTaskEvidence: mockBuildHostTaskEvidence,
}));

vi.mock('./review/assurance.js', () => ({
  appendInvocationEvidence: mockAppendInvocationEvidence,
  ensureReviewAssurance: mockEnsureReviewAssurance,
}));

vi.mock('./plugin-helpers.js', () => ({
  strictBlockedOutput: mockStrictBlockedOutput,
}));

import { handleHostTaskEvidence } from './plugin-task-evidence.js';
import type { PluginWorkspace } from './plugin-workspace.js';
import type { SessionState } from '../state/schema.js';
import { makeState } from '../__fixtures__.js';

const SESSION_ID = 's1';

function makeStateInfo(policyMode: string = 'host_task_required'): SessionState {
  return makeState('IMPLEMENTATION', {
    policySnapshot: {
      ...makeState('IMPLEMENTATION').policySnapshot,
      reviewInvocationPolicy:
        policyMode as SessionState['policySnapshot']['reviewInvocationPolicy'],
    },
    reviewAssurance: {
      obligations: [],
      invocations: [],
    },
  }) as SessionState;
}

function mockWs(overrides: Partial<PluginWorkspace> = {}): PluginWorkspace {
  return {
    getSessionDir: vi.fn().mockReturnValue('/tmp/sess'),
    getEnforcementState: vi.fn().mockReturnValue({
      invocations: [],
      lastDecisionId: null,
      sessionId: SESSION_ID,
    }),
    updateReviewAssurance: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as PluginWorkspace;
}

function mockLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

const SAMPLE_EVIDENCE = {
  invocationId: 'inv-1',
  obligationId: 'obl-1',
  childSessionId: 'child-1',
  findingsHash: 'abc123',
  bindOutcome: 'matched',
};

let hookOutput: { output?: string };

beforeEach(() => {
  vi.clearAllMocks();
  hookOutput = {};
  mockReadState.mockResolvedValue(makeStateInfo());
  mockBuildHostTaskEvidence.mockReturnValue({
    evidence: SAMPLE_EVIDENCE,
    bindOutcome: 'matched',
    diagnostic: {},
  });
  mockEnsureReviewAssurance.mockReturnValue({
    obligations: [],
    invocations: [],
  });
  mockAppendInvocationEvidence.mockReturnValue({
    obligations: [],
    invocations: [{}],
  });
  mockStrictBlockedOutput.mockImplementation(
    (code, detail) => `BLOCKED: ${code} (${JSON.stringify(detail)})`,
  );
});

// ═══════════════════════════════════════════════════════════════════════════════

describe('handleHostTaskEvidence', () => {
  const now = '2026-01-01T00:00:00.000Z';

  describe('GOOD', () => {
    it('binds evidence and updates review assurance for host_task_required', async () => {
      mockReadState.mockResolvedValue(makeStateInfo('host_task_required'));
      const ws = mockWs();
      const log = mockLog();

      await handleHostTaskEvidence(
        { ws, log, logError: vi.fn() },
        SESSION_ID,
        'child-1',
        now,
        hookOutput,
      );

      expect(mockBuildHostTaskEvidence).toHaveBeenCalledTimes(1);
      expect(ws.updateReviewAssurance).toHaveBeenCalledTimes(1);
      expect(hookOutput.output).toBeUndefined();
    });

    it('binds evidence for host_task_preferred policy', async () => {
      mockReadState.mockResolvedValue(makeStateInfo('host_task_preferred'));
      const ws = mockWs();
      const log = mockLog();

      await handleHostTaskEvidence(
        { ws, log, logError: vi.fn() },
        SESSION_ID,
        'child-1',
        now,
        hookOutput,
      );

      expect(mockBuildHostTaskEvidence).toHaveBeenCalledTimes(1);
      expect(ws.updateReviewAssurance).toHaveBeenCalledTimes(1);
    });
  });

  describe('CORNER', () => {
    it('returns early when sessDir is null', async () => {
      const ws = mockWs({ getSessionDir: vi.fn().mockReturnValue(null) });
      const log = mockLog();

      await handleHostTaskEvidence(
        { ws, log, logError: vi.fn() },
        SESSION_ID,
        null,
        now,
        hookOutput,
      );

      expect(mockReadState).not.toHaveBeenCalled();
    });

    it('returns early when state is null', async () => {
      mockReadState.mockResolvedValue(null);
      const ws = mockWs();
      const log = mockLog();

      await handleHostTaskEvidence(
        { ws, log, logError: vi.fn() },
        SESSION_ID,
        'child-1',
        now,
        hookOutput,
      );

      expect(mockBuildHostTaskEvidence).not.toHaveBeenCalled();
    });

    it('returns early on unsupported reviewInvocationPolicy', async () => {
      mockReadState.mockResolvedValue(makeStateInfo('none'));
      const ws = mockWs();
      const log = mockLog();

      await handleHostTaskEvidence(
        { ws, log, logError: vi.fn() },
        SESSION_ID,
        'child-1',
        now,
        hookOutput,
      );

      expect(mockBuildHostTaskEvidence).not.toHaveBeenCalled();
    });
  });

  describe('BAD', () => {
    it('blocks output in host_task_required when evidence is null', async () => {
      mockReadState.mockResolvedValue(makeStateInfo('host_task_required'));
      mockBuildHostTaskEvidence.mockReturnValue({
        evidence: null,
        bindOutcome: 'no_match',
        diagnostic: { reason: 'no findings' },
      });
      const ws = mockWs();
      const log = mockLog();

      await handleHostTaskEvidence(
        { ws, log, logError: vi.fn() },
        SESSION_ID,
        'child-1',
        now,
        hookOutput,
      );

      expect(mockStrictBlockedOutput).toHaveBeenCalledWith(
        'HOST_SUBAGENT_TASK_REQUIRED',
        expect.objectContaining({ policy: 'host_task_required', bindOutcome: 'no_match' }),
      );
      expect(hookOutput.output).toBeDefined();
      expect(ws.updateReviewAssurance).not.toHaveBeenCalled();
    });

    it('catch block writes blocked output on readState error', async () => {
      mockReadState.mockRejectedValue(new Error('disk read error'));
      const ws = mockWs();
      const log = mockLog();
      const logError = vi.fn();

      await handleHostTaskEvidence({ ws, log, logError }, SESSION_ID, 'child-1', now, hookOutput);

      expect(mockStrictBlockedOutput).toHaveBeenCalledWith(
        'HOST_SUBAGENT_TASK_REQUIRED',
        expect.objectContaining({
          reason: 'disk read error',
          reviewerSubagentType: 'flowguard-reviewer',
        }),
      );
      expect(logError).toHaveBeenCalledWith(
        'host task evidence creation failed',
        expect.any(Error),
      );
    });
  });

  describe('EDGE', () => {
    it('logs warning but does NOT block in host_task_preferred when evidence is null', async () => {
      mockReadState.mockResolvedValue(makeStateInfo('host_task_preferred'));
      mockBuildHostTaskEvidence.mockReturnValue({
        evidence: null,
        bindOutcome: 'no_match',
        diagnostic: { reason: 'no findings' },
      });
      const ws = mockWs();
      const log = mockLog();

      await handleHostTaskEvidence(
        { ws, log, logError: vi.fn() },
        SESSION_ID,
        'child-1',
        now,
        hookOutput,
      );

      expect(log.warn).toHaveBeenCalledWith(
        'host-task',
        'bind failed',
        expect.objectContaining({ bindOutcome: 'no_match' }),
      );
      expect(mockStrictBlockedOutput).not.toHaveBeenCalled();
      expect(hookOutput.output).toBeUndefined();
    });
  });
});
