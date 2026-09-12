/**
 * @module cli/opencode-host-boundary-live.test
 * @description Gated real-host E2E for the OpenCode host boundary (F-08).
 *
 * Proves against a real, pinned OpenCode binary that:
 * 1. the FlowGuard plugin loads from `.opencode/plugins/`,
 * 2. `tool.execute.before` throwing prevents the tool from executing
 *    (marker file must not exist), and
 * 3. the enforcement error is surfaced back to the model dispatch.
 *
 * Gated: runs only with `OPENCODE_LIVE=1` and a built `dist/`. Not part of the
 * default test run because it downloads the pinned host and dispatches a real
 * (captured) model request.
 *
 * @test-policy HAPPY, BAD — gated host-contract integration.
 * @version v1
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const EXEC_TIMEOUT_MS = 300_000;
const ROOT = join(fileURLToPath(new URL('../..', import.meta.url)));
const DIST_ENTRY = join(ROOT, 'dist', 'integration', 'index.js');
const LIVE = process.env.OPENCODE_LIVE === '1';
const CAN_RUN = LIVE && existsSync(DIST_ENTRY);

let tmpRoot: string;
let hostPackage: string;
let hostVersion: string;

afterAll(async () => {
  if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
});

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * OpenAI-compatible capture: the first completion asks for the `probe` tool;
 * every later completion ends the loop. All request bodies are captured so the
 * test can assert the enforcement error reached the model.
 */
function createCaptureServer(captured: Record<string, unknown>[]): ReturnType<typeof createServer> {
  let toolCallDispatched = false;
  return createServer(async (request, response) => {
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
    if (request.method === 'POST' && request.url?.endsWith('/chat/completions')) {
      const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
      captured.push(body);
      const streaming = body['stream'] === true;
      if (!toolCallDispatched) {
        toolCallDispatched = true;
        writeToolCallCompletion(response, streaming, 'probe');
      } else {
        writeTextCompletion(response, streaming, 'done');
      }
      return;
    }
    response.writeHead(404);
    response.end();
  });
}

function writeToolCallCompletion(
  response: ServerResponse,
  streaming: boolean,
  toolName: string,
): void {
  const toolCall = {
    id: 'call_probe_1',
    type: 'function',
    function: { name: toolName, arguments: '{}' },
  };
  if (!streaming) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        id: 'chatcmpl-probe',
        object: 'chat.completion',
        created: 1,
        model: 'probe',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: null, tool_calls: [toolCall] },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
    return;
  }
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
      { index: 0, delta: { role: 'assistant', tool_calls: [toolCall] }, finish_reason: null },
    ],
  });
  chunk({
    id: 'chatcmpl-probe',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'probe',
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
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
}

function writeTextCompletion(response: ServerResponse, streaming: boolean, content: string): void {
  if (!streaming) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        id: 'chatcmpl-final',
        object: 'chat.completion',
        created: 1,
        model: 'probe',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
    return;
  }
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const chunk = (payload: unknown) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
  chunk({
    id: 'chatcmpl-final',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'probe',
    choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
  });
  chunk({
    id: 'chatcmpl-final',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'probe',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  });
  chunk({
    id: 'chatcmpl-final',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'probe',
    choices: [],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
  response.end('data: [DONE]\n\n');
}

function runOpenCode(port: number, markerPath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      'npm',
      [
        'exec',
        '--yes',
        `--package=${hostPackage}@${hostVersion}`,
        '--',
        'opencode',
        'run',
        '--model',
        'flowguard-capture/probe',
        'Call the probe tool once, then finish.',
      ],
      {
        cwd: tmpRoot,
        env: {
          ...process.env,
          HOME: tmpRoot,
          USERPROFILE: tmpRoot,
          XDG_CONFIG_HOME: join(tmpRoot, '.config'),
          XDG_DATA_HOME: join(tmpRoot, '.local', 'share'),
          OPENCODE_DISABLE_AUTOUPDATE: '1',
          FG_E2E_MARKER: markerPath,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let combined = '';
    child.stdout.on('data', (chunk) => (combined += chunk.toString()));
    child.stderr.on('data', (chunk) => (combined += chunk.toString()));
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`OpenCode host-boundary probe timed out. Output:\n${combined}`));
    }, EXEC_TIMEOUT_MS);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      // The model capture ends the loop; a non-zero exit still yields useful
      // combined output for diagnosis.
      void code;
      resolve(combined);
    });
  });
}

