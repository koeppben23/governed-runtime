/**
 * @module cli/opencode-output-token-limit.smoke.test
 * @description Real-host proof that OpenCode applies
 * `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX` to the final provider request.
 *
 * OpenCode v1.19.3 computes `min(model.limit.output, outputTokenMax)` in
 * `ProviderTransform.maxOutputTokens`. The host-provided `chat.params` hook is
 * mutable and therefore not proof of the final request. This test captures the
 * actual OpenAI-compatible request body and asserts the transmitted token cap.
 *
 * Gating: runs in CI with the pinned host or locally with `OPENCODE_LIVE=1`.
 * The provider is a deterministic local capture server; no credentials or
 * provider cost are involved. The real DeepSeek acceptance and whether it can
 * emit more than 32,000 tokens remain a live-run result.
 *
 * @test-policy HAPPY, BAD — gated host-contract integration.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { TESTED_OPENCODE_HOST_VERSION } from './opencode-runtime-compat.js';
import {
  createIsolatedOpenCodeEnvironment,
  resolvePinnedOpenCodeHost,
  type PinnedOpenCodeHost,
} from './opencode-live-host.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const EXPECTED_HOST_VERSION =
  process.env.OPENCODE_EXPECTED_HOST_VERSION ?? TESTED_OPENCODE_HOST_VERSION;
const CAN_RUN =
  process.env.OPENCODE_LIVE === '1' || process.env.FLOWGUARD_OPENCODE_HOST_E2E === '1';
const PROMPT_TIMEOUT_MS = 120_000;
const EXEC_TIMEOUT_MS = 300_000;

interface ServeHandle {
  proc: ChildProcess;
  baseUrl: string;
  password: string;
  output: () => string;
}

interface ProbeResult {
  captured: Record<string, unknown>[];
  version: string;
}

let activeServe: ServeHandle | undefined;
let activeCapture: ReturnType<typeof createServer> | undefined;
let activeRoot: string | undefined;

function captureResponse(body: Record<string, unknown>, res: ServerResponse): void {
  const payload = {
    id: 'chatcmpl-probe',
    object: 'chat.completion',
    created: 1,
    model: 'probe',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'OK' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
  if (body.stream === true) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const chunk = (value: unknown) => res.write(`data: ${JSON.stringify(value)}\n\n`);
    chunk({
      id: 'chatcmpl-probe',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'probe',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }],
    });
    chunk({
      id: 'chatcmpl-probe',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'probe',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    });
    chunk({
      id: 'chatcmpl-probe',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'probe',
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    res.end('data: [DONE]\n\n');
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function createCaptureServer(captured: Record<string, unknown>[]): ReturnType<typeof createServer> {
  return createServer(async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method === 'GET' && request.url?.endsWith('/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          object: 'list',
          data: [{ id: 'probe', object: 'model', owned_by: 'flowguard' }],
        }),
      );
      return;
    }
    if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
      response.writeHead(404);
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    captured.push(body);
    captureResponse(body, response);
  });
}

async function stopServe(handle: ServeHandle | undefined): Promise<void> {
  if (!handle || handle.proc.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    handle.proc.once('close', () => resolve());
    handle.proc.kill('SIGTERM');
    setTimeout(() => {
      if (handle.proc.exitCode === null) handle.proc.kill('SIGKILL');
    }, 5_000);
  });
}

async function startServe(
  projectDir: string,
  capturePort: number,
  host: PinnedOpenCodeHost,
  root: string,
  outputTokenMax: number,
): Promise<ServeHandle> {
  await writeFile(
    join(projectDir, 'opencode.json'),
    JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        model: 'flowguard-capture/probe',
        provider: {
          'flowguard-capture': {
            npm: '@ai-sdk/openai-compatible',
            name: 'FlowGuard Capture',
            options: { baseURL: `http://127.0.0.1:${capturePort}/v1`, apiKey: 'test-only' },
            models: {
              probe: {
                name: 'Probe',
                limit: { context: 1_000_000, output: 393_216 },
              },
            },
          },
        },
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  const port = 21000 + Math.floor(Math.random() * 1000);
  const password = `token-limit-${Math.random().toString(36).slice(2)}`;
  const proc = spawn(
    host.command,
    [...host.argsPrefix, 'serve', '--hostname=127.0.0.1', `--port=${port}`, '--print-logs'],
    {
      cwd: projectDir,
      env: {
        ...createIsolatedOpenCodeEnvironment(root, host),
        OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: String(outputTokenMax),
        OPENCODE_SERVER_PASSWORD: password,
        FORCE_COLOR: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let combined = '';
  proc.stdout?.on('data', (chunk: Buffer) => (combined += chunk.toString()));
  proc.stderr?.on('data', (chunk: Buffer) => (combined += chunk.toString()));

  const baseUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`serve did not listen in 60s:\n${combined}`)),
      60_000,
    );
    const onData = (buf: Buffer): void => {
      const match = buf.toString('utf8').match(/listening on\s+(https?:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]!.trim());
      }
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`serve exited early with code ${String(code)}:\n${combined}`));
    });
  });

  return { proc, baseUrl, password, output: () => combined };
}

async function probeOutputLimit(outputTokenMax: number): Promise<ProbeResult> {
  const baseline = JSON.parse(
    await readFile(join(ROOT, '.sdk-baselines', 'opencode', 'host-version.json'), 'utf8'),
  ) as { package: string; version: string };
  const host = resolvePinnedOpenCodeHost(baseline);
  const root = await mkdtemp(join(tmpdir(), 'fg-open-code-token-limit-'));
  activeRoot = root;
  const projectDir = join(root, 'project');
  await mkdir(projectDir, { recursive: true });
  const captured: Record<string, unknown>[] = [];
  const capture = createCaptureServer(captured);
  activeCapture = capture;
  await new Promise<void>((resolve, reject) => {
    capture.once('error', reject);
    capture.listen(0, '127.0.0.1', resolve);
  });
  const address = capture.address();
  if (!address || typeof address === 'string') throw new Error('capture port unavailable');

  const versionProbe = spawnSync(host.command, [...host.argsPrefix, '--version'], {
    encoding: 'utf8',
    timeout: 60_000,
    env: createIsolatedOpenCodeEnvironment(root, host),
  });
  const version = (versionProbe.stdout ?? '').trim();
  expect(version).toBe(EXPECTED_HOST_VERSION);

  activeServe = await startServe(projectDir, address.port, host, root, outputTokenMax);
  const dir = encodeURIComponent(projectDir);
  const auth = `Basic ${Buffer.from(`opencode:${activeServe.password}`).toString('base64')}`;
  const headers = { Authorization: auth, 'Content-Type': 'application/json' };
  const sessionRes = await fetch(`${activeServe.baseUrl}/session?directory=${dir}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title: 'output token limit probe' }),
  });
  const session = (await sessionRes.json()) as { id?: string };
  if (!session.id) throw new Error(`session creation failed: ${JSON.stringify(session)}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROMPT_TIMEOUT_MS);
  try {
    const messageRes = await fetch(
      `${activeServe.baseUrl}/session/${session.id}/message?directory=${dir}`,
      {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          agent: 'build',
          parts: [{ type: 'text', text: 'Reply with OK.' }],
          model: { providerID: 'flowguard-capture', modelID: 'probe' },
        }),
      },
    );
    expect(messageRes.ok, await messageRes.text()).toBe(true);
  } finally {
    clearTimeout(timer);
  }
  return { captured, version };
}

describe.skipIf(!CAN_RUN)('OpenCode output-token cap reaches the provider request', () => {
  afterEach(async () => {
    await stopServe(activeServe);
    activeServe = undefined;
    if (activeCapture) {
      await new Promise<void>((resolve) => activeCapture!.close(() => resolve()));
      activeCapture = undefined;
    }
    if (activeRoot) {
      await rm(activeRoot, { recursive: true, force: true });
      activeRoot = undefined;
    }
  });

  it(
    'HAPPY: 65,536 is transmitted as the final request max token',
    async () => {
      const { captured } = await probeOutputLimit(65536);
      expect(captured.length).toBeGreaterThan(0);
      const body = captured.at(-1)!;
      const transmitted = body['max_tokens'] ?? body['max_output_tokens'];
      expect(transmitted, JSON.stringify(body)).toBe(65536);
    },
    EXEC_TIMEOUT_MS,
  );

  it(
    'BAD: the same probe at 32,000 proves the arms differ only by the cap',
    async () => {
      const { captured } = await probeOutputLimit(32000);
      const body = captured.at(-1)!;
      const transmitted = body['max_tokens'] ?? body['max_output_tokens'];
      expect(transmitted, JSON.stringify(body)).toBe(32000);
    },
    EXEC_TIMEOUT_MS,
  );
});
