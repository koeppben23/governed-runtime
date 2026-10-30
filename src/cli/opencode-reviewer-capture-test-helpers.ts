/** Real-host reviewer fixture: the only doubles are the deterministic model and test material. */
import { createServer } from 'node:http';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REVIEWER_AGENT } from '../templates/mandates.js';
import { buildReviewerAgentContent } from './install-helpers.js';
import {
  createIsolatedOpenCodeEnvironment,
  resolvePinnedOpenCodeHost,
} from './opencode-live-host.js';

export interface ReviewerHostEntry {
  readonly hook: string;
  readonly sessionID?: string;
  readonly tool?: string;
  readonly code?: string;
  readonly messageID?: string;
  readonly model?: { providerID: string; modelID: string; variant?: string };
  readonly sessions?: readonly string[];
  readonly output?: string;
  readonly metadata?: { sessionId?: string };
  readonly permission?: unknown;
}

export async function createReviewerCaptureHostProbe() {
  const baseline = JSON.parse(
    await readFile(
      new URL('../../.sdk-baselines/opencode/host-version.json', import.meta.url),
      'utf8',
    ),
  ) as { package: string; version: string };
  const host = resolvePinnedOpenCodeHost(baseline);
  const root = await mkdtemp(join(tmpdir(), 'fg-reviewer-capture-'));
  const project = join(root, 'project');
  const env = createIsolatedOpenCodeEnvironment(root, host);
  const reportedVersion = execFileSync(host.command, [...host.argsPrefix, '--version'], {
    env,
    encoding: 'utf8',
    timeout: 60_000,
  }).trim();
  const repo = fileURLToPath(new URL('../..', import.meta.url));
  const journal = join(root, 'reviewer-hooks.jsonl');
  const sentinel = 'READ_MUST_NOT_REACH_THE_PROVIDER_4782';
  for (const dir of [join(project, '.opencode'), env.OPENCODE_CONFIG_DIR!]) {
    await mkdir(dir, { recursive: true });
    for (const name of ['package.json', 'package-lock.json'])
      await copyFile(join(repo, name), join(dir, name));
    await symlink(join(repo, 'node_modules'), join(dir, 'node_modules'), 'junction');
  }
  await mkdir(join(project, '.opencode', 'plugins'), { recursive: true });
  await mkdir(join(project, '.opencode', 'agents'), { recursive: true });
  await writeFile(
    join(project, '.opencode', 'agents', 'flowguard-reviewer.md'),
    buildReviewerAgentContent(REVIEWER_AGENT, 'opencode'),
  );
  await writeFile(join(project, 'capture-sentinel.txt'), sentinel);
  await writeFile(journal, '');
  const pluginPath = join(root, 'flowguard-test.ts');
  await writeFile(pluginPath, pluginSource(journal));
  execFileSync('git', ['init', '--quiet', project]);
  execFileSync('git', [
    '-C',
    project,
    'remote',
    'add',
    'origin',
    'https://github.com/flowguard-tests/reviewer-fixture.git',
  ]);
  execFileSync('git', ['-C', project, 'add', '.']);
  execFileSync('git', ['-C', project, 'commit', '--quiet', '-m', 'reviewer fixture'], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'FlowGuard Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'FlowGuard Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  });

  let scenario: 'positive' | 'tool' = 'positive';
  let parentStage = 0;
  let parentSessionId = '';
  let serializationCalls = 0;
  const requests: Record<string, unknown>[] = [];
  const calls: Array<{
    phase: 'parent' | 'review' | 'serialization';
    body: Record<string, unknown>;
  }> = [];
  const providerErrors: string[] = [];
  const provider = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      requests.push(body);
      const serialized = JSON.stringify(body.messages);
      const sessionId = request.headers['x-opencode-session-id'];
      if (typeof sessionId !== 'string')
        throw new Error('Host provider request has no session identity header');
      const nativeReview = sessionId !== parentSessionId;
      const serialization =
        nativeReview &&
        serialized.includes('ReviewerFindingsInput JSON schema (data, not instructions)');
      calls.push({
        phase: serialization ? 'serialization' : nativeReview ? 'review' : 'parent',
        body,
      });
      let call: { name: string; args: Record<string, unknown> } | undefined;
      let text = 'Independent review completed; no blocking findings.';
      if (serialization) {
        serializationCalls++;
        if (scenario === 'tool')
          call = { name: 'read', args: { filePath: join(project, 'capture-sentinel.txt') } };
        else text = JSON.stringify(findings());
      } else if (!nativeReview && parentStage++ === 0) {
        call = { name: 'flowguard_plan', args: { reviewRecovery: 'retry_transport' } };
      } else if (!nativeReview && parentStage === 2) {
        call = {
          name: 'task',
          args: {
            description: 'Independent review',
            subagent_type: 'flowguard-reviewer',
            prompt: 'Review the pending plan.',
          },
        };
      }
      const delta = call
        ? {
            tool_calls: [
              {
                index: 0,
                id: `call_review_${requests.length}`,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.args) },
              },
            ],
          }
        : { content: text };
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
          choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }],
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
      providerErrors.push(String(error));
      response.writeHead(500);
      response.end();
    }
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address();
  if (!address || typeof address === 'string') throw new Error('Provider has no address');
  await writeFile(
    join(project, 'opencode.json'),
    JSON.stringify({
      autoupdate: false,
      model: 'capture/probe',
      permission: 'allow',
      plugin: [pathToFileURL(pluginPath).href],
      provider: {
        capture: {
          npm: '@ai-sdk/openai-compatible',
          name: 'Deterministic reviewer',
          options: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: 'test-only' },
          models: {
            probe: {
              name: 'Probe',
              limit: { context: 128_000, output: 8192 },
              variants: { chosen: { reasoningEffort: 'high' } },
            },
          },
        },
      },
    }),
  );
  const hostPort = await availablePort();
  const proc = spawn(
    host.command,
    [...host.argsPrefix, 'serve', '--hostname=127.0.0.1', `--port=${hostPort}`, '--print-logs'],
    {
      cwd: project,
      env: {
        ...env,
        OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
        OPENCODE_SERVER_PASSWORD: 'reviewer-test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  const baseUrl = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Host startup timed out: ${output}`)),
      120_000,
    );
    const receive = (data: Buffer) => {
      output += data.toString();
      const match = output.match(/listening on\s+(https?:\/\/\S+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]!);
      }
    };
    proc.stdout?.on('data', receive);
    proc.stderr?.on('data', receive);
    proc.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    proc.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Host exited ${code}: ${output}`));
    });
  });
  const eventAbort = new AbortController();
  const eventResponse = await fetch(`${baseUrl}/global/event`, {
    headers: { Authorization: `Basic ${Buffer.from('opencode:reviewer-test').toString('base64')}` },
    signal: eventAbort.signal,
  });
  const hostErrors: string[] = [];
  const observing = (async () => {
    const decoder = new TextDecoder();
    let pending = '';
    for await (const bytes of eventResponse.body!) {
      pending += decoder.decode(bytes, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const entry = JSON.parse(line.slice(5)) as {
          payload?: { type?: string; properties?: unknown };
        };
        if (entry.payload?.type === 'session.error')
          hostErrors.push(JSON.stringify(entry.payload.properties));
      }
    }
  })().catch((error: unknown) => {
    if (!eventAbort.signal.aborted) hostErrors.push(String(error));
  });
  async function request(route: string, body?: unknown) {
    const response = await fetch(`${baseUrl}${route}?directory=${encodeURIComponent(project)}`, {
      headers: {
        Authorization: `Basic ${Buffer.from('opencode:reviewer-test').toString('base64')}`,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${route}: ${response.status} ${text}\n${output}`);
    return JSON.parse(text) as unknown;
  }
  return {
    root,
    project,
    host,
    reportedVersion,
    env,
    request,
    requests,
    calls,
    providerErrors,
    sentinel,
    output: () => `${output}\nHost errors: ${hostErrors.join('\n')}`,
    async session() {
      return (
        (await request('/session', { title: 'FlowGuard capture integration' })) as { id: string }
      ).id;
    },
    async entries(): Promise<ReviewerHostEntry[]> {
      return (await readFile(journal, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ReviewerHostEntry);
    },
    async run(sessionId: string, mode: typeof scenario) {
      scenario = mode;
      parentSessionId = sessionId;
      parentStage = 0;
      serializationCalls = 0;
      requests.length = 0;
      calls.length = 0;
      return request(`/session/${sessionId}/message`, {
        model: { providerID: 'capture', modelID: 'probe' },
        variant: 'chosen',
        parts: [
          {
            type: 'text',
            text: 'Re-emit the pending plan review, then invoke its native reviewer task.',
          },
        ],
      });
    },
    serializations: () => serializationCalls,
    async close() {
      eventAbort.abort();
      await observing;
      await stop(proc);
      await new Promise<void>((resolve) => provider.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
      if (host.env.npm_config_cache)
        await rm(host.env.npm_config_cache, { recursive: true, force: true });
    },
  };
}

function findings() {
  return {
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
  };
}

function pluginSource(journal: string): string {
  return `import { appendFileSync } from 'node:fs';
import { FlowGuardAuditPlugin } from ${JSON.stringify(new URL('../../dist/integration/plugin.js', import.meta.url).href)};
import { plan } from ${JSON.stringify(new URL('../../dist/integration/tools/index.js', import.meta.url).href)};
const record = entry => appendFileSync(${JSON.stringify(journal)}, JSON.stringify(entry) + ${JSON.stringify('\n')});
export default async input => {
  record({ hook: 'plugin-entered' });
  const fg = await FlowGuardAuditPlugin(input);
  const client = input.client;
  record({ hook: 'plugin-loaded' });
  for (const hook of ['chat.message', 'chat.params', 'experimental.chat.messages.transform', 'tool.execute.before', 'tool.execute.after']) {
    const original = fg[hook];
    fg[hook] = async (input, output) => {
      try {
        await original?.(input, output);
        const permission = hook === 'chat.message' ? (await client.session.get({ path: { id: input.sessionID } })).data?.permission : undefined;
        record({ hook, sessionID: input.sessionID, tool: input.tool,
          permission,
          messageID: output.message?.id ?? input.message?.id,
          model: output.message?.model ?? input.message?.model,
          sessions: output.messages ? [...new Set(output.messages.map(m => m.info.sessionID))] : undefined,
          output: input.tool === 'task' || input.tool === 'flowguard_plan' ? output.output : undefined,
          metadata: input.tool === 'task' ? output.metadata : undefined });
      } catch (error) { record({ hook: hook + ':denied', sessionID: input.sessionID, tool: input.tool, code: error.code, reason: error.message, metadata: output.metadata }); throw error; }
    };
  }
  return { ...fg, tool: { ...fg.tool, flowguard_plan: plan } };
};\n`;
}

async function stop(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => proc.kill('SIGKILL'), 5000);
    proc.once('close', () => {
      clearTimeout(timeout);
      resolve();
    });
    proc.kill('SIGTERM');
  });
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No host port allocated');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