describe.skipIf(!CAN_RUN)('OpenCode host boundary (live, pinned host)', () => {
  beforeAll(async () => {
    const hostBaseline = JSON.parse(
      await readFile(join(ROOT, '.sdk-baselines', 'opencode', 'host-version.json'), 'utf8'),
    ) as { package: string; version: string };
    hostPackage = hostBaseline.package;
    hostVersion = hostBaseline.version;

    tmpRoot = await mkdtemp(join(tmpdir(), 'fg-opencode-boundary-'));
    await mkdir(join(tmpRoot, '.opencode', 'plugins'), { recursive: true });
    await mkdir(join(tmpRoot, '.opencode', 'tools'), { recursive: true });

    await writeFile(
      join(tmpRoot, '.opencode', 'plugins', 'flowguard-e2e.ts'),
      `export { FlowGuardAuditPlugin } from ${JSON.stringify(DIST_ENTRY)};\n`,
      'utf8',
    );

    await writeFile(
      join(tmpRoot, '.opencode', 'tools', 'probe.ts'),
      [
        "import { writeFileSync } from 'node:fs';",
        'export default {',
        "  description: 'E2E probe that writes a marker file when it actually executes.',",
        '  args: {},',
        '  async execute() {',
        "    writeFileSync(process.env.FG_E2E_MARKER ?? '.probe-executed', 'executed');",
        "    return 'probe executed';",
        '  },',
        '};',
        '',
      ].join('\n'),
      'utf8',
    );

    await writeFile(
      join(tmpRoot, 'opencode.json'),
      JSON.stringify(
        {
          $schema: 'https://opencode.ai/config.json',
          model: 'flowguard-capture/probe',
          provider: {
            'flowguard-capture': {
              npm: '@ai-sdk/openai-compatible',
              name: 'FlowGuard Capture',
              options: { baseURL: 'http://127.0.0.1:0/v1', apiKey: 'test-only' },
              models: { probe: { name: 'Probe', limit: { context: 32_000, output: 1_024 } } },
            },
          },
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );
  });

  it(
    'blocks a custom host tool before execution and surfaces the enforcement error',
    async () => {
      const markerPath = join(tmpRoot, 'probe-executed.marker');
      const captured: Record<string, unknown>[] = [];

      const server = createCaptureServer(captured);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Unable to allocate port');
      const port = address.port;

      try {
        // Point the provider at the allocated capture port.
        const config = JSON.parse(await readFile(join(tmpRoot, 'opencode.json'), 'utf8')) as {
          provider: Record<string, { options: { baseURL: string } }>;
        };
        config.provider['flowguard-capture']!.options.baseURL = `http://127.0.0.1:${port}/v1`;
        await writeFile(join(tmpRoot, 'opencode.json'), JSON.stringify(config, null, 2) + '\n');

        const output = await runOpenCode(port, markerPath);

        // The real FlowGuard plugin must have blocked the probe before execution.
        expect(existsSync(markerPath), `probe tool executed despite the block.\n${output}`).toBe(
          false,
        );

        const dispatch = JSON.stringify(captured);
        expect(dispatch).toMatch(
          /PLUGIN_ENFORCEMENT_UNAVAILABLE|HOST_TOOL_UNKNOWN_DENIED|SESSION_DIR_NOT_FOUND/,
        );
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    EXEC_TIMEOUT_MS + 30_000,
  );
});
