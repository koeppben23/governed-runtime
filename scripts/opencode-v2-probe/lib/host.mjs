import { createServer } from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenCode } from '@opencode/client';
import { startProvider } from './provider.mjs';

const HERE = fileURLToPath(new URL('..', import.meta.url));

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no free port');
  await new Promise((resolve) => server.close(() => resolve()));
  return address.port;
}

function basicAuth(password) {
  return `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
}

async function waitForServer(client, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await client.server.info();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`OpenCode server did not become ready: ${String(lastError)}`);
}

async function waitForFile(file, predicate, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const entries = (await readFile(file, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const result = predicate(entries);
      if (result) return entries;
    } catch {
      /* file may not exist yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for journal ${file}`);
}

function reviewerAgent() {
  return `---
description: Phase 0 probe reviewer
mode: subagent
permissions:
  - action: "*"
    resource: "*"
    effect: deny
  - action: read
    resource: "*"
    effect: allow
---

You are a probe reviewer. Answer with the requested deterministic text. Do not call tools.
`;
}

function config({
  provider,
  instructions,
  mcpServer,
  mcpCodemode,
  providerPackage = '@opencode/ai/providers/openai-compatible',
  providerBaseURL,
  providerSettings,
  modelId = 'probe',
  staticProvider = true,
  denyAllPermissions = false,
  permissions,
  policies,
  providerBody,
}) {
  return {
    $schema: 'https://opencode.ai/config.json',
    update: 'disable',
    model: `probe/${modelId}`,
    permissions: permissions ?? [
      { action: '*', resource: '*', effect: denyAllPermissions ? 'deny' : 'allow' },
    ],
    ...(instructions ? { instructions: [instructions] } : {}),
    ...(policies ? { policies } : {}),
    ...(mcpServer
      ? {
          mcp: {
            servers: {
              mcprobe: {
                type: 'local',
                command: [process.execPath, mcpServer],
                codemode: mcpCodemode === true,
              },
            },
          },
        }
      : {}),
    ...(staticProvider
      ? {
          providers: {
            probe: {
              name: 'FlowGuard Probe',
              package: providerPackage,
              settings: {
                baseURL: providerBaseURL ?? provider.baseURL,
                apiKey: 'probe-only',
                ...(providerSettings ?? {}),
              },
              ...(providerBody ? { body: providerBody } : {}),
              models: {
                [modelId]: {
                  name: 'Probe',
                  limit: { context: 128_000, output: 8_192 },
                  capabilities: { tools: true },
                  variants: [
                    {
                      id: 'chosen',
                      settings: { reasoningEffort: 'high' },
                    },
                  ],
                },
              },
            },
          },
        }
      : {}),
  };
}

/**
 * Installed-artifact host fixture. Every mutable path lives under a fresh
 * temporary root; the operator's HOME, config, DB and sessions are never used.
 */
