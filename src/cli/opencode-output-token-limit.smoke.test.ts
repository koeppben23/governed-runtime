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
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { buildReviewerAgentContent } from './install-helpers.js';
import { PLUGIN_WRAPPER, REVIEWER_AGENT } from '../templates/index.js';

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
  outputTokenMax?: number,
  modelOutputLimit = 393_216,
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
                limit: { context: 1_000_000, output: modelOutputLimit },
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
  const childEnv: NodeJS.ProcessEnv = {
    ...createIsolatedOpenCodeEnvironment(root, host),
    OPENCODE_SERVER_PASSWORD: password,
    FORCE_COLOR: '0',
  };
  if (outputTokenMax !== undefined) {
    childEnv.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX = String(outputTokenMax);
  } else {
    delete childEnv.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX;
  }
  const proc = spawn(
    host.command,
    [...host.argsPrefix, 'serve', '--hostname=127.0.0.1', `--port=${port}`, '--print-logs'],
    {
      cwd: projectDir,
      env: childEnv,
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

function maxTokensOf(body: Record<string, unknown>): unknown {
  return body['max_tokens'] ?? body['max_output_tokens'];
}

async function writeFlowGuardProject(
  projectDir: string,
  options: { readonly cap: number; readonly invalidConfig?: boolean },
): Promise<void> {
  const opencodeDir = join(projectDir, '.opencode');
  await mkdir(join(opencodeDir, 'plugins'), { recursive: true });
  await mkdir(join(opencodeDir, 'agents'), { recursive: true });
  await writeFile(join(opencodeDir, 'plugins', 'flowguard-audit.ts'), PLUGIN_WRAPPER, 'utf8');
  await writeFile(
    join(opencodeDir, 'agents', 'flowguard-reviewer.md'),
    buildReviewerAgentContent(REVIEWER_AGENT, 'opencode'),
    'utf8',
  );
  await writeFile(
    join(opencodeDir, 'flowguard.json'),
    options.invalidConfig
      ? '{"schemaVersion":"invalid"}\n'
      : `${JSON.stringify(
          { schemaVersion: 'v1', reviewer: { outputTokenMax: options.cap } },
          null,
          2,
        )}\n`,
    'utf8',
  );

  // The thin plugin wrapper imports the workspace package. A symlink keeps the
  // test on the repository's built plugin instead of a second patched copy.
  const packageDir = join(projectDir, 'node_modules', '@flowguard');
  await mkdir(packageDir, { recursive: true });
  await symlink(ROOT, join(packageDir, 'core'), 'dir');

  spawnSync('git', ['init', '-q'], { cwd: projectDir });
  spawnSync('git', ['add', '.opencode'], { cwd: projectDir });
  spawnSync(
    'git',
    [
      '-c',
      'user.name=FlowGuard Test',
      '-c',
      'user.email=flowguard-test@example.invalid',
      'commit',
      '-qm',
      'fixture',
    ],
    { cwd: projectDir },
  );
}

async function sendPrompt(
  baseUrl: string,
  directory: string,
  headers: Record<string, string>,
  agent: string,
  text: string,
): Promise<{ readonly ok: boolean; readonly body: string }> {
  const sessionRes = await fetch(`${baseUrl}/session?directory=${directory}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title: `${agent} cap probe` }),
  });
  const session = (await sessionRes.json()) as { id?: string };
  if (!session.id) throw new Error(`session creation failed: ${JSON.stringify(session)}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROMPT_TIMEOUT_MS);
  try {
    const messageRes = await fetch(
      `${baseUrl}/session/${session.id}/message?directory=${directory}`,
      {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          agent,
          parts: [{ type: 'text', text }],
          model: { providerID: 'flowguard-capture', modelID: 'probe' },
        }),
      },
    );
    return { ok: messageRes.ok, body: await messageRes.text() };
  } finally {
    clearTimeout(timer);
  }
}

