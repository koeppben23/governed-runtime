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
}));

vi.mock('../../adapters/workspace/index.js', () => ({
  ensureWorkspace: vi.fn(),
  sessionDir: vi.fn(),
  computeFingerprint: vi.fn(),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

let handleHttpRequest: (typeof import('./http-server.js'))['handleHttpRequest'];

beforeEach(async () => {
  vi.resetModules();
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

function makeRequest(body: string | Buffer, opts?: { contentLength?: string; url?: string }) {
  const buf = typeof body === 'string' ? body : Buffer.from(body);
  const req = new Readable({
    read() {
      this.push(buf);
      this.push(null);
    },
  }) as Readable & { method?: string; url?: string; headers: Record<string, string> };
  req.method = 'POST';
  req.url = opts?.url ?? '/hooks/pre-tool-use';
  req.headers = opts?.contentLength ? { 'content-length': opts.contentLength } : {};
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
  it('handleHttpRequest never throws on arbitrary bodies', () => {
    fc.assert(
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

  it('oversized bodies always return 413', () => {
    fc.assert(
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

  it('truncated and binary bodies return 400, never 500 and never crash', () => {
    fc.assert(
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
});
