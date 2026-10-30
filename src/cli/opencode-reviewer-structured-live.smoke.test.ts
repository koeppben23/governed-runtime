/**
 * @module cli/opencode-reviewer-structured-live.smoke.test
 * @description Real-host E2E for the model-neutral reviewer wire contract.
 *
 * Proves against the pinned OpenCode binary with a deterministic local capture
 * provider (no credentials, no cost) that:
 * 1. the pinned host version exactly matches the validated baseline,
 * 2. `flowguard-reviewer` resolves as an installed subagent,
 * 3. a reviewer CHILD session can be created with `parentID`,
 * 4. a normal `session.prompt` with an explicit `messageID` and no `format`
 *    reaches the provider without StructuredOutput or required tool choice,
 * 5. the response is correlated to that request and carries the selected
 *    provider/model, and the unformatted history remains readable.
 *
 * Model/variant acceptance and force-tool rejection are provider-profile
 * properties, not claims of this deterministic capture host.
 *
 * Gating: runs in CI (deterministic capture provider) and locally with
 * `OPENCODE_LIVE=1`. Uses the pinned `opencode-ai` baseline via `npm exec`
 * unless `OPENCODE_CLI` names an explicit binary.
 *
 * @test-policy HAPPY, BAD — gated host-contract integration.
 * @version v2
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { REVIEWER_AGENT } from '../templates/mandates.js';
import { buildReviewerAgentContent } from './install-helpers.js';
import { ReviewerFindingsInput } from '../state/evidence-review-input.js';
import { TESTED_OPENCODE_HOST_VERSION } from './opencode-runtime-compat.js';
import {
  createIsolatedOpenCodeEnvironment,
  resolvePinnedOpenCodeHost,
  type PinnedOpenCodeHost,
} from './opencode-live-host.js';

const ROOT = join(fileURLToPath(new URL('../..', import.meta.url)));
/**
 * Enabled by the job that actually installs the pinned host
 * (FLOWGUARD_OPENCODE_HOST_E2E=1 in the CI smoke job) or locally with
 * OPENCODE_LIVE=1. Never inferred from a generic CI flag.
 */
const CAN_RUN =
  process.env.OPENCODE_LIVE === '1' || process.env.FLOWGUARD_OPENCODE_HOST_E2E === '1';
const EXEC_TIMEOUT_MS = 300_000;
const PROMPT_TIMEOUT_MS = 120_000;

const FINDINGS = {
  iteration: 0,
  planVersion: 1,
  reviewMode: 'subagent',
  overallVerdict: 'accept',
  blockingIssues: [],
  majorRisks: [],
  missingVerification: [],
  scopeCreep: [],
  unknowns: [],
  challenges: [],
  attestation: { toolObligationId: '11111111-1111-4111-8111-111111111111' },
} as const;

const FINDINGS_JSON = JSON.stringify(FINDINGS);
const REQUEST_MESSAGE_ID = 'msg_flowguard_smoke_request';

let tmpRoot: string;
let host: PinnedOpenCodeHost;

interface ServeHandle {
  proc: ChildProcess;
  baseUrl: string;
  password: string;
  output: () => string;
}

