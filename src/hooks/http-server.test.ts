/**
 * @module hooks/http-server.test
 * @description Unit tests for the HTTP hook server's handleSessionStart handler.
 *
 * Covers:
 * - Happy path: workspace bootstrapped, fingerprint computed, audit event persisted
 * - computeFingerprint failure: still returns { decision: "allow" }
 * - ensureWorkspace failure: non-blocking, returns allow with reason
 * - Null-guard on sessDir: appendAuditEvent not called when sessDir is null
 *
 * The node:http createServer is mocked to prevent actual server startup on import.
 *
 * @see https://github.com/koeppben23/governed-runtime/issues/342
 * @test-policy HAPPY, BAD, CORNER
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';

// ─── Mocks ───────────────────────────────────────────────────────────────────

// Prevent server startup on module import.
vi.mock('node:http', () => ({
  createServer: vi.fn(() => ({
    listen: vi.fn(),
    close: vi.fn(),
  })),
}));

// Mock workspace module.
const mockEnsureWorkspace = vi.fn();
const mockComputeFingerprint = vi.fn();
const mockSessionDir = vi.fn();

vi.mock('../adapters/workspace/index.js', () => ({
  ensureWorkspace: (...args: unknown[]) => mockEnsureWorkspace(...args),
  sessionDir: (...args: unknown[]) => mockSessionDir(...args),
  computeFingerprint: (...args: unknown[]) => mockComputeFingerprint(...args),
}));

// Mock audit persistence.
const mockAppendAuditEvent = vi.fn();

vi.mock('../adapters/persistence-audit.js', () => ({
  appendAuditEvent: (...args: unknown[]) => mockAppendAuditEvent(...args),
}));

// Mock session-resolver (not used by handleSessionStart, but imported by module).
const mockResolveSession = vi.fn();

vi.mock('./shared/session-resolver.js', () => ({
  resolveSession: (...args: unknown[]) => mockResolveSession(...args),
}));

// Mock obligation-tracker.
vi.mock('./shared/obligation-tracker.js', () => ({
  assessObligationEscalation: vi.fn(() => ({ message: null })),
  unresolvedBlockingObligations: (state: {
    reviewAssurance?: { obligations?: Array<{ status: string; consumedAt: string | null }> };
  }) =>
    (state.reviewAssurance?.obligations ?? []).filter(
      (ob) => ob.status !== 'consumed' && ob.consumedAt == null,
    ),
}));

// ─── Import handler after mocks ──────────────────────────────────────────────

let handleSessionStart: (typeof import('./http-server.js'))['handleSessionStart'];
let handleHttpRequest: (typeof import('./http-server.js'))['handleHttpRequest'];
let signalListenerBaseline: {
  sigterm: NodeJS.SignalsListener[];
  sigint: NodeJS.SignalsListener[];
};

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  signalListenerBaseline = {
    sigterm: process.listeners('SIGTERM') as NodeJS.SignalsListener[],
    sigint: process.listeners('SIGINT') as NodeJS.SignalsListener[],
  };

  // Re-apply mocks for fresh module load.
  vi.doMock('node:http', () => ({
    createServer: vi.fn(() => ({
      listen: vi.fn(),
      close: vi.fn(),
    })),
  }));
  vi.doMock('../adapters/workspace/index.js', () => ({
    ensureWorkspace: (...args: unknown[]) => mockEnsureWorkspace(...args),
    sessionDir: (...args: unknown[]) => mockSessionDir(...args),
    computeFingerprint: (...args: unknown[]) => mockComputeFingerprint(...args),
  }));
  vi.doMock('../adapters/persistence-audit.js', () => ({
    appendAuditEvent: (...args: unknown[]) => mockAppendAuditEvent(...args),
  }));
  vi.doMock('./shared/session-resolver.js', () => ({
    resolveSession: (...args: unknown[]) => mockResolveSession(...args),
  }));
  vi.doMock('./shared/obligation-tracker.js', () => ({
    assessObligationEscalation: vi.fn(() => ({ message: null })),
    unresolvedBlockingObligations: (state: {
      reviewAssurance?: { obligations?: Array<{ status: string; consumedAt: string | null }> };
    }) =>
      (state.reviewAssurance?.obligations ?? []).filter(
        (ob) => ob.status !== 'consumed' && ob.consumedAt == null,
      ),
  }));

  const mod = await import('./http-server.js');
  handleSessionStart = mod.handleSessionStart;
  handlePreToolUse = mod.handlePreToolUse;
  handleHttpRequest = mod.handleHttpRequest;
});

afterEach(() => {
  for (const listener of process.listeners('SIGTERM') as NodeJS.SignalsListener[]) {
    if (!signalListenerBaseline.sigterm.includes(listener)) process.off('SIGTERM', listener);
  }
  for (const listener of process.listeners('SIGINT') as NodeJS.SignalsListener[]) {
    if (!signalListenerBaseline.sigint.includes(listener)) process.off('SIGINT', listener);
  }
});

let handlePreToolUse: (typeof import('./http-server.js'))['handlePreToolUse'];

function makeRequest(input: {
  method?: string;
  url?: string;
  body: string;
  contentLength?: string;
}) {
  const req = new Readable({
    read() {
      this.push(input.body);
      this.push(null);
    },
  }) as Readable & { method?: string; url?: string; headers: Record<string, string> };
  req.method = input.method ?? 'POST';
  req.url = input.url ?? '/hooks/pre-tool-use';
  req.headers = input.contentLength ? { 'content-length': input.contentLength } : {};
  return req;
}

function makeResponse() {
  const res = {
    status: 0,
    body: '',
    headers: {} as Record<string, unknown>,
    writeHead(status: number, headers: Record<string, unknown>) {
      this.status = status;
      this.headers = headers;
    },
    end(body: string) {
      this.body = body;
    },
  };
  return res;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('handleSessionStart', () => {
  const validPayload = {
    session_id: 'sess_test_123',
    cwd: '/tmp/project',
  };

  describe('HAPPY', () => {
    it('should return allow and persist audit event on success', async () => {
      mockEnsureWorkspace.mockResolvedValue(undefined);
      mockComputeFingerprint.mockResolvedValue({ fingerprint: 'fp_abc123' });
      mockSessionDir.mockReturnValue('/workspace/sessions/fp_abc123/sess_test_123');
      mockAppendAuditEvent.mockResolvedValue(undefined);

      const result = await handleSessionStart(validPayload);

      expect(result).toEqual({ decision: 'allow' });
      expect(mockEnsureWorkspace).toHaveBeenCalledWith('/tmp/project');
      expect(mockComputeFingerprint).toHaveBeenCalledWith('/tmp/project');
      expect(mockSessionDir).toHaveBeenCalledWith('fp_abc123', 'sess_test_123');
      expect(mockAppendAuditEvent).toHaveBeenCalledWith(
        '/workspace/sessions/fp_abc123/sess_test_123',
        expect.objectContaining({
          sessionId: 'sess_test_123',
          phase: 'READY',
          event: 'lifecycle',
          actor: 'system',
          detail: expect.objectContaining({
            action: 'session_start',
            hookSource: 'http_hook',
            cwd: '/tmp/project',
          }),
          enforcementLevel: 'hook_gated',
        }),
      );
    });
  });

  describe('BAD', () => {
    it('should return allow with reason when ensureWorkspace fails', async () => {
      mockEnsureWorkspace.mockRejectedValue(new Error('permission denied'));

      const result = await handleSessionStart(validPayload);

      expect(result).toEqual({
        decision: 'allow',
        reason: 'workspace bootstrap failed (non-blocking)',
      });
      // Should NOT attempt fingerprint or audit after workspace failure.
      expect(mockComputeFingerprint).not.toHaveBeenCalled();
      expect(mockAppendAuditEvent).not.toHaveBeenCalled();
    });

    it('should return allow when computeFingerprint fails (sessDir remains null)', async () => {
      mockEnsureWorkspace.mockResolvedValue(undefined);
      mockComputeFingerprint.mockRejectedValue(new Error('git not found'));

      const result = await handleSessionStart(validPayload);

      expect(result).toEqual({ decision: 'allow' });
      // Audit should NOT be called because sessDir is null.
      expect(mockAppendAuditEvent).not.toHaveBeenCalled();
    });

    it('should return allow when appendAuditEvent fails (non-fatal)', async () => {
      mockEnsureWorkspace.mockResolvedValue(undefined);
      mockComputeFingerprint.mockResolvedValue({ fingerprint: 'fp_xyz' });
      mockSessionDir.mockReturnValue('/sessions/fp_xyz/sess_test_123');
      mockAppendAuditEvent.mockRejectedValue(new Error('disk full'));

      const result = await handleSessionStart(validPayload);

      expect(result).toEqual({ decision: 'allow' });
      // Audit was attempted.
      expect(mockAppendAuditEvent).toHaveBeenCalled();
    });
  });

  describe('CORNER', () => {
    it('should handle non-Error throw from computeFingerprint', async () => {
      mockEnsureWorkspace.mockResolvedValue(undefined);
      mockComputeFingerprint.mockRejectedValue('string error');

      const result = await handleSessionStart(validPayload);

      expect(result).toEqual({ decision: 'allow' });
      expect(mockAppendAuditEvent).not.toHaveBeenCalled();
    });

    it('should handle non-Error throw from ensureWorkspace', async () => {
      mockEnsureWorkspace.mockRejectedValue(42);

      const result = await handleSessionStart(validPayload);

      expect(result).toEqual({
        decision: 'allow',
        reason: 'workspace bootstrap failed (non-blocking)',
      });
    });
  });
});

describe('handlePreToolUse', () => {
  const validPayload = {
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    session_id: 'sess_test_123',
    cwd: '/tmp/project',
  };

  it('BAD: denies mutating host tools while review obligations are unresolved', async () => {
    mockResolveSession.mockResolvedValue({
      ok: true,
      sessionDir: '/sessions/sess_test_123',
      state: {
        phase: 'IMPLEMENTATION',
        reviewAssurance: {
          obligations: [
            {
              obligationId: '11111111-1111-4111-8111-111111111111',
              status: 'pending',
              consumedAt: null,
            },
          ],
        },
      },
    });

    const result = await handlePreToolUse(validPayload);

    expect(result.decision).toBe('deny');
    expect(result.code).toBe('REVIEW_OBLIGATION_UNRESOLVED');
    expect(result.reason).toContain('11111111-1111-4111-8111-111111111111');
  });

  it('HAPPY: allows non-mutating resolution tools without session resolution', async () => {
    const result = await handlePreToolUse({ ...validPayload, tool_name: 'Read' });

    expect(result).toEqual({ decision: 'allow' });
    expect(mockResolveSession).not.toHaveBeenCalled();
  });

  it('HAPPY: allows authorized reviewer Task calls without obligation gate resolution', async () => {
    const result = await handlePreToolUse({
      ...validPayload,
      tool_name: 'Task',
      tool_input: { subagent_type: 'flowguard-reviewer' },
    });

    expect(result).toEqual({ decision: 'allow' });
    expect(mockResolveSession).not.toHaveBeenCalled();
  });

  it('BAD: denies unknown host tools after state resolution', async () => {
    mockResolveSession.mockResolvedValue({
      ok: true,
      sessionDir: '/sessions/sess_test_123',
      state: { phase: 'IMPLEMENTATION' },
    });

    const result = await handlePreToolUse({ ...validPayload, tool_name: 'UnknownTool' });

    expect(result.decision).toBe('deny');
    expect(result.code).toBe('HOST_TOOL_UNKNOWN_DENIED');
  });
});

describe('handleHttpRequest', () => {
  it('HAPPY: GET /health returns liveness JSON', async () => {
    const req = makeRequest({ method: 'GET', url: '/health', body: '' });
    const res = makeResponse();

    await handleHttpRequest(req as never, res as never);

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual(
      expect.objectContaining({ status: 'ok', pid: expect.any(Number) }),
    );
  });

  it('BAD: unknown POST route returns 404 without resolving a session', async () => {
    const req = makeRequest({ url: '/hooks/unknown', body: '{}' });
    const res = makeResponse();

    await handleHttpRequest(req as never, res as never);

    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'Unknown route: /hooks/unknown' });
    expect(mockResolveSession).not.toHaveBeenCalled();
    expect(mockAppendAuditEvent).not.toHaveBeenCalled();
  });

  it('BAD: invalid JSON returns 400', async () => {
    const req = makeRequest({ body: '{not-json}' });
    const res = makeResponse();

    await handleHttpRequest(req as never, res as never);

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'Invalid JSON in request body' });
    expect(mockResolveSession).not.toHaveBeenCalled();
  });

  it.each(['[]', 'null', '"string"'])('BAD: non-object JSON body %s returns 400', async (body) => {
    const req = makeRequest({ body });
    const res = makeResponse();

    await handleHttpRequest(req as never, res as never);

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'Request body must be a JSON object' });
    expect(mockResolveSession).not.toHaveBeenCalled();
  });

  it('HAPPY: /hooks/post-tool-use appends a tool_call audit event', async () => {
    mockResolveSession.mockResolvedValue({
      ok: true,
      sessionDir: '/sessions/sess_test_123',
      state: { phase: 'IMPLEMENTATION' },
    });
    mockAppendAuditEvent.mockResolvedValue(undefined);
    const req = makeRequest({
      url: '/hooks/post-tool-use',
      body: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        session_id: 'sess_test_123',
        cwd: '/tmp/project',
      }),
    });
    const res = makeResponse();

    await handleHttpRequest(req as never, res as never);

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ decision: 'allow' });
    expect(mockAppendAuditEvent).toHaveBeenCalledWith(
      '/sessions/sess_test_123',
      expect.objectContaining({
        sessionId: 'sess_test_123',
        phase: 'IMPLEMENTATION',
        event: 'tool_call',
        actor: 'machine',
        detail: expect.objectContaining({
          tool: 'Bash',
          input: { command: 'npm test' },
          hookSource: 'http_hook',
        }),
        enforcementLevel: 'hook_gated',
      }),
    );
  });

  it('BAD: /hooks/post-tool-use allows with explicit skip reason when session resolution fails', async () => {
    mockResolveSession.mockResolvedValue({
      ok: false,
      code: 'NO_SESSION',
      reason: 'No governed session found',
    });
    const req = makeRequest({
      url: '/hooks/post-tool-use',
      body: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        session_id: 'sess_test_123',
        cwd: '/tmp/project',
      }),
    });
    const res = makeResponse();

    await handleHttpRequest(req as never, res as never);

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      decision: 'allow',
      reason: 'audit skipped: NO_SESSION',
    });
    expect(mockAppendAuditEvent).not.toHaveBeenCalled();
  });

  it('HAPPY: /hooks/stop appends a session_stop lifecycle event', async () => {
    mockResolveSession.mockResolvedValue({
      ok: true,
      sessionDir: '/sessions/sess_test_123',
      state: {
        phase: 'IMPL_REVIEW',
        reviewAssurance: {
          obligations: [
            { obligationId: 'obl-pending', status: 'pending', consumedAt: null },
            {
              obligationId: 'obl-consumed',
              status: 'consumed',
              consumedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        },
      },
    });
    mockAppendAuditEvent.mockResolvedValue(undefined);
    const req = makeRequest({
      url: '/hooks/stop',
      body: JSON.stringify({ session_id: 'sess_test_123', cwd: '/tmp/project' }),
    });
    const res = makeResponse();

    await handleHttpRequest(req as never, res as never);

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ decision: 'allow' });
    expect(mockAppendAuditEvent).toHaveBeenCalledWith(
      '/sessions/sess_test_123',
      expect.objectContaining({
        sessionId: 'sess_test_123',
        phase: 'IMPL_REVIEW',
        event: 'lifecycle',
        actor: 'system',
        detail: expect.objectContaining({
          action: 'session_stop',
          hookSource: 'http_hook',
          pendingObligations: 1,
          finalPhase: 'IMPL_REVIEW',
        }),
        enforcementLevel: 'hook_gated',
      }),
    );
  });

  it('BAD: /hooks/pre-tool-use internal errors fail closed with deny output', async () => {
    mockResolveSession.mockRejectedValue(new Error('resolver exploded'));
    const req = makeRequest({
      url: '/hooks/pre-tool-use',
      body: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        session_id: 'sess_test_123',
        cwd: '/tmp/project',
      }),
    });
    const res = makeResponse();

    await handleHttpRequest(req as never, res as never);

    const body = JSON.parse(res.body);
    expect(res.status).toBe(200);
    expect(body.decision).toBe('deny');
    expect(body.hookSpecificOutput).toEqual(
      expect.objectContaining({
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining('INTERNAL_ERROR'),
      }),
    );
  });

  it('BAD: rejects Content-Length over the hook body limit with 413', async () => {
    const req = makeRequest({ body: '{}', contentLength: '1048577' });
    const res = makeResponse();

    await handleHttpRequest(req as never, res as never);

    expect(res.status).toBe(413);
    expect(JSON.parse(res.body)).toEqual({ error: 'Request body too large' });
    expect(mockResolveSession).not.toHaveBeenCalled();
  });

  it('BAD: rejects streamed bodies over the hook body limit with 413', async () => {
    const req = makeRequest({ body: 'x'.repeat(1_048_577) });
    const res = makeResponse();

    await handleHttpRequest(req as never, res as never);

    expect(res.status).toBe(413);
    expect(JSON.parse(res.body)).toEqual({ error: 'Request body too large' });
    expect(mockResolveSession).not.toHaveBeenCalled();
  });
});
