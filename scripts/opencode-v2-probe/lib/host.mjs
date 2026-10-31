import { createServer } from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenCode } from '@opencode/client';
import { startProvider } from './provider.mjs';
import {
  assertCleanDiscovery,
  assertProbePaths,
  pinHost,
  probeEnvironment,
  ProbeError,
  readJournal,
  stopProbeProcess,
} from './isolation.mjs';

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

async function waitForServer(client, proc, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (!proc.pid) throw new ProbeError('PROBE_SPAWN_FAILED', 'Private server did not spawn');
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new ProbeError('PROBE_SERVER_EXITED', 'Private server exited during startup');
    }
    try {
      return await client.server.info({ signal: AbortSignal.timeout(2_000) });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new ProbeError(
    'PROBE_SERVER_TIMEOUT',
    `OpenCode server did not become ready: ${String(lastError)}`,
  );
}

async function waitForFile(file, predicate, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    {
      const entries = await readJournal(file);
      const result = predicate(entries);
      if (result) return entries;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new ProbeError('PROBE_JOURNAL_TIMEOUT', `Timed out waiting for journal ${file}`);
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
  modelId = 'probe',
  staticProvider = true,
  denyAllPermissions = false,
  policies,
  providerBody,
}) {
  return {
    $schema: 'https://opencode.ai/config.json',
    update: 'disable',
    model: `probe/${modelId}`,
    permissions: [{ action: '*', resource: '*', effect: denyAllPermissions ? 'deny' : 'allow' }],
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
                baseURL: provider.baseURL,
                apiKey: 'probe-only',
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
 * Installed-artifact host fixture. Host state paths use a fresh temporary root;
 * this is not OS containment of tool side effects or dependency symlink writes.
 */
export async function startProbeHost(options = {}) {
  const name = options.name ?? 'probe';
  const plugin = options.plugin ?? 'diagnostic';
  if (!['diagnostic', 'absent', 'passive'].includes(plugin)) {
    throw new ProbeError('PROBE_PLUGIN_MODE_INVALID', `Invalid plugin mode: ${plugin}`);
  }
  const requestedBase = join(tmpdir(), 'opencode');
  await mkdir(requestedBase, { recursive: true });
  const base = await realpath(requestedBase);
  // Check aliases too before using one canonical spelling for every host call.
  await assertCleanDiscovery(requestedBase);
  const discovery = await assertCleanDiscovery(base);
  const root = await mkdtemp(join(base, 'fg-oc-v2-probe-'));
  let provider;
  let proc;
  let closed = false;
  async function close({ keep = false } = {}) {
    if (closed) return;
    await stopProbeProcess(proc);
    if (provider) await provider.close();
    if (!keep) await rm(root, { recursive: true, force: true });
    closed = true;
  }
  try {
    const project = join(root, 'project');
    const configDir = join(root, 'config');
    const dataDir = join(root, 'data');
    const stateDir = join(root, 'state');
    const cacheDir = join(root, 'cache');
    const journal = join(root, 'journal.jsonl');
    const password = randomBytes(24).toString('hex');
    provider = await startProvider(options.script);
    const port = await availablePort();

    for (const dir of [
      project,
      configDir,
      dataDir,
      stateDir,
      cacheDir,
      join(root, 'tmp'),
      join(project, '.opencode', 'plugins'),
      join(project, '.opencode', 'agents'),
      join(project, '.opencode', 'tools'),
      join(configDir, 'opencode'),
      join(dataDir, 'opencode'),
    ]) {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(journal, '', 'utf8');
    await writeFile(
      join(project, '.opencode', 'package.json'),
      JSON.stringify({ type: 'module' }, null, 2) + '\n',
    );
    await rm(join(project, '.opencode', 'node_modules'), { recursive: true, force: true });
    await symlink(join(HERE, 'node_modules'), join(project, '.opencode', 'node_modules'), 'dir');
    if (plugin !== 'absent')
      await cp(
        join(HERE, 'plugin', plugin === 'passive' ? 'passive.js' : 'flowguard-probe.js'),
        join(project, '.opencode', 'plugins', 'flowguard-probe.js'),
      );
    if (plugin === 'diagnostic')
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
          modelId: options.modelId,
          staticProvider: options.staticProvider !== false,
          denyAllPermissions: options.denyAllPermissions === true,
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
    const cleanEnv = probeEnvironment(root);
    const gitOptions = { cwd: project, env: cleanEnv, stdio: 'ignore' };
    execFileSync('git', ['-c', 'init.templateDir=', 'init', '--quiet', project], gitOptions);
    execFileSync('git', ['-C', project, 'add', '.'], gitOptions);
    execFileSync(
      'git',
      [
        '-C',
        project,
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=Probe',
        '-c',
        'user.email=probe@example.invalid',
        'commit',
        '--quiet',
        '-m',
        'probe',
      ],
      gitOptions,
    );

    const env = {
      ...cleanEnv,
      OPENCODE_DB: join(dataDir, 'opencode', 'probe.db'),
      OPENCODE_PASSWORD: password,
      FG_PROBE_JOURNAL: journal,
      FG_PROBE_DENY_TOOLS: (options.denyTools ?? []).join(','),
      FG_PROBE_DENY_PROMPT: options.denyPrompt ? '1' : '0',
      FG_PROBE_FAIL_SETUP: options.failSetup ? '1' : '0',
      FG_PROBE_DENY_HOSTED_TOOLS: options.denyHostedTools ? '1' : '0',
      FG_PROBE_REGISTER_PROVIDER: options.registerProvider ? '1' : '0',
      FG_PROBE_PROVIDER_URL: provider.baseURL,
      ...(options.disableDefaultPlugins ? { OPENCODE_DISABLE_DEFAULT_PLUGINS: '1' } : {}),
      ...(options.mcpMarker ? { FG_MCP_MARKER: options.mcpMarker } : {}),
    };
    const binary = process.env.OPENCODE_CLI ?? 'opencode';
    const artifact = await pinHost(binary, project, env);
    const pathsOutput = execFileSync(artifact.path, ['debug', 'paths'], {
      cwd: project,
      env,
      encoding: 'utf8',
      timeout: 30_000,
    });
    const hostPaths = Object.fromEntries(
      pathsOutput
        .trim()
        .split('\n')
        .map((line) => {
          const match = /^(\w+)\s+(.+)$/.exec(line);
          if (!match) throw new ProbeError('PROBE_PATHS_INVALID', 'Unparseable debug paths');
          return [match[1], match[2].trim()];
        }),
    );
    assertProbePaths(hostPaths, root);
    await writeFile(
      join(configDir, 'opencode', 'opencode.json'),
      JSON.stringify({ update: 'disable' }) + '\n',
    );
    proc = spawn(
      artifact.path,
      ['serve', '--hostname=127.0.0.1', `--port=${port}`, '--print-logs'],
      {
        cwd: project,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let spawnError;
    proc.on('error', (error) => {
      spawnError = error;
    });
    let output = '';
    proc.stdout?.on('data', (chunk) => (output += chunk.toString()));
    proc.stderr?.on('data', (chunk) => (output += chunk.toString()));
    const baseUrl = `http://127.0.0.1:${port}`;
    const client = OpenCode.make({
      baseUrl,
      headers: { Authorization: basicAuth(password) },
    });
    const serverInfo = await waitForServer(client, proc);
    if (spawnError) throw new ProbeError('PROBE_SPAWN_FAILED', String(spawnError));
    if (serverInfo.version !== '2.2.4') {
      throw new ProbeError('PROBE_SERVER_VERSION_MISMATCH', JSON.stringify(serverInfo));
    }
    let activated = false;

    async function activate() {
      if (activated) return;
      // Probe loading, NOT trusted FlowGuard activation. A location read plus
      // one disposable session is the smallest host action that activates all
      // project plugins without touching any operator session.
      await client.location.get({ location: { directory: project } });
      await client.session.create({
        title: 'probe activation',
        location: { directory: project },
      });
      if (plugin !== 'absent')
        await waitForFile(journal, (entries) =>
          entries.some((entry) => entry.type === 'setup:ready'),
        );
      if (options.mcpServer) {
        const deadline = Date.now() + 30_000;
        let connected = false;
        while (Date.now() < deadline) {
          const status = await client.mcp.list({ location: { directory: project } });
          if (status?.data?.some((server) => server.status?.status === 'connected')) {
            connected = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (!connected) throw new ProbeError('PROBE_MCP_NOT_CONNECTED', 'MCP connection timed out');
      }
      activated = true;
    }

    return {
      artifact,
      hostPaths,
      discovery,
      plugin,
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
        return readJournal(journal);
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
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Probe failed and cleanup also failed');
    }
    throw error;
  }
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
