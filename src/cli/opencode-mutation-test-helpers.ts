import { createServer, type Server } from 'node:http';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createIsolatedOpenCodeEnvironment,
  resolvePinnedOpenCodeHost,
} from './opencode-live-host.js';

export interface ProbeCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

export interface ProbeEntry {
  readonly hook: string;
  readonly input?: { tool: string; callID: string; sessionID: string };
  readonly event?: {
    type: string;
    properties: { part?: ProbePart };
  };
}

export interface ProbePart {
  readonly type: string;
  readonly callID: string;
  readonly tool: string;
  readonly sessionID: string;
  readonly state: {
    status: string;
    metadata?: Record<string, unknown>;
    time?: { start: number; end?: number };
    error?: string;
  };
}

export async function createMutationHostProbe(flowGuard = false) {
  const baseline = JSON.parse(
    await readFile(
      new URL('../../.sdk-baselines/opencode/host-version.json', import.meta.url),
      'utf8',
    ),
  ) as { package: string; version: string };
  const host = resolvePinnedOpenCodeHost(baseline);
  const root = await mkdtemp(join(tmpdir(), 'fg-mutation-live-'));
  const project = join(root, 'project');
  await mkdir(join(project, '.opencode', 'plugins'), { recursive: true });
  if (flowGuard) execFileSync('git', ['init', '--quiet', project]);
  const journal = join(root, 'hooks.jsonl');
  const plugin = join(project, '.opencode', 'plugins', 'mutation-probe.ts');
  const dropEvents = join(root, 'drop-events');
  const flowGuardModule = new URL('../../dist/integration/plugin.js', import.meta.url).href;
  const toolsModule = new URL('../../dist/integration/tools/index.js', import.meta.url).href;
  await writeFile(
    plugin,
    `import { appendFileSync, existsSync } from 'node:fs';
${
  flowGuard
    ? `import { FlowGuardAuditPlugin } from ${JSON.stringify(flowGuardModule)};
import { implement, status } from ${JSON.stringify(toolsModule)};`
    : ''
}
const record = (entry) => appendFileSync(${JSON.stringify(journal)}, JSON.stringify(entry) + '\\n');
export default async (input) => {
  const fg = ${flowGuard ? 'await FlowGuardAuditPlugin(input)' : '{}'};
  return {
  ...fg,
  tool: { probe_wait: { description: 'Wait for host cancellation', args: {},
    execute: async () => new Promise(() => {}) },
    ${flowGuard ? 'flowguard_implement: implement, flowguard_status: status,' : ''} },
  'tool.execute.before': async (input, output) => {
    await fg['tool.execute.before']?.(input, output);
    record({ hook: 'before', input });
  },
  'tool.execute.after': async (input, output) => {
    await fg['tool.execute.after']?.(input, output);
    record({ hook: 'after', input });
  },
  event: async ({ event }) => {
    if (event.type === 'message.part.updated') record({ hook: 'event', event });
    if (!existsSync(${JSON.stringify(dropEvents)})) await fg.event?.({ event });
  },
}; };\n`,
  );
  let pending: ProbeCall[] = [];
  let callNumber = 0;
  const capture = createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* drain */
    }
    const call = pending.shift();
    const delta = call
      ? {
          tool_calls: [
            {
              index: 0,
              id: `call_probe_${++callNumber}`,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            },
          ],
        }
      : { content: 'Probe finished.' };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);
    const base = {
      id: 'chatcmpl-probe',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'probe',
    };
    chunk({ ...base, choices: [{ index: 0, delta, finish_reason: null }] });
    chunk({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }],
    });
    chunk({
      ...base,
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    response.end('data: [DONE]\n\n');
  });
  const capturePort = await listen(capture);
  await writeFile(
    join(project, 'opencode.json'),
    JSON.stringify({
      model: 'capture/probe',
      permission: 'allow',
      provider: {
        capture: {
          npm: '@ai-sdk/openai-compatible',
          name: 'Capture',
          options: { baseURL: `http://127.0.0.1:${capturePort}/v1`, apiKey: 'test-only' },
          models: { probe: { name: 'Probe', limit: { context: 128_000, output: 65_536 } } },
        },
      },
    }),
  );
  if (flowGuard) {
    await writeFile(join(project, 'edit-target.txt'), 'original\n');
    execFileSync('git', ['add', '.'], { cwd: project });
    execFileSync('git', ['commit', '--quiet', '-m', 'test fixture'], {
      cwd: project,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'FlowGuard Test',
        GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'FlowGuard Test',
        GIT_COMMITTER_EMAIL: 'test@example.invalid',
      },
    });
  }
  const env = createIsolatedOpenCodeEnvironment(root, host);
  const proc = spawn(
    host.command,
    [...host.argsPrefix, 'serve', '--hostname=127.0.0.1', '--port=0'],
    {
      cwd: project,
      env: { ...env, OPENCODE_SERVER_PASSWORD: 'mutation-probe' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  const baseUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Host startup timed out: ${output}`)), 120_000);
    const receive = (data: Buffer) => {
      output += data.toString();
      const match = output.match(/listening on\s+(https?:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]!);
      }
    };
    proc.stdout?.on('data', receive);
    proc.stderr?.on('data', receive);
    proc.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Host exited ${code}: ${output}`));
    });
  });
  const headers = {
    Authorization: `Basic ${Buffer.from('opencode:mutation-probe').toString('base64')}`,
    'Content-Type': 'application/json',
  };
  async function request(route: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`${baseUrl}${route}?directory=${encodeURIComponent(project)}`, {
      headers,
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${route}: ${response.status} ${text}\n${output}`);
    return text ? JSON.parse(text) : undefined;
  }
  return {
    root,
    project,
    host,
    env,
    request,
    dropEvents,
    async session(): Promise<string> {
      return ((await request('/session', { title: 'mutation lifecycle probe' })) as { id: string })
        .id;
    },
    prompt(sessionId: string, calls: ProbeCall[]): Promise<unknown> {
      pending = [...calls];
      return request(`/session/${sessionId}/message`, {
        parts: [{ type: 'text', text: 'Execute the requested probe.' }],
        model: { providerID: 'capture', modelID: 'probe' },
      });
    },
    async entries(): Promise<ProbeEntry[]> {
      return (await readFile(journal, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as ProbeEntry);
    },
    async close() {
      await stop(proc);
      await new Promise<void>((resolve) => capture.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
      const npmCache = host.env.npm_config_cache;
      if (npmCache) await rm(npmCache, { recursive: true, force: true });
    },
  };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No capture address');
  return address.port;
}

async function stop(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => proc.kill('SIGKILL'), 5000);
    proc.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    proc.kill('SIGTERM');
  });
}