export async function startProbeHost(options = {}) {
  const name = options.name ?? 'probe';
  // macOS exposes /var/folders through the /private symlink. Resolve the root
  // before deriving the project and data paths so one probe host cannot create
  // two location identities for the same directory.
  const root = await realpath(await mkdtemp(join(tmpdir(), `fg-oc-v2-probe-${name}-`)));
  const project = join(root, 'project');
  const configDir = join(root, 'config');
  const dataDir = join(root, 'data');
  const stateDir = join(root, 'state');
  const cacheDir = join(root, 'cache');
  const journal = join(root, 'journal.jsonl');
  const password = `probe-${Math.random().toString(36).slice(2)}`;
  const provider = await startProvider(options.script);
  const port = await availablePort();

  for (const dir of [
    project,
    configDir,
    dataDir,
    stateDir,
    cacheDir,
    join(project, '.opencode', 'plugins'),
    join(project, '.opencode', 'agents'),
    join(project, '.opencode', 'tools'),
    join(configDir, 'opencode'),
    join(dataDir, 'opencode'),
  ]) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(journal, '', 'utf8');
  const hostPolicyPath = options.hostPolicy ? join(root, 'host-policy.json') : undefined;
  if (hostPolicyPath) {
    await writeFile(hostPolicyPath, JSON.stringify(options.hostPolicy, null, 2) + '\n', 'utf8');
  }
  await writeFile(
    join(project, '.opencode', 'package.json'),
    JSON.stringify({ type: 'module' }, null, 2) + '\n',
  );
  await rm(join(project, '.opencode', 'node_modules'), { recursive: true, force: true });
  await symlink(join(HERE, 'node_modules'), join(project, '.opencode', 'node_modules'), 'dir');
  await cp(
    join(HERE, 'plugin', 'flowguard-probe.js'),
    join(project, '.opencode', 'plugins', 'flowguard-probe.js'),
  );
  await writeFile(
    join(project, '.opencode', 'agents', 'probe-reviewer.md'),
    reviewerAgent(),
    'utf8',
  );
  if (options.limitedAgent) {
    await writeFile(
      join(project, '.opencode', 'agents', 'probe-limited.md'),
      `---
description: Step-limited probe agent
mode: primary
steps: 2
---
You are a step-limited probe agent. Call the direct probe tool until tools are removed.
`,
      'utf8',
    );
  }
  if (options.legacyTool) {
    await writeFile(
      join(project, '.opencode', 'tools', 'legacy-probe.ts'),
      `export const legacy_named = {
  description: 'Legacy named probe tool',
  args: {},
  execute: async () => ({ output: 'legacy-named-ok' }),
};
export default {
  description: 'Legacy default probe tool',
  args: {},
  execute: async () => ({ output: 'legacy-default-ok' }),
};
`,
      'utf8',
    );
  }
  if (options.commands) {
    await mkdir(join(project, '.opencode', 'commands'), { recursive: true });
    for (const [name, content] of Object.entries(options.commands)) {
      await writeFile(join(project, '.opencode', 'commands', `${name}.md`), content, 'utf8');
    }
  }
  await writeFile(
    join(project, 'opencode.json'),
    JSON.stringify(
      config({
        provider,
        instructions: options.instructions ? './probe-mandates.md' : undefined,
        mcpServer: options.mcpServer,
        mcpCodemode: options.mcpCodemode,
        providerPackage: options.providerPackage,
        providerBaseURL: options.providerBaseURL,
        providerSettings: options.providerSettings,
        modelId: options.modelId,
        staticProvider: options.staticProvider !== false,
        denyAllPermissions: options.denyAllPermissions === true,
        permissions: options.permissions,
        policies: options.policies,
        providerBody: options.providerBody,
      }),
      null,
      2,
    ) + '\n',
    'utf8',
  );
  if (options.instructions) {
    await writeFile(join(project, 'probe-mandates.md'), options.instructions, 'utf8');
  }
  execFileSync('git', ['init', '--quiet', project]);
  execFileSync('git', ['-C', project, 'add', '.']);
  execFileSync(
    'git',
    [
      '-C',
      project,
      '-c',
      'user.name=Probe',
      '-c',
      'user.email=probe@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'probe',
    ],
    { stdio: 'ignore' },
  );

  const env = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    XDG_CONFIG_HOME: configDir,
    XDG_DATA_HOME: dataDir,
    XDG_STATE_HOME: stateDir,
    XDG_CACHE_HOME: cacheDir,
    OPENCODE_CONFIG_DIR: join(configDir, 'opencode'),
    OPENCODE_DB: join(dataDir, 'opencode', 'probe.db'),
    OPENCODE_PASSWORD: password,
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    FG_PROBE_JOURNAL: journal,
    FG_PROBE_DENY_TOOLS: (options.denyTools ?? []).join(','),
    FG_PROBE_DENY_PROMPT: options.denyPrompt ? '1' : '0',
    FG_PROBE_FAIL_SETUP: options.failSetup ? '1' : '0',
    FG_PROBE_DENY_HOSTED_TOOLS: options.denyHostedTools ? '1' : '0',
    FG_PROBE_FAIL_RELOAD_BEFORE_SEND: options.failReloadBeforeSend ? '1' : '0',
    FG_PROBE_REGISTER_PROVIDER: options.registerProvider ? '1' : '0',
    FG_PROBE_PROVIDER_URL: provider.baseURL,
    ...(options.disableDefaultPlugins ? { OPENCODE_DISABLE_DEFAULT_PLUGINS: '1' } : {}),
    ...(hostPolicyPath ? { OPENCODE_HOST_POLICY: hostPolicyPath } : {}),
    ...(options.mcpMarker ? { FG_MCP_MARKER: options.mcpMarker } : {}),
  };
  const binary = process.env.OPENCODE_CLI ?? 'opencode';
  const proc = spawn(binary, ['serve', '--hostname=127.0.0.1', `--port=${port}`, '--print-logs'], {
    cwd: project,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  proc.stdout?.on('data', (chunk) => (output += chunk.toString()));
  proc.stderr?.on('data', (chunk) => (output += chunk.toString()));
  const baseUrl = `http://127.0.0.1:${port}`;
  const client = OpenCode.make({
    baseUrl,
    headers: { Authorization: basicAuth(password) },
  });
  const serverInfo = await waitForServer(client);
  let activated = false;

  async function activate() {
    if (activated) return;
    // v2 activation is location-scoped and can be lazy. A location read plus
    // one disposable session is the smallest host action that activates all
    // project plugins without touching any operator session.
    await client.location.get();
    await client.session.create({
      title: 'probe activation',
      location: { directory: project },
    });
    await waitForFile(journal, (entries) => entries.some((entry) => entry.type === 'setup:ready'));
    if (options.mcpServer) {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const status = await client.mcp.list().catch(() => undefined);
        if (status?.data?.some((server) => server.status?.status === 'connected')) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    activated = true;
  }

  async function close({ keep = false } = {}) {
    if (proc.exitCode === null) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => proc.kill('SIGKILL'), 5_000);
        proc.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
        proc.kill('SIGTERM');
      });
    }
    await provider.close();
    if (!keep) await rm(root, { recursive: true, force: true });
  }

  return {
    name,
    root,
    project,
    journal,
    port,
    baseUrl,
    password,
    env,
    proc,
    client,
    serverInfo,
    provider,
    output: () => output,
    activate,
    async entries() {
      const text = await readFile(journal, 'utf8');
      return text
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
    waitForJournal: (predicate, timeoutMs) => waitForFile(journal, predicate, timeoutMs),
    async session(title = 'probe session') {
      return client.session.create({
        title,
        location: { directory: project },
      });
    },
    async prompt(sessionID, text, extra = {}) {
      return client.session.prompt({
        sessionID,
        text,
        ...extra,
      });
    },
    close,
  };
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function findMessage(context, predicate) {
  return context.find((message) => predicate(message));
}

export function assistantMessages(context) {
  return context.filter((message) => message.type === 'assistant');
}

export function userMessages(context) {
  return context.filter((message) => message.type === 'user');
}

export function idleMessages(context) {
  return context.filter((message) => message.type === 'idle');
}
