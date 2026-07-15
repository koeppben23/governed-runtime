/**
 * @module hooks/http-server.fuzz.test
 * @description Property-based fuzz tests for HTTP hook request handling.
 *
 * Generates malformed request bodies (binary, truncated JSON, deeply nested
 * JSON, random strings) and verifies crash-freedom invariants:
 *
 * - handleHttpRequest never throws unhandled
 * - res.status is always a valid HTTP code
 * - Binary/truncated → 400 (not crash)
 * - Oversized → 413
 *
 * JSON depth is capped at 20 to avoid testing Node's stack rather than hook robustness.
 *
 * run control:
 *   FAST_CHECK_NUM_RUNS=100 npx vitest run --project fuzz
 *   FAST_CHECK_SEED=12345 npx vitest run --project fuzz
 *
 * @see https://github.com/koeppben23/governed-runtime/issues/347
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fc from 'fast-check';
import { Readable } from 'node:stream';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockResolveSession = vi.fn();
const mockAppendAuditEvent = vi.fn();
const mockUnresolvedBlockingObligations = vi.fn();

// Mock http.createServer to prevent port binding during fuzz test execution.
// The fuzz tests exercise handleHttpRequest directly, not the server.
vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>();
  return {
    ...actual,
    createServer: vi.fn(() => ({
      listen: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
    })),
  };
});

vi.mock('./shared/session-resolver.js', () => ({
  resolveSession: (...args: unknown[]) => mockResolveSession(...args),
}));

vi.mock('../../adapters/persistence-audit.js', () => ({
  appendAuditEvent: (...args: unknown[]) => mockAppendAuditEvent(...args),
}));

vi.mock('./shared/obligation-tracker.js', () => ({
  unresolvedBlockingObligations: (...args: unknown[]) => mockUnresolvedBlockingObligations(...args),
  formatUnresolvedBlockingObligationReason: (obligations: Array<{ obligationId: string }>) =>
    `${obligations.length} unresolved review obligation(s) block mutating host tool use: ` +
    obligations
      .map((obligation) => obligation.obligationId)
      .sort()
      .join(', '),
}));

vi.mock('../../adapters/workspace/index.js', () => ({
  ensureWorkspace: vi.fn(),
  sessionDir: vi.fn(),
  computeFingerprint: vi.fn(),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

let handleHttpRequest: (typeof import('./http-server.js'))['handleHttpRequest'];
const TEST_HOOK_TOKEN = 'test-hook-token-with-at-least-thirty-two-characters';

beforeEach(async () => {
  vi.resetModules();
  process.env['FLOWGUARD_HOOK_TOKEN'] = TEST_HOOK_TOKEN;
  mockResolveSession.mockReset();
  mockAppendAuditEvent.mockReset();
  mockUnresolvedBlockingObligations.mockReset();

  mockResolveSession.mockResolvedValue({
    ok: true,
    sessionDir: '/sessions/test',
    state: { phase: 'IMPLEMENTATION' },
  });
  mockAppendAuditEvent.mockResolvedValue(undefined);
  mockUnresolvedBlockingObligations.mockResolvedValue([]);

  const mod = await import('./http-server.js');
  handleHttpRequest = mod.handleHttpRequest;
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRequest(
  body: string | Buffer,
  opts?: {
    contentLength?: string;
    url?: string;
    headers?: Record<string, string>;
    rawHeaders?: string[];
  },
) {
  const buf = typeof body === 'string' ? body : Buffer.from(body);
  const req = new Readable({
    read() {
      this.push(buf);
      this.push(null);
    },
  }) as Readable & {
    method?: string;
    url?: string;
    headers: Record<string, string>;
    rawHeaders: string[];
  };
  req.method = 'POST';
  req.url = opts?.url ?? '/hooks/pre-tool-use';
  req.headers = {
    authorization: `Bearer ${TEST_HOOK_TOKEN}`,
    'content-type': 'application/json',
    ...(opts?.contentLength ? { 'content-length': opts.contentLength } : {}),
    ...opts?.headers,
  };
  req.rawHeaders = opts?.rawHeaders ?? [];
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

describe('HTTP hook fuzz', () => {
  it('malformed authorization values never invoke governance', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (suffix) => {
        const req = makeRequest('{}', {
          headers: { authorization: `Invalid ${suffix}` },
        });
        const res = makeResponse();

        await handleHttpRequest(req as never, res as never);

        expect(res.status).toBe(401);
        expect(mockResolveSession).not.toHaveBeenCalled();
      }),
      {
        numRuns: Number(process.env.FAST_CHECK_NUM_RUNS) || 100,
        seed: Number(process.env.FAST_CHECK_SEED ?? '646'),
        endOnFailure: true,
      },
    );
  });

  it('malformed content types never invoke governance after successful authentication', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (suffix) => {
        const req = makeRequest('{}', {
          headers: { 'content-type': `invalid/${suffix}` },
        });
        const res = makeResponse();

        await handleHttpRequest(req as never, res as never);

        expect(res.status).toBe(415);
        expect(mockResolveSession).not.toHaveBeenCalled();
      }),
      {
        numRuns: Number(process.env.FAST_CHECK_NUM_RUNS) || 100,
        seed: Number(process.env.FAST_CHECK_SEED ?? '648'),
        endOnFailure: true,
      },
    );
  });

  it('duplicate auth or content-type headers are rejected before governance processing', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), fc.string(), async (first, second) => {
        const req = makeRequest('{}', {
          rawHeaders: [
            'Authorization',
            first,
            'Authorization',
            second,
            'Content-Type',
            'application/json',
          ],
        });
        const res = makeResponse();

        await handleHttpRequest(req as never, res as never);

        expect(res.status).toBe(401);
        expect(mockResolveSession).not.toHaveBeenCalled();
      }),
      {
        numRuns: Number(process.env.FAST_CHECK_NUM_RUNS) || 100,
        seed: Number(process.env.FAST_CHECK_SEED ?? '647'),
        endOnFailure: true,
      },
    );
  });

  it('handleHttpRequest never throws on arbitrary bodies', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.string(),
          fc.uint8Array().map((arr) => Buffer.from(arr)),
          fc.json({ maxDepth: 20 }),
          fc.constant(Buffer.from([0x00, 0xff, 0xfe, 0xfd])),
        ),
        fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
        async (rawBody, contentLength) => {
          const body: string | Buffer =
            typeof rawBody === 'object' && !Buffer.isBuffer(rawBody)
              ? JSON.stringify(rawBody)
              : (rawBody as string | Buffer);
          const req = makeRequest(body, { contentLength: contentLength ?? undefined });
          const res = makeResponse();

          await handleHttpRequest(req as never, res as never);
          expect(res.status).toBeGreaterThanOrEqual(100);
          expect(res.status).toBeLessThan(600);
        },
      ),
      {
        numRuns: Number(process.env.FAST_CHECK_NUM_RUNS) || 100,
        seed: Number(process.env.FAST_CHECK_SEED ?? '12345'),
        endOnFailure: true,
      },
    );
  });

  it('oversized bodies always return 413', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1_048_577, max: 2_000_000 }), async (contentLength) => {
        const req = makeRequest('{}', { contentLength: String(contentLength) });
        const res = makeResponse();

        await handleHttpRequest(req as never, res as never);
        expect(res.status).toBe(413);
      }),
      {
        numRuns: Number(process.env.FAST_CHECK_NUM_RUNS) || 100,
        seed: Number(process.env.FAST_CHECK_SEED ?? '12345'),
        endOnFailure: true,
      },
    );
  });

  it('truncated and binary bodies return 400, never 500 and never crash', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.uint8Array({ minLength: 1, maxLength: 100 }).map((arr) => Buffer.from(arr)),
          fc.string({ minLength: 1, maxLength: 200 }).map((s) => s.slice(0, s.length / 2)),
        ),
        async (body) => {
          const req = makeRequest(body);
          const res = makeResponse();

          await handleHttpRequest(req as never, res as never);
          expect(res.status).toBeGreaterThanOrEqual(400);
          expect([400, 404, 405, 413]).toContain(res.status);
        },
      ),
      {
        numRuns: Number(process.env.FAST_CHECK_NUM_RUNS) || 100,
        seed: Number(process.env.FAST_CHECK_SEED ?? '12345'),
        endOnFailure: true,
      },
    );
  });

  it('/hooks/session-start and /hooks/stop never crash on arbitrary payloads', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.constant('/hooks/session-start'),
          fc.constant('/hooks/stop'),
          fc.constant('/hooks/post-tool-use'),
        ),
        fc.oneof(
          fc.string(),
          fc.uint8Array().map((arr) => Buffer.from(arr)),
          fc.constant('{}'),
          fc.record({
            session_id: fc.string({ minLength: 1 }),
            cwd: fc.string({ minLength: 1 }),
          }),
        ),
        async (url, rawBody) => {
          const body: string | Buffer =
            typeof rawBody === 'object' && !Buffer.isBuffer(rawBody)
              ? JSON.stringify(rawBody)
              : (rawBody as string | Buffer);
          const req = makeRequest(body, { url });
          const res = makeResponse();

          await handleHttpRequest(req as never, res as never);
          // All valid HTTP status codes; 500 is acceptable for internal errors
          // but the handler must never throw.
          expect(res.status).toBeGreaterThanOrEqual(100);
          expect(res.status).toBeLessThan(600);
        },
      ),
      {
        numRuns: Number(process.env.FAST_CHECK_NUM_RUNS) || 100,
        seed: Number(process.env.FAST_CHECK_SEED ?? '12345'),
        endOnFailure: true,
      },
    );
  });

  it('unauthenticated non-POST methods on hook routes return 401, never crash', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('GET', 'DELETE', 'PUT', 'PATCH', 'OPTIONS'),
        fc.constantFrom(
          '/hooks/pre-tool-use',
          '/hooks/session-start',
          '/hooks/stop',
          '/hooks/post-tool-use',
        ),
        async (method, url) => {
          const req = new Readable({
            read() {
              this.push(null);
            },
          }) as Readable & { method?: string; url?: string; headers: Record<string, string> };
          req.method = method;
          req.url = url;
          req.headers = {};
          const res = makeResponse();

          await handleHttpRequest(req as never, res as never);
          expect(res.status).toBe(401);
        },
      ),
      {
        numRuns: Number(process.env.FAST_CHECK_NUM_RUNS) || 100,
        seed: Number(process.env.FAST_CHECK_SEED ?? '12345'),
        endOnFailure: true,
      },
    );
  });
});
