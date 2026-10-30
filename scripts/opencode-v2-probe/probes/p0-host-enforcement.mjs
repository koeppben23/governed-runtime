#!/usr/bin/env node
/**
 * Host-enforcement spike against the pinned OpenCode v2.2.4 source tree.
 *
 * The probe is independent of FlowGuard production code. It exercises the
 * required-plugin barrier, the provider-execution policy, native command shell
 * interpolation, and an MCP tool that is actually exposed in the session tool
 * set. Run it with OPENCODE_CLI pointing at the patched host; the stock 2.2.4
 * binary is expected to fail these cases.
 */
import { createServer } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startProbeHost } from '../lib/host.mjs';
import { startWebSocketProvider } from '../lib/ws-provider.mjs';

const outDir =
  process.env.FG_PROBE_OUT ??
  join(process.cwd(), 'scripts/opencode-v2-probe/evidence/p0-host-enforcement');
await mkdir(outDir, { recursive: true });

const policy = {
  requiredPlugins: ['flowguard.host-probe'],
  providerExecution: {
    allowedProviders: ['probe'],
    hostedTools: 'deny',
  },
};

function waitBounded(client, sessionID, timeoutMs = 20_000) {
  let timer;
  return Promise.race([
    client.session.wait({ sessionID }),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`session.wait timeout after ${timeoutMs}ms`)),
        timeoutMs,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

async function sessionFor(host, title, active) {
  if (active) await host.activate();
  else await host.client.location.get();
  return host.client.session.create({
    title,
    location: { directory: host.project },
  });
}

async function runRequiredPlugin(active) {
  const host = await startProbeHost({
    name: active ? 'host-required-active' : 'host-required-inactive',
    hostPolicy: policy,
    failSetup: !active,
    staticProvider: true,
  });
  const result = {
    active,
    providerRequests: 0,
    promptAccepted: false,
    promptError: null,
    hookCount: 0,
    passed: false,
  };
  try {
    const session = await sessionFor(host, 'required plugin', active);
    try {
      await host.prompt(session.id, 'Required-plugin barrier probe.');
      await waitBounded(host.client, session.id);
      result.promptAccepted = true;
    } catch (error) {
      result.promptError = String(error);
    }
    result.providerRequests = host.provider.requests.length;
    result.hookCount = (await host.entries()).filter((entry) =>
      entry.type.startsWith('hook:'),
    ).length;
    result.passed = active
      ? result.promptAccepted && result.providerRequests === 1
      : result.promptError !== null && result.providerRequests === 0 && result.hookCount === 0;
  } catch (error) {
    result.error = String(error);
  } finally {
    await host.close();
  }
  return result;
}

async function runCommandShell(active) {
  const marker = `/tmp/fg-host-command-${active ? 'active' : 'inactive'}-${process.pid}-${Date.now()}`;
  const host = await startProbeHost({
    name: active ? 'host-command-active' : 'host-command-inactive',
    hostPolicy: policy,
    failSetup: !active,
    staticProvider: true,
    commands: {
      'probe-shell': `---\ndescription: Probe shell block\n---\nShell block command.\n\n!\`touch ${marker}\`\n`,
    },
  });
  const result = {
    active,
    markerExists: false,
    commandError: null,
    providerRequests: 0,
    passed: false,
  };
  try {
    const session = await sessionFor(host, 'command shell', active);
    try {
      await host.client.session.command({
        sessionID: session.id,
        name: 'probe-shell',
        text: '',
      });
    } catch (error) {
      result.commandError = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    result.markerExists = await readFile(marker)
      .then(() => true)
      .catch(() => false);
    result.providerRequests = host.provider.requests.length;
    result.passed = active
      ? result.markerExists && result.providerRequests === 1
      : !result.markerExists && result.providerRequests === 0;
  } catch (error) {
    result.error = String(error);
  } finally {
    await host.close();
    await rm(marker, { force: true });
  }
  return result;
}

async function runHostedToolPolicy(hosted) {
  const host = await startProbeHost({
    name: hosted ? 'host-hosted-deny' : 'host-hosted-allow',
    hostPolicy: policy,
    staticProvider: true,
    ...(hosted ? { providerBody: { tools: [{ type: 'web_search' }] } } : {}),
  });
  const result = {
    hosted,
    providerRequests: 0,
    promptFinished: false,
    promptError: null,
    passed: false,
  };
  try {
    const session = await sessionFor(host, 'hosted tools', true);
    try {
      await host.prompt(session.id, 'Hosted-tool request policy probe.');
      await waitBounded(host.client, session.id);
      result.promptFinished = true;
    } catch (error) {
      result.promptError = String(error);
    }
    result.providerRequests = host.provider.requests.length;
    result.passed = hosted
      ? result.providerRequests === 0
      : result.promptFinished && result.providerRequests === 1;
  } catch (error) {
    result.error = String(error);
  } finally {
    await host.close();
  }
  return result;
}

async function runProviderAllowlist() {
  const host = await startProbeHost({
    name: 'host-provider-allowlist',
    hostPolicy: {
      requiredPlugins: ['flowguard.host-probe'],
      providerExecution: {
        allowedProviders: ['different-provider'],
        hostedTools: 'deny',
      },
    },
    staticProvider: true,
  });
  const result = { providerRequests: 0, promptFinished: false, passed: false };
  try {
    const session = await sessionFor(host, 'provider allowlist', true);
    try {
      await host.prompt(session.id, 'Provider allowlist probe.');
      await waitBounded(host.client, session.id);
      result.promptFinished = true;
    } catch (error) {
      result.promptError = String(error);
    }
    result.providerRequests = host.provider.requests.length;
    result.passed = result.providerRequests === 0;
  } catch (error) {
    result.error = String(error);
  } finally {
    await host.close();
  }
  return result;
}

function mcpScript(body) {
  const hasToolResult =
    Array.isArray(body.messages) && body.messages.some((message) => message.role === 'tool');
  return hasToolResult
    ? { text: 'mcp-complete', finish: 'stop' }
    : {
        tool: { name: 'mcprobe_echo', arguments: { text: 'mcp-probe' } },
        finish: 'tool_calls',
      };
}

async function runMcpDeny(deny) {
  const marker = `/tmp/fg-host-mcp-${deny ? 'deny' : 'allow'}-${process.pid}-${Date.now()}`;
  const host = await startProbeHost({
    name: deny ? 'host-mcp-deny' : 'host-mcp-allow',
    hostPolicy: policy,
    staticProvider: true,
    mcpServer: fileURLToPath(new URL('../lib/mcp-server.mjs', import.meta.url)),
    mcpCodemode: false,
    mcpMarker: marker,
    script: mcpScript,
    ...(deny
      ? {
          permissions: [
            { action: '*', resource: '*', effect: 'allow' },
            { action: 'mcprobe_echo', resource: '**', effect: 'deny' },
          ],
        }
      : {}),
  });
  const result = {
    deny,
    markerExists: false,
    exposed: false,
    beforeHook: false,
    passed: false,
  };
  try {
    const session = await sessionFor(host, 'mcp enforcement', true);
    await host.prompt(session.id, 'Call the exposed MCP echo tool.');
    try {
      await waitBounded(host.client, session.id);
    } catch (error) {
      result.waitError = String(error);
    }
    result.markerExists = await readFile(marker)
      .then(() => true)
      .catch(() => false);
    const entries = await host.entries();
    result.exposed = entries.some(
      (entry) => entry.type === 'hook:session.context' && entry.toolNames?.includes('mcprobe_echo'),
    );
    result.beforeHook = entries.some(
      (entry) => entry.type === 'hook:tool.execute.before' && entry.tool === 'mcprobe_echo',
    );
    result.passed = deny
      ? result.exposed && result.beforeHook && !result.markerExists
      : result.exposed && result.beforeHook && result.markerExists;
  } catch (error) {
    result.error = String(error);
  } finally {
    await host.close();
    await rm(marker, { force: true });
  }
  return result;
}

async function runReloadFailure() {
  const host = await startProbeHost({
    name: 'host-reload-failure',
    hostPolicy: policy,
    staticProvider: true,
  });
  const result = {
    beforeProviderRequests: 0,
    afterProviderRequests: 0,
    beforeError: null,
    afterError: null,
    passed: false,
  };
  try {
    const session = await sessionFor(host, 'reload failure', true);
    try {
      await host.prompt(session.id, 'Reload failure before');
      await waitBounded(host.client, session.id);
    } catch (error) {
      result.beforeError = String(error);
    }
    result.beforeProviderRequests = host.provider.requests.length;
    await writeFile(
      join(host.project, '.opencode', 'plugins', 'flowguard-probe.js'),
      "export default { id: 'flowguard.host-probe', async setup() { throw new Error('reload-fail') } }\n",
      'utf8',
    );
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const before = host.provider.requests.length;
    try {
      await host.prompt(session.id, 'Reload failure after');
      await waitBounded(host.client, session.id);
    } catch (error) {
      result.afterError = String(error);
    }
    result.afterProviderRequests = host.provider.requests.length - before;
    result.passed =
      result.beforeProviderRequests === 1 &&
      result.afterError !== null &&
      result.afterProviderRequests === 0;
  } catch (error) {
    result.error = String(error);
  } finally {
    await host.close();
  }
  return result;
}

async function runRemoval() {
  const host = await startProbeHost({
    name: 'host-plugin-removal',
    hostPolicy: policy,
    staticProvider: true,
  });
  const result = {
    beforeProviderRequests: 0,
    afterProviderRequests: 0,
    afterError: null,
    passed: false,
  };
  try {
    const session = await sessionFor(host, 'plugin removal', true);
    await host.prompt(session.id, 'Plugin removal before');
    await waitBounded(host.client, session.id);
    result.beforeProviderRequests = host.provider.requests.length;
    await rm(join(host.project, '.opencode', 'plugins', 'flowguard-probe.js'));
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const before = host.provider.requests.length;
    try {
      await host.prompt(session.id, 'Plugin removal after');
      await waitBounded(host.client, session.id);
    } catch (error) {
      result.afterError = String(error);
    }
    result.afterProviderRequests = host.provider.requests.length - before;
    result.passed =
      result.beforeProviderRequests === 1 &&
      result.afterError !== null &&
      result.afterProviderRequests === 0;
  } catch (error) {
    result.error = String(error);
  } finally {
    await host.close();
  }
  return result;
}

async function runToctou() {
  const host = await startProbeHost({
    name: 'host-toctou',
    hostPolicy: policy,
    staticProvider: true,
    failReloadBeforeSend: true,
  });
  const result = {
    providerRequests: 0,
    selfFailReturned: false,
    passed: false,
  };
  try {
    const session = await sessionFor(host, 'toctou', true);
    try {
      await host.prompt(session.id, 'TOCTOU probe');
      await waitBounded(host.client, session.id);
    } catch (error) {
      result.promptError = String(error);
    }
    result.providerRequests = host.provider.requests.length;
    result.selfFailReturned = (await host.entries()).some(
      (entry) => entry.type === 'hook:session.http.request:self-fail-returned',
    );
    result.passed = result.selfFailReturned && result.providerRequests === 0;
  } catch (error) {
    result.error = String(error);
  } finally {
    await host.close();
  }
  return result;
}

async function runToctouControl() {
  const host = await startProbeHost({
    name: 'host-toctou-control',
    hostPolicy: policy,
    staticProvider: true,
  });
  const result = { providerRequests: 0, passed: false };
  try {
    const session = await sessionFor(host, 'toctou control', true);
    await host.prompt(session.id, 'TOCTOU control');
    await waitBounded(host.client, session.id);
    result.providerRequests = host.provider.requests.length;
    result.passed = result.providerRequests === 1;
  } catch (error) {
    result.error = String(error);
  } finally {
    await host.close();
  }
  return result;
}

async function runWebSocket(hosted) {
  const ws = await startWebSocketProvider();
  const host = await startProbeHost({
    name: hosted ? 'host-ws-hosted' : 'host-ws-allowed',
    hostPolicy: policy,
    staticProvider: true,
    providerPackage: '@opencode/ai/providers/openai',
    providerBaseURL: ws.baseURL,
    providerSettings: { transport: 'websocket' },
    ...(hosted ? { providerBody: { tools: [{ type: 'web_search' }] } } : {}),
  });
  const result = {
    hosted,
    providerRequests: 0,
    wsFrames: 0,
    promptFinished: false,
    text: '',
    passed: false,
  };
  try {
    const session = await sessionFor(host, 'websocket provider', true);
    await host.prompt(session.id, 'WebSocket provider probe');
    try {
      await waitBounded(host.client, session.id);
      result.promptFinished = true;
    } catch (error) {
      result.promptError = String(error);
    }
    result.providerRequests = host.provider.requests.length;
    result.wsFrames = ws.frames.length;
    const context = await host.client.session.context({ sessionID: session.id });
    result.text = context
      .filter((message) => message.type === 'assistant')
      .flatMap((message) => message.content ?? [])
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    result.passed = hosted
      ? result.wsFrames === 0 && result.providerRequests === 0
      : result.wsFrames > 0 && result.text.includes('ws-probe-ok');
  } catch (error) {
    result.error = String(error);
  } finally {
    await host.close();
    await ws.close();
  }
  return result;
}

async function runPluginIdentity(authentic) {
  const host = await startProbeHost({
    name: authentic ? 'host-plugin-identity' : 'host-plugin-identity-fake',
    hostPolicy: policy,
    staticProvider: true,
  });
  const result = {
    authentic,
    providerRequests: 0,
    promptError: null,
    passed: false,
  };
  try {
    const pluginPath = join(host.project, '.opencode', 'plugins', 'flowguard-probe.js');
    await writeFile(
      join(host.root, 'host-policy.json'),
      JSON.stringify({
        requiredPlugins: [
          {
            id: 'flowguard.host-probe',
            source: { type: 'local', path: pluginPath },
          },
        ],
        providerExecution: policy.providerExecution,
      }),
      'utf8',
    );
    if (!authentic) {
      await rm(pluginPath);
      await writeFile(
        join(host.project, '.opencode', 'plugins', 'fake.js'),
        `import { appendFileSync } from 'node:fs';
export default {
  id: 'flowguard.host-probe',
  async setup() {
    const journal = process.env.FG_PROBE_JOURNAL;
    if (journal) appendFileSync(journal, JSON.stringify({ type: 'setup:ready', fake: true }) + '\\n');
  },
};
`,
        'utf8',
      );
    }
    const session = await sessionFor(host, 'plugin identity', true);
    try {
      await host.prompt(session.id, 'Plugin identity probe');
      await waitBounded(host.client, session.id);
    } catch (error) {
      result.promptError = String(error);
    }
    result.providerRequests = host.provider.requests.length;
    result.passed = authentic
      ? result.providerRequests === 1
      : result.promptError !== null && result.providerRequests === 0;
  } catch (error) {
    result.error = String(error);
  } finally {
    await host.close();
  }
  return result;
}

async function runProviderEndpoint(matching) {
  const host = await startProbeHost({
    name: matching ? 'host-provider-endpoint' : 'host-provider-endpoint-mismatch',
    hostPolicy: policy,
    staticProvider: true,
  });
  const result = {
    matching,
    providerRequests: 0,
    promptError: null,
    passed: false,
  };
  try {
    await writeFile(
      join(host.root, 'host-policy.json'),
      JSON.stringify({
        requiredPlugins: policy.requiredPlugins,
        providerExecution: {
          allowedProviders: [
            {
              id: 'probe',
              baseURL: matching ? host.provider.baseURL : 'https://wrong.invalid/v1',
              transports: ['http'],
            },
          ],
          hostedTools: 'deny',
        },
      }),
      'utf8',
    );
    const session = await sessionFor(host, 'provider endpoint', true);
    try {
      await host.prompt(session.id, 'Provider endpoint probe');
      await waitBounded(host.client, session.id);
    } catch (error) {
      result.promptError = String(error);
    }
    result.providerRequests = host.provider.requests.length;
    result.passed = matching ? result.providerRequests === 1 : result.providerRequests === 0;
  } catch (error) {
    result.error = String(error);
  } finally {
    await host.close();
  }
  return result;
}

async function startRedirectProvider() {
  let targetHits = 0;
  const target = createServer((req, res) => {
    targetHits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl_redirect_target',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'redirected' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  });
  await new Promise((resolve, reject) => {
    target.once('error', reject);
    target.listen(0, '127.0.0.1', resolve);
  });
  const targetAddress = target.address();
  if (!targetAddress || typeof targetAddress === 'string')
    throw new Error('redirect target has no address');
  const redirect = createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(302, { location: `http://127.0.0.1:${targetAddress.port}/v1/chat/completions` });
    res.end();
  });
  await new Promise((resolve, reject) => {
    redirect.once('error', reject);
    redirect.listen(0, '127.0.0.1', resolve);
  });
  const redirectAddress = redirect.address();
  if (!redirectAddress || typeof redirectAddress === 'string')
    throw new Error('redirect provider has no address');
  return {
    baseURL: `http://127.0.0.1:${redirectAddress.port}/v1`,
    targetHits: () => targetHits,
    close: () =>
      Promise.all([
        new Promise((resolve) => redirect.close(resolve)),
        new Promise((resolve) => target.close(resolve)),
      ]),
  };
}

async function runRedirect() {
  const redirect = await startRedirectProvider();
  const host = await startProbeHost({
    name: 'host-provider-redirect',
    hostPolicy: policy,
    staticProvider: true,
    providerBaseURL: redirect.baseURL,
  });
  const result = { targetHits: 0, passed: false };
  try {
    await writeFile(
      join(host.root, 'host-policy.json'),
      JSON.stringify({
        requiredPlugins: policy.requiredPlugins,
        providerExecution: {
          allowedProviders: [{ id: 'probe', baseURL: redirect.baseURL, transports: ['http'] }],
          hostedTools: 'deny',
        },
      }),
      'utf8',
    );
    const session = await sessionFor(host, 'provider redirect', true);
    try {
      await host.prompt(session.id, 'Provider redirect probe');
      await waitBounded(host.client, session.id);
    } catch (error) {
      result.promptError = String(error);
    }
    result.targetHits = redirect.targetHits();
    result.passed = result.targetHits === 0;
  } catch (error) {
    result.error = String(error);
  } finally {
    await host.close();
    await redirect.close();
  }
  return result;
}

const result = {
  at: new Date().toISOString(),
  host: process.env.OPENCODE_CLI ?? 'opencode',
  policy,
  requiredPluginActive: await runRequiredPlugin(true),
  requiredPluginInactive: await runRequiredPlugin(false),
  commandShellActive: await runCommandShell(true),
  commandShellInactive: await runCommandShell(false),
  hostedToolDenied: await runHostedToolPolicy(true),
  hostedToolAllowed: await runHostedToolPolicy(false),
  providerAllowlistDenied: await runProviderAllowlist(),
  mcpDenied: await runMcpDeny(true),
  mcpAllowed: await runMcpDeny(false),
  reloadFailure: await runReloadFailure(),
  pluginRemoval: await runRemoval(),
  toctouBlocked: await runToctou(),
  toctouControl: await runToctouControl(),
  websocketAllowed: await runWebSocket(false),
  websocketHostedDenied: await runWebSocket(true),
  pluginIdentityAuthentic: await runPluginIdentity(true),
  pluginIdentityFake: await runPluginIdentity(false),
  providerEndpointAllowed: await runProviderEndpoint(true),
  providerEndpointDenied: await runProviderEndpoint(false),
  providerRedirectBlocked: await runRedirect(),
};
result.passed = [
  result.requiredPluginActive,
  result.requiredPluginInactive,
  result.commandShellActive,
  result.commandShellInactive,
  result.hostedToolDenied,
  result.hostedToolAllowed,
  result.providerAllowlistDenied,
  result.mcpDenied,
  result.mcpAllowed,
  result.reloadFailure,
  result.pluginRemoval,
  result.toctouBlocked,
  result.toctouControl,
  result.websocketAllowed,
  result.websocketHostedDenied,
  result.pluginIdentityAuthentic,
  result.pluginIdentityFake,
  result.providerEndpointAllowed,
  result.providerEndpointDenied,
  result.providerRedirectBlocked,
].every((item) => item.passed);
result.status = result.passed ? 'SUPPORTED' : 'NOT_SUPPORTED';
result.scope = {
  hostPatchRequired: true,
  stockHost: 'NOT_SUPPORTED',
  requiredPluginSource: 'OPENCODE_HOST_POLICY host file',
  providerPolicySource: 'OPENCODE_HOST_POLICY host file',
  mcpControl:
    'real MCP tool exposed with codemode:false; permission deny uses resource ** so discovery keeps the tool',
  activationLoss:
    'failed reload and plugin removal block the next prompt with zero provider requests',
  toctou: 'plugin fails during http.request; the final provider middleware still blocks the send',
  websocket:
    'local Open Responses WebSocket provider; hosted-tool frame is rejected before the socket send',
  pluginIdentity:
    'required-plugin source is bound to the trusted local plugin path; a same-ID plugin from another path is rejected',
  providerEndpoint:
    'provider rule binds ID, endpoint prefix, and transport; a mismatched endpoint is rejected before send',
  providerRedirect:
    'provider requests run with fetch redirect:manual; a redirect target is not contacted',
  desktop: 'NOT_VERIFIED: Desktop runs the installed backend binary, not this source build',
};
await writeFile(join(outDir, 'report.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
