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
import { MAX_HOOK_PAYLOAD_BYTES } from './shared/limits.js';

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

// Mock git root resolution (H8: payload cwd is never a filesystem authority).
const mockResolveRoot = vi.fn();

vi.mock('../adapters/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../adapters/git.js')>();
  return { ...actual, resolveRoot: (...args: unknown[]) => mockResolveRoot(...args) };
});

// Mock audit persistence.
const mockAppendAuditEvent = vi.fn();

vi.mock('../adapters/persistence-audit.js', () => ({
  appendAuditEvent: (...args: unknown[]) => mockAppendAuditEvent(...args),
}));

// Mock the bounded transport ingestion-failure ledger.
const mockAppendHookIngestFailure = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({ recorded: true })),
);

vi.mock('../adapters/persistence-hook-ingest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../adapters/persistence-hook-ingest.js')>();
  return {
    ...actual,
    appendHookIngestFailure: (...args: unknown[]) => mockAppendHookIngestFailure(...args),
  };
});

// Mock session-resolver (not used by handleSessionStart, but imported by module).
const mockResolveSession = vi.fn();

vi.mock('./shared/session-resolver.js', () => ({
  resolveSession: (...args: unknown[]) => mockResolveSession(...args),
}));

// Mock obligation-tracker.
vi.mock('./shared/obligation-tracker.js', () => ({
  assessObligationEscalation: vi.fn(() => ({ message: null })),
  formatUnresolvedBlockingObligationReason: (obligations: Array<{ obligationId: string }>) =>
    `${obligations.length} unresolved review obligation(s) block mutating host tool use: ` +
    obligations
      .map((obligation) => obligation.obligationId)
      .sort()
      .join(', '),
  unresolvedBlockingObligations: (state: {
    reviewAssurance?: { obligations?: Array<{ status: string; consumedAt: string | null }> };
  }) =>
    (state.reviewAssurance?.obligations ?? []).filter(
      (ob) => (ob.status === 'pending' || ob.status === 'fulfilled') && ob.consumedAt == null,
    ),
}));

// ─── Import handler after mocks ──────────────────────────────────────────────

let handleSessionStart: (typeof import('./http-server.js'))['handleSessionStart'];
let handleHttpRequest: (typeof import('./http-server.js'))['handleHttpRequest'];
let readHttpHookServerConfig: (typeof import('./http-server.js'))['readHttpHookServerConfig'];
let signalListenerBaseline: {
  sigterm: NodeJS.SignalsListener[];
  sigint: NodeJS.SignalsListener[];
};

const TEST_HOOK_TOKEN = 'test-hook-token-with-at-least-thirty-two-characters';

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env['FLOWGUARD_HOOK_TOKEN'] = TEST_HOOK_TOKEN;
  delete process.env['FLOWGUARD_HOOK_HOST'];
  delete process.env['FLOWGUARD_HOOK_PORT'];
  delete process.env['FLOWGUARD_HOOK_ALLOW_REMOTE'];
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
  vi.doMock('../adapters/git.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../adapters/git.js')>();
    return { ...actual, resolveRoot: (...args: unknown[]) => mockResolveRoot(...args) };
  });
  vi.doMock('../adapters/persistence-audit.js', () => ({
    appendAuditEvent: (...args: unknown[]) => mockAppendAuditEvent(...args),
  }));
  vi.doMock('../adapters/persistence-hook-ingest.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../adapters/persistence-hook-ingest.js')>();
    return {
      ...actual,
      appendHookIngestFailure: (...args: unknown[]) => mockAppendHookIngestFailure(...args),
    };
  });
  vi.doMock('./shared/session-resolver.js', () => ({
    resolveSession: (...args: unknown[]) => mockResolveSession(...args),
  }));
  vi.doMock('./shared/obligation-tracker.js', () => ({
    assessObligationEscalation: vi.fn(() => ({ message: null })),
    formatUnresolvedBlockingObligationReason: (obligations: Array<{ obligationId: string }>) =>
      `${obligations.length} unresolved review obligation(s) block mutating host tool use: ` +
      obligations
        .map((obligation) => obligation.obligationId)
        .sort()
        .join(', '),
    unresolvedBlockingObligations: (state: {
      reviewAssurance?: { obligations?: Array<{ status: string; consumedAt: string | null }> };
    }) =>
      (state.reviewAssurance?.obligations ?? []).filter(
        (ob) => (ob.status === 'pending' || ob.status === 'fulfilled') && ob.consumedAt == null,
      ),
  }));

  const mod = await import('./http-server.js');
  handleSessionStart = mod.handleSessionStart;
  handlePreToolUse = mod.handlePreToolUse;
  handleHttpRequest = mod.handleHttpRequest;
  readHttpHookServerConfig = mod.readHttpHookServerConfig;

  mockResolveRoot.mockReset();
  mockResolveRoot.mockResolvedValue('/tmp/project');
});

