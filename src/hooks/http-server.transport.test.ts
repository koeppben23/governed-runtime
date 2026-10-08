/**
 * @module hooks/http-server.transport.test
 * @description Real HTTP transport integration for the D1 (#1027) fail-closed
 * contract: the actual `node:http` hook server is started on an ephemeral port
 * and exercised through real network clients (`fetch` and `node:http`).
 *
 * The `node:http` mock below only captures the server instance the module
 * auto-starts on import so the test can await `listening` and close it in
 * teardown; it delegates to the real implementation and does not simulate the
 * transport. Every assertion is over bytes received on the wire.
 *
 * @test-policy HAPPY, BAD
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http, { type Server } from 'node:http';
import { createServer as createProbeServer, type AddressInfo } from 'node:net';
import { MAX_HOOK_PAYLOAD_BYTES } from './shared/limits.js';

const TEST_HOOK_TOKEN = 'real-http-transport-test-token-at-least-32-characters';

const captured = vi.hoisted(() => ({ server: undefined as Server | undefined }));

vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>();
  return {
    ...actual,
    createServer: (handler?: http.RequestListener) => {
      const server = actual.createServer(handler);
      captured.server = server;
      return server;
    },
  };
});

interface JsonResult {
  readonly status: number;
  readonly json: Record<string, unknown>;
}

let baseUrl: string;
let signalBaseline: {
  sigterm: NodeJS.SignalsListener[];
  sigint: NodeJS.SignalsListener[];
};

async function freePort(): Promise<number> {
  const probe = createProbeServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function postJson(body: string, headers: Record<string, string> = {}): Promise<JsonResult> {
  const response = await fetch(`${baseUrl}/hooks/pre-tool-use`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TEST_HOOK_TOKEN}`,
      'content-type': 'application/json',
      ...headers,
    },
    body,
  });
  return { status: response.status, json: JSON.parse(await response.text()) };
}

/** Chunked (no Content-Length) upload that exceeds the shared cap on the wire. */
function streamedOversizedPost(totalBytes: number): Promise<JsonResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = http.request(
      `${baseUrl}/hooks/pre-tool-use`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TEST_HOOK_TOKEN}`,
          'content-type': 'application/json',
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) =>
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
        );
        response.on('end', () => {
          settled = true;
          resolve({
            status: response.statusCode ?? 0,
            json: JSON.parse(Buffer.concat(chunks).toString('utf-8')),
          });
        });
      },
    );
    request.on('error', (err) => {
      if (!settled) reject(err);
    });
    const chunk = Buffer.alloc(64 * 1024, 0x78);
    let sent = 0;
    const pump = (): void => {
      while (sent < totalBytes) {
        const remaining = totalBytes - sent;
        const slice = remaining >= chunk.byteLength ? chunk : chunk.subarray(0, remaining);
        sent += slice.byteLength;
        if (!request.write(slice)) {
          request.once('drain', pump);
          return;
        }
      }
      request.end();
    };
    pump();
  });
}

function expectProtocolDeny(result: JsonResult, expectedCode: string): void {
  expect(result.status).toBe(200);
  expect(result.json.decision).toBe('deny');
  expect(result.json.code).toBe(expectedCode);
  expect(result.json.hookSpecificOutput).toMatchObject({
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: expect.stringContaining(expectedCode),
  });
}

beforeAll(async () => {
  signalBaseline = {
    sigterm: process.listeners('SIGTERM') as NodeJS.SignalsListener[],
    sigint: process.listeners('SIGINT') as NodeJS.SignalsListener[],
  };
  process.env['FLOWGUARD_HOOK_TOKEN'] = TEST_HOOK_TOKEN;
  process.env['FLOWGUARD_HOOK_HOST'] = '127.0.0.1';
  process.env['FLOWGUARD_HOOK_PORT'] = String(await freePort());

  await import('./http-server.js');
  const server = captured.server;
  if (!server) throw new Error('the real HTTP hook server was not created on import');
  if (!server.listening) {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', () => resolve());
      server.once('error', reject);
    });
  }
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  const server = captured.server;
  if (server?.listening) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  delete process.env['FLOWGUARD_HOOK_TOKEN'];
  delete process.env['FLOWGUARD_HOOK_HOST'];
  delete process.env['FLOWGUARD_HOOK_PORT'];
  for (const listener of process.listeners('SIGTERM') as NodeJS.SignalsListener[]) {
    if (!signalBaseline.sigterm.includes(listener)) process.off('SIGTERM', listener);
  }
  for (const listener of process.listeners('SIGINT') as NodeJS.SignalsListener[]) {
    if (!signalBaseline.sigint.includes(listener)) process.off('SIGINT', listener);
  }
});

describe('real HTTP PreToolUse transport (D1/#1027)', () => {
  it('BAD: invalid content type is delivered as a complete HTTP 200 DENY', async () => {
    const result = await postJson('{}', { 'content-type': 'text/json' });

    expectProtocolDeny(result, 'HOOK_PAYLOAD_INVALID');
  });

  it('BAD: invalid JSON is delivered as a complete HTTP 200 DENY', async () => {
    const result = await postJson('{not-json}');

    expectProtocolDeny(result, 'HOOK_PAYLOAD_INVALID');
  });

  it('BAD: non-object JSON is delivered as a complete HTTP 200 DENY', async () => {
    const result = await postJson('[]');

    expectProtocolDeny(result, 'HOOK_PAYLOAD_INVALID');
  });

  it('BAD: Content-Length over the cap is delivered as a complete HTTP 200 DENY', async () => {
    const result = await postJson('x'.repeat(MAX_HOOK_PAYLOAD_BYTES + 1));

    expectProtocolDeny(result, 'HOOK_STDIN_INVALID');
  });

  it('BAD: streamed body over the cap is delivered as a complete HTTP 200 DENY', async () => {
    const result = await streamedOversizedPost(MAX_HOOK_PAYLOAD_BYTES + 64 * 1024);

    expectProtocolDeny(result, 'HOOK_STDIN_INVALID');
  });

  it('BAD: missing authentication still returns 401 on the wire', async () => {
    const response = await fetch(`${baseUrl}/hooks/pre-tool-use`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(response.status).toBe(401);
    expect(JSON.parse(await response.text())).toEqual({ error: 'Unauthorized' });
  });
});