/** Every provider request observed by the deterministic capture server. */
const capturedRequests: Array<Record<string, unknown>> = [];

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
    // Normal agent turn: plain JSON text, never a StructuredOutput tool call.
    const textBody = JSON.stringify({
      id: 'chatcmpl-probe',
      object: 'chat.completion',
      created: 1,
      model: 'probe',
      choices: [
        { index: 0, message: { role: 'assistant', content: FINDINGS_JSON }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    if (body.stream === true) {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const chunk = (payload: unknown) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
      chunk({
        id: 'chatcmpl-probe',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'probe',
        choices: [
          { index: 0, delta: { role: 'assistant', content: FINDINGS_JSON }, finish_reason: null },
        ],
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
      response.end('data: [DONE]\n\n');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(textBody);
  });
}

async function startServe(cwd: string, capturePort: number): Promise<ServeHandle> {
  await writeFile(
    join(cwd, 'opencode.json'),
    JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        model: 'flowguard-capture/probe',
        provider: {
          'flowguard-capture': {
            npm: '@ai-sdk/openai-compatible',
            name: 'FlowGuard Capture',
            options: { baseURL: `http://127.0.0.1:${capturePort}/v1`, apiKey: 'test-only' },
            models: { probe: { name: 'Probe', limit: { context: 32_000, output: 4_096 } } },
          },
        },
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  const port = 18080 + Math.floor(Math.random() * 1500);
  const password = `structured-${Math.random().toString(36).slice(2)}`;
  const proc = spawn(
    host.command,
    [...host.argsPrefix, 'serve', '--hostname=127.0.0.1', `--port=${port}`, '--print-logs'],
    {
      cwd,
      env: {
        ...createIsolatedOpenCodeEnvironment(tmpRoot, host),
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

describe.skipIf(!CAN_RUN)('OpenCode structured reviewer wire contract (live, pinned host)', () => {
  let capture: ReturnType<typeof createServer> | undefined;
  let serve: ServeHandle | undefined;
  let capturePort = 0;

  beforeAll(async () => {
    const baseline = JSON.parse(
      await readFile(join(ROOT, '.sdk-baselines', 'opencode', 'host-version.json'), 'utf8'),
    ) as { package: string; version: string };
    host = resolvePinnedOpenCodeHost(baseline);

    tmpRoot = await mkdtemp(join(tmpdir(), 'fg-opencode-structured-'));
    const projectDir = join(tmpRoot, 'project');
    await mkdir(join(projectDir, '.opencode', 'agents'), { recursive: true });
    await writeFile(
      join(projectDir, '.opencode', 'agents', 'flowguard-reviewer.md'),
      buildReviewerAgentContent(REVIEWER_AGENT, 'opencode'),
      'utf8',
    );

    capture = createCaptureServer(capturedRequests);
    await new Promise<void>((resolve, reject) => {
      capture!.once('error', reject);
      capture!.listen(0, '127.0.0.1', resolve);
    });
    const address = capture.address();
    if (!address || typeof address === 'string') throw new Error('Unable to allocate capture port');
    capturePort = address.port;

    serve = await startServe(projectDir, capturePort);
  }, 120_000);

  afterAll(async () => {
    await stopServe(serve);
    await new Promise<void>((resolve) => {
      if (!capture) return resolve();
      capture.close(() => resolve());
    });
    if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
  });

  it(
    'preserves request identity and model selection without forcing structured tool output',
    async () => {
      const versionProbe = spawnSync(host.command, [...host.argsPrefix, '--version'], {
        encoding: 'utf8',
        timeout: 60_000,
        env: createIsolatedOpenCodeEnvironment(tmpRoot, host),
      });
      const reported = (versionProbe.stdout ?? '').trim();
      expect(reported, `pinned host version mismatch (${versionProbe.stderr ?? ''})`).toBe(
        TESTED_OPENCODE_HOST_VERSION,
      );
      expect(host.version).toBe(TESTED_OPENCODE_HOST_VERSION);

      const dir = encodeURIComponent(join(tmpRoot, 'project'));
      const auth = `Basic ${Buffer.from(`opencode:${serve!.password}`).toString('base64')}`;
      const headers = { Authorization: auth, 'Content-Type': 'application/json' };

      const agentsRes = await fetch(`${serve!.baseUrl}/agent?directory=${dir}`, { headers });
      const agents = (await agentsRes.json()) as Array<{ name?: string }>;
      expect(agents.some((agent) => agent.name === 'flowguard-reviewer')).toBe(true);
      const agentMarkdown = await readFile(
        join(tmpRoot, 'project', '.opencode', 'agents', 'flowguard-reviewer.md'),
        'utf8',
      );
      expect(agentMarkdown).not.toMatch(/^reasoningEffort:/m);

      const parentRes = await fetch(`${serve!.baseUrl}/session?directory=${dir}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ title: 'FlowGuard Model-Neutral Review Parent' }),
      });
      const parent = (await parentRes.json()) as { id: string };
      expect(parent.id).toBeTruthy();

      const childRes = await fetch(`${serve!.baseUrl}/session?directory=${dir}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ parentID: parent.id, title: 'flowguard-reviewer child' }),
      });
      const child = (await childRes.json()) as { id: string; parentID?: string };
      expect(child.id).toBeTruthy();
      expect(child.parentID).toBe(parent.id);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PROMPT_TIMEOUT_MS);
      let message: Record<string, unknown>;
      try {
        const messageRes = await fetch(
          `${serve!.baseUrl}/session/${child.id}/message?directory=${dir}`,
          {
            method: 'POST',
            headers,
            signal: controller.signal,
            body: JSON.stringify({
              agent: 'flowguard-reviewer',
              messageID: REQUEST_MESSAGE_ID,
              parts: [{ type: 'text', text: 'Serialize the review as one JSON object.' }],
              model: { providerID: 'flowguard-capture', modelID: 'probe' },
            }),
          },
        );
        const messageText = await messageRes.text();
        expect(messageRes.ok, `message failed: ${messageRes.status} ${messageText}`).toBe(true);
        message = JSON.parse(messageText) as Record<string, unknown>;
      } finally {
        clearTimeout(timer);
      }

      const info = message.info as Record<string, unknown> | undefined;
      expect(info, `missing info in ${JSON.stringify(message)}`).toBeTruthy();
      expect(info!.sessionID).toBe(child.id);
      expect(info!.parentID).toBe(REQUEST_MESSAGE_ID);
      expect(info!.providerID).toBe('flowguard-capture');
      expect(info!.modelID).toBe('probe');
      expect(info!.error).toBeUndefined();
      expect(info!.finish).toBe('stop');

      const textParts = (message.parts as Array<{ type?: string; text?: string }>).filter(
        (part) => part.type === 'text',
      );
      expect(textParts.map((part) => part.text).join('')).toBe(FINDINGS_JSON);
      const parsed = ReviewerFindingsInput.safeParse(JSON.parse(textParts[0]!.text!));
      expect(parsed.success, JSON.stringify(parsed.success ? {} : parsed.error.issues)).toBe(true);

      // The provider request is a normal agent turn. No StructuredOutput tool
      // and no forced tool choice means models are not required to implement
      // that additional capability.
      expect(capturedRequests).toHaveLength(1);
      const providerRequest = capturedRequests[0]!;
      const toolNames = Array.isArray(providerRequest.tools)
        ? (providerRequest.tools as Array<{ function?: { name?: string } }>).map(
            (tool) => tool.function?.name ?? '',
          )
        : [];
      expect(toolNames.some((name) => /structured/i.test(name))).toBe(false);
      expect(providerRequest.tool_choice).not.toBe('required');
      expect(providerRequest.model).toBe('probe');

      // Unformatted prompts remain listable; no OpenCode formatted-message
      // encoding defect is triggered by this transport.
      const historyRes = await fetch(
        `${serve!.baseUrl}/session/${child.id}/message?directory=${dir}`,
        {
          headers,
        },
      );
      const historyText = await historyRes.text();
      expect(historyRes.ok, `history failed: ${historyRes.status} ${historyText}`).toBe(true);
      const history = JSON.parse(historyText) as Array<{ info?: { id?: string } }>;
      const ids = history.map((entry) => entry.info?.id);
      expect(ids).toContain(REQUEST_MESSAGE_ID);
      expect(ids).toContain(info!.id);
    },
    EXEC_TIMEOUT_MS,
  );
});
