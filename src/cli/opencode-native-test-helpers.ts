/** Private native host + deterministic wire provider. Not installed-product or governance proof. */
import { createServer } from 'node:http';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { OpenCode, type SessionInfo, type SessionInboxUser } from '@opencode/client';
import {
  createIsolatedOpenCodeEnvironment,
  resolvePinnedOpenCodeHost,
  type PinnedOpenCodeHost,
} from './opencode-live-host-test-helpers.js';

export interface NativeProbeReply {
  text?: string;
  tool?: { name: string; arguments: Record<string, unknown> };
  /** Explicit interruption control; leaves the provider request unanswered. */
  hold?: boolean;
}
export interface NativeHostProbe {
  root: string;
  project: string;
  env: NodeJS.ProcessEnv;
  host: PinnedOpenCodeHost;
  reportedVersion: string;
  client: ReturnType<typeof OpenCode.make>;
  location: { directory: string };
  requests: Array<{ body: Record<string, unknown>; sessionID: string }>;
  errors: string[];
  close(): Promise<void>;
  output(): string;
  session(agent?: string): Promise<SessionInfo>;
  prompt(sessionID: string, text?: string): Promise<SessionInboxUser>;
  entries<T = unknown>(): Promise<T[]>;
}
export async function createNativeHostProbe(
  options: {
    agent?: string;
    product?: boolean;
    plugin?: string;
    modelOutput?: number;
    body?: Record<string, unknown>;
    flowguardConfig?: string;
    prepare?: (project: string, env: NodeJS.ProcessEnv) => Promise<void>;
    script?: (body: Record<string, unknown>, sessionID: string, index: number) => NativeProbeReply;
  } = {},
): Promise<NativeHostProbe> {
  const host = resolvePinnedOpenCodeHost();
  const root = await mkdtemp(join(tmpdir(), 'fg-native-host-'));
  const project = join(root, 'project');
  const env = createIsolatedOpenCodeEnvironment(root, host);
  const requests: Array<{ body: Record<string, unknown>; sessionID: string }> = [];
  const errors: string[] = [];
  let processHandle: ChildProcess | undefined;
  let output = '';
  const provider = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      const sessionID = request.headers['x-opencode-session-id'];
      if (typeof sessionID !== 'string') throw new Error('Missing native session header');
      requests.push({ body, sessionID });
      const reply = options.script?.(body, sessionID, requests.length) ?? { text: 'OK' };
      if (reply.hold) return;
      const delta = reply.tool
        ? {
            tool_calls: [
              {
                index: 0,
                id: `call_${requests.length}`,
                type: 'function',
                function: {
                  name: reply.tool.name,
                  arguments: JSON.stringify(reply.tool.arguments),
                },
              },
            ],
          }
        : { content: reply.text ?? 'OK' };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const base = {
        id: `chatcmpl-${requests.length}`,
        object: 'chat.completion.chunk',
        created: 1,
        model: 'probe',
      };
      for (const value of [
        {
          ...base,
          choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }],
        },
        {
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: reply.tool ? 'tool_calls' : 'stop' }],
        },
        {
          ...base,
          choices: [],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      ])
        response.write(`data: ${JSON.stringify(value)}\n\n`);
      response.end('data: [DONE]\n\n');
    } catch (error) {
      errors.push(String(error));
      response.writeHead(500);
      response.end();
    }
  });
  const close = async () => {
    if (processHandle && processHandle.exitCode === null && processHandle.signalCode === null) {
      const child = processHandle;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
        child.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill('SIGTERM');
      });
    }
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
    if (host.env.npm_config_cache)
      await rm(host.env.npm_config_cache, { recursive: true, force: true });
  };
  try {
    await mkdir(project, { recursive: true });
    execFileSync('git', ['init', '--quiet', project]);
    const reportedVersion = execFileSync(host.command, [...host.argsPrefix, '--version'], {
      env,
      encoding: 'utf8',
      timeout: 60_000,
    }).trim();
    if (reportedVersion !== host.version)
      throw new Error(`Expected ${host.version}, received ${reportedVersion}`);
    if (options.agent) {
      await mkdir(join(project, '.opencode/agents'), { recursive: true });
      await writeFile(join(project, '.opencode/agents/flowguard-reviewer.md'), options.agent);
    }
    if (options.product) {
      const plugin = join(project, '.opencode/plugins/flowguard/index.ts');
      await mkdir(dirname(plugin), { recursive: true });
      await writeFile(
        plugin,
        `export { default } from ${JSON.stringify(new URL('../../dist/integration/plugin.js', import.meta.url).href)};\n`,
      );
    }
    if (options.plugin) {
      const plugin = join(project, '.opencode/plugins/00-observer/index.ts');
      await mkdir(dirname(plugin), { recursive: true });
      await writeFile(plugin, `import { Plugin } from '@opencode/plugin';\n${options.plugin}`);
    }
    if (options.flowguardConfig) {
      await mkdir(join(project, '.opencode'), { recursive: true });
      await writeFile(join(project, '.opencode/flowguard.json'), options.flowguardConfig);
    }
    await new Promise<void>((resolve, reject) => {
      provider.once('error', reject);
      provider.listen(0, '127.0.0.1', resolve);
    });
    const address = provider.address();
    if (!address || typeof address === 'string') throw new Error('No provider address');
    await writeFile(
      join(project, 'opencode.json'),
      JSON.stringify({
        model: 'capture/probe',
        permissions: [{ action: '*', resource: '*', effect: 'allow' }],
        providers: {
          capture: {
            package: '@opencode/ai/providers/openai-compatible',
            settings: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: 'test-only' },
            ...(options.body ? { body: options.body } : {}),
            models: {
              probe: {
                name: 'Probe',
                capabilities: { tools: true },
                limit: { context: 128_000, output: options.modelOutput ?? 8_192 },
                variants: [{ id: 'chosen', settings: { reasoningEffort: 'high' } }],
              },
            },
          },
        },
      }),
    );
    await writeFile(join(project, 'observer.jsonl'), '');
    await options.prepare?.(project, env);
    processHandle = spawn(
      host.command,
      [...host.argsPrefix, 'serve', '--hostname=127.0.0.1', '--port=0'],
      {
        cwd: project,
        env: { ...env, OPENCODE_PASSWORD: 'native-test' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const child = processHandle;
    const baseUrl = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Host startup timed out: ${output}`)),
        60_000,
      );
      const receive = (chunk: Buffer) => {
        output += chunk.toString();
        const match = output.match(/listening on\s+(https?:\/\/\S+)/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]!);
        }
      };
      child.stdout?.on('data', receive);
      child.stderr?.on('data', receive);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Host exited ${code}: ${output}`));
      });
    });
    const client = OpenCode.make({
      baseUrl,
      headers: { Authorization: `Basic ${Buffer.from('opencode:native-test').toString('base64')}` },
    });
    const location = { directory: project };
    await client.agent.list({ location }, { signal: AbortSignal.timeout(60_000) });
    const plugins = await client.plugin.list({ location });
    if (
      plugins.data.some((plugin) => plugin.state.status !== 'active') ||
      (options.product && !plugins.data.some((plugin) => plugin.id === 'flowguard')) ||
      (options.plugin &&
        !plugins.data.some(
          (plugin) => plugin.source.type === 'local' && plugin.source.path.endsWith('00-observer'),
        ))
    ) {
      throw new Error(`Native fixture plugin load failed: ${JSON.stringify(plugins)}\n${output}`);
    }
    return {
      root,
      project,
      env,
      host,
      reportedVersion,
      client,
      location,
      requests,
      errors,
      close,
      output: () => output,
      async session(agent = 'build') {
        return client.session.create({
          title: 'Native host probe',
          location,
          agent,
          model: { providerID: 'capture', id: 'probe', variant: 'chosen' },
        });
      },
      async prompt(sessionID: string, text = 'Execute the probe.') {
        const admission = await client.session.prompt({ sessionID, text });
        await client.session.wait({ sessionID }, { signal: AbortSignal.timeout(60_000) });
        return admission;
      },
      async entries<T = unknown>(): Promise<T[]> {
        return (await readFile(join(project, 'observer.jsonl'), 'utf8'))
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as T);
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