afterEach(() => {
  for (const listener of process.listeners('SIGTERM') as NodeJS.SignalsListener[]) {
    if (!signalListenerBaseline.sigterm.includes(listener)) process.off('SIGTERM', listener);
  }
  delete process.env['FLOWGUARD_HOOK_TOKEN'];
  delete process.env['FLOWGUARD_HOOK_HOST'];
  delete process.env['FLOWGUARD_HOOK_PORT'];
  delete process.env['FLOWGUARD_HOOK_ALLOW_REMOTE'];
  delete process.env['FLOWGUARD_SESSION_DIR'];
  process.exitCode = undefined;
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
  headers?: Record<string, string>;
  rawHeaders?: string[];
}) {
  const req = new Readable({
    read() {
      this.push(input.body);
      this.push(null);
    },
  }) as Readable & {
    method?: string;
    url?: string;
    headers: Record<string, string>;
    rawHeaders: string[];
  };
  req.method = input.method ?? 'POST';
  req.url = input.url ?? '/hooks/pre-tool-use';
  req.headers = {
    authorization: `Bearer ${TEST_HOOK_TOKEN}`,
    'content-type': 'application/json',
    ...(input.contentLength ? { 'content-length': input.contentLength } : {}),
    ...input.headers,
  };
  req.rawHeaders = input.rawHeaders ?? [];
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
      mockResolveSession.mockResolvedValue({
        ok: true,
        sessionDir: '/workspace/sessions/fp_abc123/sess_test_123',
        state: { flowguardSessionId: '00000000-0000-4000-8000-000000000002', phase: 'READY' },
      });
      mockAppendAuditEvent.mockResolvedValue(undefined);

      const result = await handleSessionStart(validPayload);

      expect(result).toEqual({ decision: 'allow' });
      expect(mockEnsureWorkspace).toHaveBeenCalledWith('/tmp/project');
      expect(mockAppendAuditEvent).toHaveBeenCalledWith(
        '/workspace/sessions/fp_abc123/sess_test_123',
        expect.objectContaining({
          flowguardSessionId: '00000000-0000-4000-8000-000000000002',
          hostSessionId: 'sess_test_123',
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

  describe('H8 cwd binding', () => {
    it('bootstraps the git-resolved worktree root, not the raw payload cwd', async () => {
      mockResolveRoot.mockResolvedValue('/canonical/project');
      mockEnsureWorkspace.mockResolvedValue(undefined);
      mockResolveSession.mockResolvedValue({
        ok: true,
        sessionDir: '/workspace/sessions/fp/sess_test_123',
        state: { flowguardSessionId: '00000000-0000-4000-8000-000000000004', phase: 'READY' },
      });
      mockAppendAuditEvent.mockResolvedValue(undefined);

      await handleSessionStart(validPayload);

      expect(mockResolveRoot).toHaveBeenCalledWith('/tmp/project');
      expect(mockEnsureWorkspace).toHaveBeenCalledWith('/canonical/project');
    });

    it('rejects bootstrap when the cwd is not a git worktree', async () => {
      mockResolveRoot.mockRejectedValue(new Error('not a git repository'));

      const result = await handleSessionStart(validPayload);

      expect(result).toEqual({
        decision: 'allow',
        reason: 'workspace bootstrap failed (non-blocking)',
      });
      expect(mockEnsureWorkspace).not.toHaveBeenCalled();
      expect(mockResolveSession).not.toHaveBeenCalled();
    });

    it('skips bootstrap under the explicit session-dir override', async () => {
      process.env['FLOWGUARD_SESSION_DIR'] = '/override/dir';
      mockResolveSession.mockResolvedValue({
        ok: true,
        sessionDir: '/override/dir',
        state: { flowguardSessionId: '00000000-0000-4000-8000-000000000005', phase: 'READY' },
      });
      mockAppendAuditEvent.mockResolvedValue(undefined);

      await handleSessionStart(validPayload);

      expect(mockResolveRoot).not.toHaveBeenCalled();
      expect(mockEnsureWorkspace).not.toHaveBeenCalled();
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
      expect(mockAppendAuditEvent).not.toHaveBeenCalled();
    });

    it('should return allow when session resolution fails (audit skipped)', async () => {
      mockEnsureWorkspace.mockResolvedValue(undefined);
      mockResolveSession.mockResolvedValue({
        ok: false,
        code: 'SESSION_DIR_NOT_FOUND',
        reason: 'no state',
      });

      const result = await handleSessionStart(validPayload);

      expect(result).toEqual({ decision: 'allow' });
      // Audit should NOT be called without a resolved FlowGuard identity.
      expect(mockAppendAuditEvent).not.toHaveBeenCalled();
    });

    it('should return allow when appendAuditEvent fails (non-fatal)', async () => {
      mockEnsureWorkspace.mockResolvedValue(undefined);
      mockResolveSession.mockResolvedValue({
        ok: true,
        sessionDir: '/sessions/fp_xyz/sess_test_123',
        state: { flowguardSessionId: '00000000-0000-4000-8000-000000000002', phase: 'READY' },
      });
      mockAppendAuditEvent.mockRejectedValue(new Error('disk full'));

      const result = await handleSessionStart(validPayload);

      expect(result).toEqual({ decision: 'allow' });
      // Audit was attempted.
      expect(mockAppendAuditEvent).toHaveBeenCalled();
    });
  });

  describe('CORNER', () => {
    it('should handle non-Error throw from session resolution', async () => {
      mockEnsureWorkspace.mockResolvedValue(undefined);
      mockResolveSession.mockRejectedValue('string error');

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

  it('HAPPY: allows mutating host tools when only terminal obligations remain', async () => {
    mockResolveSession.mockResolvedValue({
      ok: true,
      sessionDir: '/sessions/sess_test_123',
      state: {
        phase: 'IMPLEMENTATION',
        reviewAssurance: {
          obligations: [
            {
              obligationId: '22222222-2222-4222-8222-222222222222',
              status: 'blocked',
              consumedAt: null,
            },
          ],
        },
      },
    });

    const result = await handlePreToolUse(validPayload);

    expect(result).toEqual({ decision: 'allow' });
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
    expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
    expect(res.headers).not.toHaveProperty('Access-Control-Allow-Origin');
    expect(res.headers).not.toHaveProperty('Access-Control-Allow-Credentials');
    expect(res.headers).not.toHaveProperty('Access-Control-Allow-Headers');
    expect(res.headers).not.toHaveProperty('Access-Control-Allow-Methods');
  });

  it.each([
    { label: 'missing authorization', headers: { authorization: '' } },
    { label: 'wrong token', headers: { authorization: 'Bearer wrong-token' } },
    { label: 'wrong scheme', headers: { authorization: `Basic ${TEST_HOOK_TOKEN}` } },
    { label: 'extra token part', headers: { authorization: `Bearer ${TEST_HOOK_TOKEN} extra` } },
  ])('BAD: $label returns 401 before state resolution', async ({ headers }) => {
    const req = makeRequest({ body: '{}', headers });
    const res = makeResponse();

    await handleHttpRequest(req as never, res as never);

    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'Unauthorized' });
    expect(mockResolveSession).not.toHaveBeenCalled();
    expect(mockAppendAuditEvent).not.toHaveBeenCalled();
  });

  it.each([
    { method: 'GET', url: '/hooks/pre-tool-use' },
    { method: 'POST', url: '/hooks/unknown' },
    { method: 'OPTIONS', url: '/hooks/unknown' },
  ])(
    'BAD: unauthenticated $method $url returns 401 without route enumeration',
    async ({ method, url }) => {
      const req = makeRequest({ method, url, body: '', headers: { authorization: '' } });
      const res = makeResponse();

      await handleHttpRequest(req as never, res as never);

      expect(res.status).toBe(401);
      expect(JSON.parse(res.body)).toEqual({ error: 'Unauthorized' });
      expect(mockResolveSession).not.toHaveBeenCalled();
      expect(mockAppendAuditEvent).not.toHaveBeenCalled();
    },
  );

  it('BAD: duplicate authorization headers return 401 before body processing', async () => {
    const req = makeRequest({
      body: '{}',
      rawHeaders: [
        'Authorization',
        `Bearer ${TEST_HOOK_TOKEN}`,
        'Authorization',
        `Bearer ${TEST_HOOK_TOKEN}`,
        'Content-Type',
        'application/json',
      ],
    });
    const res = makeResponse();

    await handleHttpRequest(req as never, res as never);

    expect(res.status).toBe(401);
    expect(mockResolveSession).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'missing content type', headers: { 'content-type': '' } },
    { label: 'wrong content type', headers: { 'content-type': 'text/json' } },
  ])('BAD: $label returns 415 before state resolution', async ({ headers }) => {
    const req = makeRequest({ url: '/hooks/post-tool-use', body: '{}', headers });
    const res = makeResponse();

    await handleHttpRequest(req as never, res as never);

    expect(res.status).toBe(415);
    expect(mockResolveSession).not.toHaveBeenCalled();
  });

  it('HAPPY: application/json with charset is accepted', async () => {
    const req = makeRequest({
      body: JSON.stringify({ tool_name: 'Read', tool_input: {}, session_id: 's', cwd: '/tmp' }),
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
    const res = makeResponse();

    await handleHttpRequest(req as never, res as never);

    expect(res.status).toBe(200);
  });

  it('BAD: authenticated OPTIONS on a hook route returns 405', async () => {
    const req = makeRequest({ method: 'OPTIONS', body: '' });
    const res = makeResponse();

    await handleHttpRequest(req as never, res as never);

    expect(res.status).toBe(405);
  });

  it('BAD: authenticated non-POST non-health requests return 405 without resolving a session', async () => {
    const req = makeRequest({ method: 'GET', url: '/hooks/pre-tool-use', body: '' });
    const res = makeResponse();

    await handleHttpRequest(req as never, res as never);

    expect(res.status).toBe(405);
    expect(JSON.parse(res.body)).toEqual({ error: 'Method not allowed' });
    expect(mockResolveSession).not.toHaveBeenCalled();
  });

  it('BAD: authenticated unknown POST route returns 404 without resolving a session', async () => {
    const req = makeRequest({ url: '/hooks/unknown', body: '{}' });
    const res = makeResponse();

    await handleHttpRequest(req as never, res as never);

    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'Unknown route: /hooks/unknown' });
    expect(mockResolveSession).not.toHaveBeenCalled();
    expect(mockAppendAuditEvent).not.toHaveBeenCalled();
  });

  it('BAD: invalid JSON returns 400 and records a transport ingestion failure', async () => {
    const req = makeRequest({ url: '/hooks/post-tool-use', body: '{not-json}' });
    const res = makeResponse();

    await handleHttpRequest(req as never, res as never);

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Invalid JSON in request body',
      auditFailureRecorded: true,
    });
    expect(mockAppendHookIngestFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        transport: 'http_hook',
        reasonCode: 'HOOK_PAYLOAD_INVALID',
        observedBytes: Buffer.byteLength('{not-json}'),
        observedPrefix: Buffer.from('{not-json}'),
      }),
    );
    expect(mockResolveSession).not.toHaveBeenCalled();
  });

  it.each(['[]', 'null', '"string"'])('BAD: non-object JSON body %s returns 400', async (body) => {
    const req = makeRequest({ url: '/hooks/post-tool-use', body });
    const res = makeResponse();

    await handleHttpRequest(req as never, res as never);

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Request body must be a JSON object',
      auditFailureRecorded: true,
    });
    expect(mockResolveSession).not.toHaveBeenCalled();
  });

  it('BAD: post-tool-use validation failure is recorded with the observed raw bytes', async () => {
    const body = JSON.stringify({ foo: 'bar' });
    const req = makeRequest({ url: '/hooks/post-tool-use', body });
    const res = makeResponse();

    await handleHttpRequest(req as never, res as never);

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      decision: 'allow',
      reason: 'audit skipped: HOOK_PAYLOAD_INVALID',
      auditFailureRecorded: true,
    });
    // The transport already read and parsed the body: the observed raw bytes
    // are preserved instead of claiming an unavailable digest.
    expect(mockAppendHookIngestFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        transport: 'http_hook',
        reasonCode: 'HOOK_PAYLOAD_INVALID',
        observedBytes: Buffer.byteLength(body),
        observedPrefix: Buffer.from(body),
      }),
    );
    expect(mockAppendAuditEvent).not.toHaveBeenCalled();
  });

  it('BAD: post-tool-use invalid content type is recorded with an unavailable digest', async () => {
    const req = makeRequest({
      url: '/hooks/post-tool-use',
      body: '{}',
      headers: { 'content-type': 'text/json' },
    });
    const res = makeResponse();

    await handleHttpRequest(req as never, res as never);

    expect(res.status).toBe(415);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Content-Type must be application/json',
      auditFailureRecorded: true,
    });
    expect(mockAppendHookIngestFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        transport: 'http_hook',
        reasonCode: 'HOOK_PAYLOAD_INVALID',
        observedBytes: null,
        observedPrefix: null,
      }),
    );
  });

  it('BAD: a single oversized chunk observes its bytes but retains only the cap prefix', async () => {
    const req = makeRequest({
      url: '/hooks/post-tool-use',
      body: 'y'.repeat(MAX_HOOK_PAYLOAD_BYTES + 64 * 1024),
    });
    const res = makeResponse();

    await handleHttpRequest(req as never, res as never);

    expect(res.status).toBe(413);
    const [failure] = mockAppendHookIngestFailure.mock.calls[0] as [
      { observedBytes: number; observedPrefix: Buffer },
    ];
    expect(failure.observedBytes).toBe(MAX_HOOK_PAYLOAD_BYTES + 64 * 1024);
    expect(Buffer.isBuffer(failure.observedPrefix)).toBe(true);
    expect(failure.observedPrefix.byteLength).toBe(MAX_HOOK_PAYLOAD_BYTES);
  });

  it('BAD: a stream failure after observed chunks preserves their bytes', async () => {
    const req = new Readable({
      read() {
        this.push('{"tool_name":"Bash"');
        this.destroy(new Error('connection reset'));
      },
    }) as Readable & {
      method?: string;
      url?: string;
      headers: Record<string, string>;
      rawHeaders: string[];
    };
    req.method = 'POST';
    req.url = '/hooks/post-tool-use';
    req.headers = {
      authorization: `Bearer ${TEST_HOOK_TOKEN}`,
      'content-type': 'application/json',
    };
    req.rawHeaders = [];
    const res = makeResponse();

    await handleHttpRequest(req as never, res as never);

    expect(res.status).toBe(400);
    expect(mockAppendHookIngestFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        transport: 'http_hook',
        reasonCode: 'HOOK_STDIN_INVALID',
        observedBytes: Buffer.byteLength('{"tool_name":"Bash"'),
        observedPrefix: Buffer.from('{"tool_name":"Bash"'),
      }),
    );
  });

  it('HAPPY: /hooks/post-tool-use appends a tool_call audit event', async () => {
    mockResolveSession.mockResolvedValue({
      ok: true,
      sessionDir: '/sessions/sess_test_123',
      state: {
        flowguardSessionId: '00000000-0000-4000-8000-000000000002',
        phase: 'IMPLEMENTATION',
      },
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
        flowguardSessionId: '00000000-0000-4000-8000-000000000002',
        hostSessionId: 'sess_test_123',
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

  it('HAPPY: /hooks/post-tool-use truncates large string inputs in the audit detail', async () => {
    mockResolveSession.mockResolvedValue({
      ok: true,
      sessionDir: '/sessions/sess_test_123',
      state: { phase: 'IMPLEMENTATION' },
    });
    mockAppendAuditEvent.mockResolvedValue(undefined);
    const longCommand = 'x'.repeat(501);
    const req = makeRequest({
      url: '/hooks/post-tool-use',
      body: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: longCommand, untouched: 7 },
        session_id: 'sess_test_123',
        cwd: '/tmp/project',
      }),
    });
    const res = makeResponse();

    await handleHttpRequest(req as never, res as never);

    expect(res.status).toBe(200);
    expect(mockAppendAuditEvent).toHaveBeenCalledWith(
      '/sessions/sess_test_123',
      expect.objectContaining({
        detail: expect.objectContaining({
          input: {
            command: `${'x'.repeat(500)}... [truncated, 501 chars]`,
            untouched: 7,
          },
        }),
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
        flowguardSessionId: '00000000-0000-4000-8000-000000000002',
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
        flowguardSessionId: '00000000-0000-4000-8000-000000000002',
        hostSessionId: 'sess_test_123',
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

  it('HAPPY: /hooks/stop counts zero pending obligations when none are open', async () => {
    mockResolveSession.mockResolvedValue({
      ok: true,
      sessionDir: '/sessions/sess_test_123',
      state: {
        phase: 'COMPLETE',
        reviewAssurance: {
          obligations: [
            { obligationId: 'obl-consumed', status: 'consumed', consumedAt: null },
            {
              obligationId: 'obl-consumed-at',
              status: 'pending',
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
    expect(mockAppendAuditEvent).toHaveBeenCalledWith(
      '/sessions/sess_test_123',
      expect.objectContaining({
        detail: expect.objectContaining({
          pendingObligations: 0,
          finalPhase: 'COMPLETE',
        }),
      }),
    );
  });

  it('BAD: /hooks/pre-tool-use denial includes Claude-compatible deny output', async () => {
    mockResolveSession.mockResolvedValue({
      ok: true,
      sessionDir: '/sessions/sess_test_123',
      state: { phase: 'TICKET' },
    });
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
    expect(body.code).toBe('HOST_TOOL_PHASE_DENIED');
    expect(body.hookSpecificOutput).toMatchObject({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: expect.stringContaining('HOST_TOOL_PHASE_DENIED'),
    });
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

  it('BAD: non-pre hook internal errors return 500 without deny hook output', async () => {
    mockResolveSession.mockRejectedValue(new Error('resolver exploded'));
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

    expect(res.status).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'Internal server error' });
  });

  it('HAPPY: accepts Content-Length exactly at the hook body limit', async () => {
    mockResolveSession.mockResolvedValue({
      ok: true,
      sessionDir: '/sessions/sess_test_123',
      state: { phase: 'IMPLEMENTATION' },
    });
    const body = JSON.stringify({
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/file' },
      session_id: 'sess_test_123',
      cwd: '/tmp/project',
    });
    const req = makeRequest({ body, contentLength: String(MAX_HOOK_PAYLOAD_BYTES) });
    const res = makeResponse();

    await handleHttpRequest(req as never, res as never);

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ decision: 'allow' });
  });

  it('BAD: rejects Content-Length over the hook body limit with 413', async () => {
    const req = makeRequest({
      url: '/hooks/post-tool-use',
      body: '{}',
      contentLength: String(MAX_HOOK_PAYLOAD_BYTES + 1),
    });
    const res = makeResponse();

    await handleHttpRequest(req as never, res as never);

    expect(res.status).toBe(413);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Request body too large',
      auditFailureRecorded: true,
    });
    expect(mockResolveSession).not.toHaveBeenCalled();
  });

  it('BAD: rejects streamed bodies over the hook body limit with 413', async () => {
    const req = makeRequest({
      url: '/hooks/post-tool-use',
      body: 'x'.repeat(MAX_HOOK_PAYLOAD_BYTES + 1),
    });
    const res = makeResponse();

    await handleHttpRequest(req as never, res as never);

    expect(res.status).toBe(413);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Request body too large',
      auditFailureRecorded: true,
    });
    expect(mockAppendHookIngestFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        transport: 'http_hook',
        reasonCode: 'HOOK_STDIN_INVALID',
        observedBytes: MAX_HOOK_PAYLOAD_BYTES + 1,
      }),
    );
    expect(mockResolveSession).not.toHaveBeenCalled();
  });

  // D1 (#1027): Claude Code treats non-2xx HTTP hook responses as non-blocking.
  // Every authenticated pre-tool-use transport/validation failure must therefore
  // be delivered as a protocol-correct HTTP 2xx DENY. Transport failures on the
  // non-blocking informational routes keep their status codes.
  describe('D1: pre-tool-use transport failures are host-observable DENY', () => {
    function expectPreToolUseDeny(
      res: ReturnType<typeof makeResponse>,
      expectedCode: string,
    ): void {
      expect(res.status).toBe(200);
      expect(res.headers['Content-Type']).toBe('application/json');
      const body = JSON.parse(res.body);
      expect(body.decision).toBe('deny');
      expect(body.code).toBe(expectedCode);
      expect(body.hookSpecificOutput).toEqual(
        expect.objectContaining({
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: expect.stringContaining(expectedCode),
        }),
      );
    }

    it.each([
      { label: 'missing content type', headers: { 'content-type': '' } },
      { label: 'wrong content type', headers: { 'content-type': 'text/json' } },
    ])('BAD: $label returns 200 host-observable DENY', async ({ headers }) => {
      const req = makeRequest({ body: '{}', headers });
      const res = makeResponse();

      await handleHttpRequest(req as never, res as never);

      expectPreToolUseDeny(res, 'HOOK_PAYLOAD_INVALID');
      expect(mockResolveSession).not.toHaveBeenCalled();
    });

    it('BAD: Content-Length over the hook body limit returns 200 host-observable DENY', async () => {
      const req = makeRequest({
        body: '{}',
        contentLength: String(MAX_HOOK_PAYLOAD_BYTES + 1),
      });
      const res = makeResponse();

      await handleHttpRequest(req as never, res as never);

      expectPreToolUseDeny(res, 'HOOK_STDIN_INVALID');
      expect(mockResolveSession).not.toHaveBeenCalled();
    });

    it('BAD: streamed body over the hook body limit returns 200 host-observable DENY', async () => {
      const req = makeRequest({ body: 'x'.repeat(MAX_HOOK_PAYLOAD_BYTES + 1) });
      const res = makeResponse();

      await handleHttpRequest(req as never, res as never);

      expectPreToolUseDeny(res, 'HOOK_STDIN_INVALID');
      expect(mockResolveSession).not.toHaveBeenCalled();
    });

    it('HAPPY: streamed body exactly at the hook body limit is not rejected as oversized', async () => {
      const payload = JSON.stringify({
        tool_name: 'Read',
        tool_input: {},
        session_id: 's1',
        cwd: '/tmp',
      });
      const body = payload + ' '.repeat(MAX_HOOK_PAYLOAD_BYTES - payload.length);
      const req = makeRequest({ body });
      const res = makeResponse();

      await handleHttpRequest(req as never, res as never);

      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ decision: 'allow' });
    });

    it.each(['{not-json}', '[]', 'null', '"string"'])(
      'BAD: malformed body %s returns 200 host-observable DENY',
      async (body) => {
        const req = makeRequest({ body });
        const res = makeResponse();

        await handleHttpRequest(req as never, res as never);

        expectPreToolUseDeny(res, 'HOOK_PAYLOAD_INVALID');
        expect(mockResolveSession).not.toHaveBeenCalled();
      },
    );

    it('BAD: body read failure returns 200 host-observable DENY', async () => {
      const req = makeRequest({ body: '' });
      Object.defineProperty(req, Symbol.asyncIterator, {
        value: () => {
          throw new Error('read exploded');
        },
      });
      const res = makeResponse();

      await handleHttpRequest(req as never, res as never);

      expectPreToolUseDeny(res, 'HOOK_STDIN_INVALID');
      expect(mockResolveSession).not.toHaveBeenCalled();
    });

    it('BAD: unauthenticated pre-tool-use still returns 401 (trust boundary unchanged)', async () => {
      const req = makeRequest({ body: '{}', headers: { authorization: '' } });
      const res = makeResponse();

      await handleHttpRequest(req as never, res as never);

      expect(res.status).toBe(401);
      expect(JSON.parse(res.body)).toEqual({ error: 'Unauthorized' });
      expect(mockResolveSession).not.toHaveBeenCalled();
    });

    it('BAD: non-POST pre-tool-use still returns 405 before route resolution', async () => {
      const req = makeRequest({ method: 'GET', url: '/hooks/pre-tool-use', body: '' });
      const res = makeResponse();

      await handleHttpRequest(req as never, res as never);

      expect(res.status).toBe(405);
      expect(mockResolveSession).not.toHaveBeenCalled();
    });
  });
});

