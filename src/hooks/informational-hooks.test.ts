import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockReadStdin = vi.hoisted(() => vi.fn());
const mockEnsureWorkspace = vi.hoisted(() => vi.fn());
const mockSessionDir = vi.hoisted(() => vi.fn());
const mockAppendAuditEvent = vi.hoisted(() => vi.fn());
const mockResolveSession = vi.hoisted(() => vi.fn());
const mockWriteLog = vi.hoisted(() => vi.fn());
const mockResolveRoot = vi.hoisted(() => vi.fn());
const mockAppendHookIngestFailure = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({ recorded: true })),
);

vi.mock('./shared/stdin-reader.js', () => ({
  StdinReadError: class StdinReadError extends Error {
    readonly observedBytes = null;
    readonly observedPrefix = null;
  },
  readStdin: (...args: unknown[]) => mockReadStdin(...args),
  readStdinRaw: async (...args: unknown[]) => {
    const payload = (await mockReadStdin(...args)) as Record<string, unknown>;
    return { payload, raw: JSON.stringify(payload) };
  },
  validateSessionPayload: (payload: Record<string, unknown>) => payload,
  validateToolHookPayload: (payload: Record<string, unknown>) => payload,
}));

vi.mock('../adapters/persistence-hook-ingest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../adapters/persistence-hook-ingest.js')>();
  return {
    ...actual,
    appendHookIngestFailure: (...args: unknown[]) => mockAppendHookIngestFailure(...args),
  };
});

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

vi.mock('../adapters/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../adapters/git.js')>();
  return { ...actual, resolveRoot: (...args: unknown[]) => mockResolveRoot(...args) };
});

vi.mock('../adapters/persistence-audit.js', () => ({
  appendAuditEvent: (...args: unknown[]) => mockAppendAuditEvent(...args),
}));

vi.mock('./shared/session-resolver.js', () => ({
  resolveSession: (...args: unknown[]) => mockResolveSession(...args),
}));

vi.mock('./shared/phase-gate.js', () => ({ isMutatingHostTool: () => false }));
vi.mock('./shared/obligation-tracker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./shared/obligation-tracker.js')>();
  return { ...actual, assessObligationEscalation: () => ({ message: null }) };
});

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
    mockResolveRoot.mockReset();
    mockResolveRoot.mockResolvedValue('/workspace');
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env['FLOWGUARD_SESSION_DIR'];
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

    it('persists a tool audit event', async () => {
      mockReadStdin.mockResolvedValue(TOOL_PAYLOAD);
      await importHook('./post-tool-use.js', () => mockAppendAuditEvent.mock.calls.length > 0);

      expect(mockAppendAuditEvent).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          event: 'tool_call',
          detail: expect.objectContaining({ tool: 'flowguard_review' }),
        }),
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

    it('bootstraps the git-resolved worktree root, not the raw payload cwd', async () => {
      mockReadStdin.mockResolvedValue({ session_id: 'session-1', cwd: '/workspace/subdir' });
      mockResolveRoot.mockResolvedValue('/workspace');

      await importHook('./session-start.js', () => mockAppendAuditEvent.mock.calls.length > 0);

      expect(mockResolveRoot).toHaveBeenCalledWith('/workspace/subdir');
      expect(mockEnsureWorkspace).toHaveBeenCalledWith('/workspace');
    });

    it('skips bootstrap and audit when the cwd is not a git worktree', async () => {
      mockResolveRoot.mockRejectedValue(new Error('not a git repository'));

      await importHook('./session-start.js', () => mockWriteLog.mock.calls.length > 0);

      expect(mockEnsureWorkspace).not.toHaveBeenCalled();
      expect(mockAppendAuditEvent).not.toHaveBeenCalled();
    });

    it('skips bootstrap entirely under the explicit session-dir override', async () => {
      process.env['FLOWGUARD_SESSION_DIR'] = '/override/dir';

      await importHook('./session-start.js', () => mockAppendAuditEvent.mock.calls.length > 0);

      expect(mockResolveRoot).not.toHaveBeenCalled();
      expect(mockEnsureWorkspace).not.toHaveBeenCalled();
    });
  });

  describe('BAD', () => {
    it.each([
      ['./session-start.js', () => mockEnsureWorkspace],
      ['./post-tool-use.js', () => mockResolveSession],
      ['./stop.js', () => mockResolveSession],
    ])('logs stdin failures without throwing for %s', async (path, dependency) => {
      mockReadStdin.mockRejectedValue(new Error('invalid stdin'));
      await importHook(path, () => mockWriteLog.mock.calls.length > 0);

      expect(dependency()).not.toHaveBeenCalled();
      expect(process.exitCode).not.toBe(1);
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
    it('does not warn for deterministically blocked terminal obligations', async () => {
      mockResolveSession.mockResolvedValue({
        ok: true,
        sessionDir: '/workspace/.flowguard/sessions/session-1',
        state: {
          phase: 'IMPLEMENTATION',
          reviewAssurance: {
            obligations: [
              {
                obligationId: 'blocked-1',
                status: 'blocked',
                consumedAt: null,
              },
            ],
          },
        },
      });
      await importHook('./stop.js', () => mockAppendAuditEvent.mock.calls.length > 0);

      expect(mockWriteLog).not.toHaveBeenCalledWith(
        expect.stringContaining('unresolved review obligation'),
      );
      expect(mockAppendAuditEvent).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ detail: expect.objectContaining({ pendingObligations: 0 }) }),
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
