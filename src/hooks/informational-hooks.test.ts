import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockReadStdin = vi.hoisted(() => vi.fn());
const mockEnsureWorkspace = vi.hoisted(() => vi.fn());
const mockSessionDir = vi.hoisted(() => vi.fn());
const mockAppendAuditEvent = vi.hoisted(() => vi.fn());
const mockResolveSession = vi.hoisted(() => vi.fn());
const mockWriteReviewerCapture = vi.hoisted(() => vi.fn());
const mockWriteLog = vi.hoisted(() => vi.fn());

vi.mock('./shared/stdin-reader.js', () => ({
  readStdin: (...args: unknown[]) => mockReadStdin(...args),
  validateSessionPayload: (payload: Record<string, unknown>) => payload,
  validateToolHookPayload: (payload: Record<string, unknown>) => payload,
  validateSubagentStopPayload: (payload: Record<string, unknown>) => payload,
}));

vi.mock('./shared/stdout-writer.js', () => ({
  writeLog: (...args: unknown[]) => mockWriteLog(...args),
}));

vi.mock('./shared/stdout-guard.js', () => ({
  installHookStdoutGuard: () => ({ restore: vi.fn() }),
}));

vi.mock('./shared/platform-detect.js', () => ({ detectPlatform: () => 'claude' }));

vi.mock('../adapters/workspace/index.js', () => ({
  ensureWorkspace: (...args: unknown[]) => mockEnsureWorkspace(...args),
  sessionDir: (...args: unknown[]) => mockSessionDir(...args),
}));

vi.mock('../adapters/persistence-audit.js', () => ({
  appendAuditEvent: (...args: unknown[]) => mockAppendAuditEvent(...args),
}));

vi.mock('./shared/session-resolver.js', () => ({
  resolveSession: (...args: unknown[]) => mockResolveSession(...args),
}));

vi.mock('./shared/reviewer-capture-writer.js', () => ({
  isReviewTool: (toolName: string) => toolName === 'flowguard_review',
  extractObligationId: () => 'obligation-1',
  writeReviewerCapture: (...args: unknown[]) => mockWriteReviewerCapture(...args),
}));

vi.mock('./shared/phase-gate.js', () => ({ isMutatingHostTool: () => false }));
vi.mock('./shared/obligation-tracker.js', () => ({
  assessObligationEscalation: () => ({ message: null }),
}));

const SESSION_PAYLOAD = { session_id: 'session-1', cwd: '/workspace' };
const TOOL_PAYLOAD = {
  ...SESSION_PAYLOAD,
  tool_name: 'flowguard_review',
  tool_input: {},
  agent_id: 'reviewer-1',
  agent_type: 'flowguard-reviewer',
};

async function importHook(path: string, completed: () => unknown): Promise<void> {
  await import(path);
  await vi.waitFor(() => expect(completed()).toBeTruthy());
}

describe('informational command hooks', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockReadStdin.mockResolvedValue(SESSION_PAYLOAD);
    mockEnsureWorkspace.mockResolvedValue({
      fingerprint: 'workspace-1',
      workspaceDir: '/workspace/.flowguard',
    });
    mockSessionDir.mockReturnValue('/workspace/.flowguard/sessions/session-1');
    mockAppendAuditEvent.mockResolvedValue(undefined);
    mockResolveSession.mockResolvedValue({
      ok: true,
      sessionDir: '/workspace/.flowguard/sessions/session-1',
      state: { phase: 'IMPLEMENTATION', reviewAssurance: { obligations: [] } },
    });
    mockWriteReviewerCapture.mockResolvedValue(null);
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  describe('HAPPY', () => {
    it('persists a session_start audit event', async () => {
      await importHook('./session-start.js', () => mockAppendAuditEvent.mock.calls.length > 0);

      expect(mockEnsureWorkspace).toHaveBeenCalledWith('/workspace');
      expect(mockAppendAuditEvent).toHaveBeenCalledWith(
        '/workspace/.flowguard/sessions/session-1',
        expect.objectContaining({
          event: 'lifecycle',
          detail: expect.objectContaining({ action: 'session_start' }),
        }),
      );
      expect(process.exitCode).not.toBe(1);
    });

    it('persists a tool audit event and reviewer capture', async () => {
      mockReadStdin.mockResolvedValue(TOOL_PAYLOAD);
      await importHook('./post-tool-use.js', () => mockWriteReviewerCapture.mock.calls.length > 0);

      expect(mockAppendAuditEvent).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          event: 'tool_call',
          detail: expect.objectContaining({ tool: 'flowguard_review' }),
        }),
      );
      expect(mockWriteReviewerCapture).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ source: 'post_tool_use_hook', obligationId: 'obligation-1' }),
        expect.any(Function),
      );
    });

    it('persists a session_stop audit event', async () => {
      await importHook('./stop.js', () => mockAppendAuditEvent.mock.calls.length > 0);

      expect(mockAppendAuditEvent).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          event: 'lifecycle',
          detail: expect.objectContaining({ action: 'session_stop' }),
        }),
      );
    });

    it('writes a subagent-stop reviewer capture', async () => {
      mockReadStdin.mockResolvedValue(TOOL_PAYLOAD);
      await importHook('./subagent-stop.js', () => mockWriteReviewerCapture.mock.calls.length > 0);

      expect(mockWriteReviewerCapture).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ source: 'subagent_stop_hook', agentId: 'reviewer-1' }),
        expect.any(Function),
      );
    });
  });

  describe('BAD', () => {
    it.each([
      ['./session-start.js', () => mockEnsureWorkspace],
      ['./post-tool-use.js', () => mockResolveSession],
      ['./stop.js', () => mockResolveSession],
      ['./subagent-stop.js', () => mockResolveSession],
    ])('logs stdin failures without throwing for %s', async (path, dependency) => {
      mockReadStdin.mockRejectedValue(new Error('invalid stdin'));
      await importHook(path, () => mockWriteLog.mock.calls.length > 0);

      expect(dependency()).not.toHaveBeenCalled();
      expect(process.exitCode).not.toBe(1);
    });
  });

  describe('CORNER', () => {
    it('does not write a reviewer capture when post-tool-use has no agent id', async () => {
      mockReadStdin.mockResolvedValue({ ...TOOL_PAYLOAD, agent_id: undefined });
      await importHook('./post-tool-use.js', () => mockAppendAuditEvent.mock.calls.length > 0);

      expect(mockWriteReviewerCapture).not.toHaveBeenCalled();
    });
  });

  describe('EDGE', () => {
    it('logs unresolved stop obligations while persisting the lifecycle event', async () => {
      mockResolveSession.mockResolvedValue({
        ok: true,
        sessionDir: '/workspace/.flowguard/sessions/session-1',
        state: {
          phase: 'IMPLEMENTATION',
          reviewAssurance: {
            obligations: [{ obligationId: 'pending-1', status: 'pending', consumedAt: null }],
          },
        },
      });
      await importHook('./stop.js', () => mockAppendAuditEvent.mock.calls.length > 0);

      expect(mockWriteLog).toHaveBeenCalledWith(
        expect.stringContaining('unresolved review obligation'),
      );
      expect(mockAppendAuditEvent).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ detail: expect.objectContaining({ pendingObligations: 1 }) }),
      );
    });
  });

  describe('PERF', () => {
    it('completes an informational hook without a forced process failure', async () => {
      await importHook('./session-start.js', () => mockAppendAuditEvent.mock.calls.length > 0);

      expect(process.exitCode).not.toBe(1);
    });
  });
});