async function probeConfiguredReviewerCap(options: {
  readonly cap: number;
  readonly modelOutputLimit?: number;
  readonly invalidConfig?: boolean;
}): Promise<{ readonly captured: Record<string, unknown>[]; readonly reviewerResponse: string }> {
  const baseline = JSON.parse(
    await readFile(join(ROOT, '.sdk-baselines', 'opencode', 'host-version.json'), 'utf8'),
  ) as { package: string; version: string };
  const host = resolvePinnedOpenCodeHost(baseline);
  if (!(await readFile(join(ROOT, 'dist', 'integration', 'index.js'), 'utf8').catch(() => ''))) {
    throw new Error(
      'dist/integration/index.js is missing; run npm run build before the live smoke',
    );
  }
  const root = await mkdtemp(join(tmpdir(), 'fg-open-code-reviewer-cap-'));
  activeRoot = root;
  const projectDir = join(root, 'project');
  await mkdir(projectDir, { recursive: true });
  await writeFlowGuardProject(projectDir, options);

  const captured: Record<string, unknown>[] = [];
  const capture = createCaptureServer(captured);
  activeCapture = capture;
  await new Promise<void>((resolve, reject) => {
    capture.once('error', reject);
    capture.listen(0, '127.0.0.1', resolve);
  });
  const address = capture.address();
  if (!address || typeof address === 'string') throw new Error('capture port unavailable');

  activeServe = await startServe(
    projectDir,
    address.port,
    host,
    root,
    undefined,
    options.modelOutputLimit,
  );
  const directory = encodeURIComponent(projectDir);
  const auth = `Basic ${Buffer.from(`opencode:${activeServe.password}`).toString('base64')}`;
  const headers = { Authorization: auth, 'Content-Type': 'application/json' };

  const parent = await sendPrompt(
    activeServe.baseUrl,
    directory,
    headers,
    'build',
    'Reply with OK.',
  );
  if (!parent.ok) throw new Error(`parent prompt failed: ${parent.body}`);

  const marker = 'FLOWGUARD_LARGE_CONTEXT_MARKER';
  const reviewer = await sendPrompt(
    activeServe.baseUrl,
    directory,
    headers,
    'flowguard-reviewer',
    `${marker}\n${'context '.repeat(4_000)}`,
  );
  return { captured, reviewerResponse: reviewer.body };
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

  it(
    'HAPPY: a fresh FlowGuard install applies 65K to the reviewer without an env cap',
    async () => {
      const { captured, reviewerResponse } = await probeConfiguredReviewerCap({ cap: 65_536 });
      const serialized = captured.map((body) => JSON.stringify(body));
      const reviewerIndex = serialized.findIndex((body) =>
        body.includes('FLOWGUARD_LARGE_CONTEXT_MARKER'),
      );
      expect(reviewerIndex, `reviewer call failed: ${reviewerResponse}`).toBeGreaterThanOrEqual(0);
      const reviewerBody = captured[reviewerIndex]!;
      expect(maxTokensOf(reviewerBody), JSON.stringify(reviewerBody)).toBe(65_536);

      const parentBody = captured
        .slice(0, reviewerIndex)
        .reverse()
        .find((body) => JSON.stringify(body).includes('Reply with OK.'));
      expect(parentBody).toBeDefined();
      expect(maxTokensOf(parentBody!), JSON.stringify(parentBody)).toBe(32_000);
    },
    EXEC_TIMEOUT_MS,
  );

  it(
    'BAD: a model limit below the configured cap never reaches the provider',
    async () => {
      const { captured, reviewerResponse } = await probeConfiguredReviewerCap({
        cap: 65_536,
        modelOutputLimit: 32_768,
      });
      expect(captured).toHaveLength(1);
      expect(JSON.stringify(captured[0])).toContain('Reply with OK.');
      expect(reviewerResponse).not.toContain('FLOWGUARD_LARGE_CONTEXT_MARKER');
    },
    EXEC_TIMEOUT_MS,
  );

  it(
    'BAD: a malformed FlowGuard config never reaches the provider',
    async () => {
      const { captured, reviewerResponse } = await probeConfiguredReviewerCap({
        cap: 65_536,
        invalidConfig: true,
      });
      expect(captured).toHaveLength(1);
      expect(JSON.stringify(captured[0])).toContain('Reply with OK.');
      expect(reviewerResponse).not.toContain('FLOWGUARD_LARGE_CONTEXT_MARKER');
    },
    EXEC_TIMEOUT_MS,
  );
});
