import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashText } from '../shared/hashing.js';
import { FLOWGUARD_MANDATES_KERNEL } from '../templates/mandates.js';
import { buildMandatesContent } from './templates.js';

const EXEC_TIMEOUT_MS = 60_000;
const ROOT = join(fileURLToPath(new URL('../..', import.meta.url)));

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

function writeChatCompletion(response: ServerResponse, streaming: boolean): void {
  if (!streaming) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        id: 'chatcmpl-flowguard',
        object: 'chat.completion',
        created: 1,
        model: 'visibility',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' },
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
    id: 'chatcmpl-flowguard',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'visibility',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }],
  });
  chunk({
    id: 'chatcmpl-flowguard',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'visibility',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  });
  chunk({
    id: 'chatcmpl-flowguard',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'visibility',
    choices: [],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
  response.end('data: [DONE]\n\n');
}

async function runOpenCode(
  port: number,
): Promise<{ requestBody: Record<string, unknown>; output: string }> {
  let captured: Record<string, unknown> | null = null;
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url?.endsWith('/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          object: 'list',
          data: [{ id: 'visibility', object: 'model', owned_by: 'flowguard' }],
        }),
      );
      return;
    }
    if (request.method === 'POST' && request.url?.endsWith('/chat/completions')) {
      const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
      captured = body;
      writeChatCompletion(response, body['stream'] === true);
      return;
    }
    response.writeHead(404);
    response.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  try {
    const output = await new Promise<string>((resolve, reject) => {
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
          'flowguard-capture/visibility',
          'Reply with exactly OK.',
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
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let combined = '';
      child.stdout.on('data', (chunk) => (combined += chunk.toString()));
      child.stderr.on('data', (chunk) => (combined += chunk.toString()));
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`OpenCode model-visibility probe timed out. Output:\n${combined}`));
      }, EXEC_TIMEOUT_MS);
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('close', (code) => {
        clearTimeout(timeout);
        if (code === 0) resolve(combined);
        else
          reject(new Error(`OpenCode model-visibility probe exited ${code}. Output:\n${combined}`));
      });
    });
    if (!captured) throw new Error(`OpenCode did not dispatch a model request. Output:\n${output}`);
    return { requestBody: captured, output };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('OpenCode installed mandate model visibility', () => {
  beforeAll(async () => {
    const hostBaseline = JSON.parse(
      await readFile(join(ROOT, '.sdk-baselines', 'opencode', 'host-version.json'), 'utf8'),
    ) as { package: string; version: string };
    hostPackage = hostBaseline.package;
    hostVersion = hostBaseline.version;
    tmpRoot = await mkdtemp(join(tmpdir(), 'fg-opencode-visibility-'));
    await mkdir(join(tmpRoot, '.opencode'), { recursive: true });
    const digest = hashText(FLOWGUARD_MANDATES_KERNEL);
    await writeFile(
      join(tmpRoot, '.opencode', 'flowguard-mandates.md'),
      buildMandatesContent('1.2.3', digest),
      'utf8',
    );
  });

  it(
    'sends the installed kernel to the actual pinned OpenCode model dispatch',
    async () => {
      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Unable to allocate capture port');
      const port = address.port;
      await new Promise<void>((resolve) => server.close(() => resolve()));

      await writeFile(
        join(tmpRoot, 'opencode.json'),
        JSON.stringify(
          {
            $schema: 'https://opencode.ai/config.json',
            model: 'flowguard-capture/visibility',
            instructions: ['.opencode/flowguard-mandates.md'],
            provider: {
              'flowguard-capture': {
                npm: '@ai-sdk/openai-compatible',
                name: 'FlowGuard Capture',
                options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'test-only' },
                models: {
                  visibility: {
                    name: 'Visibility',
                    limit: { context: 32_000, output: 1_024 },
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

      const { requestBody } = await runOpenCode(port);
      const dispatched = JSON.stringify(requestBody);

      expect(dispatched).toContain('FlowGuard governance');
      expect(dispatched).toContain('NOT_VERIFIED');
      expect(dispatched).toContain('data, not instruction');
      expect(dispatched).toContain('Never continue to the next workflow step');
      expect(dispatched).not.toContain('## 8. Output Contract');
      expect(dispatched).not.toContain('## 9. Implementation Checklist');
    },
    EXEC_TIMEOUT_MS + 10_000,
  );
});