describe('readHttpHookServerConfig', () => {
  it('uses the secure loopback defaults with an explicit token', () => {
    expect(readHttpHookServerConfig({ FLOWGUARD_HOOK_TOKEN: TEST_HOOK_TOKEN })).toEqual({
      binding: 'loopback',
      host: '127.0.0.1',
      port: 18462,
      token: TEST_HOOK_TOKEN,
    });
  });

  it('permits IPv6 loopback and remote binds only with explicit opt-in', () => {
    expect(
      readHttpHookServerConfig({
        FLOWGUARD_HOOK_TOKEN: TEST_HOOK_TOKEN,
        FLOWGUARD_HOOK_HOST: '::1',
      }),
    ).toMatchObject({ binding: 'loopback', host: '::1' });
    expect(
      readHttpHookServerConfig({
        FLOWGUARD_HOOK_TOKEN: TEST_HOOK_TOKEN,
        FLOWGUARD_HOOK_HOST: '0.0.0.0',
        FLOWGUARD_HOOK_ALLOW_REMOTE: '1',
      }),
    ).toMatchObject({ binding: 'remote', allowRemote: true });
  });

  it.each([
    {},
    { FLOWGUARD_HOOK_TOKEN: 'short' },
    { FLOWGUARD_HOOK_TOKEN: TEST_HOOK_TOKEN, FLOWGUARD_HOOK_HOST: '0.0.0.0' },
    { FLOWGUARD_HOOK_TOKEN: TEST_HOOK_TOKEN, FLOWGUARD_HOOK_HOST: 'localhost' },
    { FLOWGUARD_HOOK_TOKEN: TEST_HOOK_TOKEN, FLOWGUARD_HOOK_PORT: '0' },
    { FLOWGUARD_HOOK_TOKEN: TEST_HOOK_TOKEN, FLOWGUARD_HOOK_PORT: '18462abc' },
  ])('rejects unsafe or malformed configuration: %o', (env) => {
    expect(() => readHttpHookServerConfig(env)).toThrow(TypeError);
  });
});
