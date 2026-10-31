#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { startProbeHost } from '../lib/host.mjs';
import { lastUserText, toolParts } from '../lib/review-evidence.mjs';

const outDir =
  process.env.FG_PROBE_OUT ??
  join(process.cwd(), 'scripts/opencode-v2-probe/evidence/phase02/p0-prevention');
await mkdir(outDir, { recursive: true });
const runDir = join(outDir, new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(runDir);

function marker(name) {
  return resolve(outDir, `${name}-${process.pid}-${Date.now()}`);
}
async function exists(path) {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
async function run(host, session, prompt) {
  await host.prompt(session.id, prompt);
  await host.client.session.wait(
    { sessionID: session.id },
    { signal: AbortSignal.timeout(30_000) },
  );
}

async function mcpCase(allow) {
  const path = marker(`mcp-${allow ? 'allow' : 'deny'}`);
  const mcpServer = fileURLToPath(new URL('../lib/mcp-server.mjs', import.meta.url));
  let host;
  const result = { case: allow ? 'mcp-allowed-control' : 'mcp-deny', marker: path, passed: false };
  try {
    host = await startProbeHost({
      name: `mcp-${allow ? 'allow' : 'deny'}`,
      mcpServer,
      mcpCodemode: false,
      mcpMarker: path,
      denyTools: allow ? [] : ['mcprobe_echo'],
      script: (body) =>
        lastUserText(body).includes('Warm up the MCP catalog')
          ? { text: 'MCP_WARMUP_OK', finish: 'stop' }
          : body.messages?.some((message) => message.role === 'tool')
            ? { text: 'MCP_CALL_FINISHED', finish: 'stop' }
            : { tool: { name: 'mcprobe_echo', arguments: { text: 'mcp-probe' } } },
    });
    await host.activate();
    const session = await host.session('MCP surface');
    result.warmup = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await run(host, session, `Warm up the MCP catalog ${attempt + 1}`);
      const warmupEntries = await host.entries();
      const advertised = warmupEntries.some(
        (entry) =>
          entry.type === 'hook:session.context' && entry.toolNames?.includes('mcprobe_echo'),
      );
      result.warmup.push({ attempt: attempt + 1, advertised });
      if (advertised) break;
    }
    await run(host, session, 'Use the MCP echo tool.');
    const entries = await host.entries();
    const context = await host.client.session.context({ sessionID: session.id });
    result.advertised = entries.some(
      (entry) => entry.type === 'hook:session.context' && entry.toolNames?.includes('mcprobe_echo'),
    );
    result.beforeHook = entries.some(
      (entry) => entry.type === 'hook:tool.execute.before' && entry.tool === 'mcprobe_echo',
    );
    result.afterHook = entries.some(
      (entry) => entry.type === 'hook:tool.execute.after' && entry.tool === 'mcprobe_echo',
    );
    result.markerExists = await exists(path);
    const parts = toolParts(context);
    result.toolParts = parts.map((part) => ({
      name: part.name,
      status: part.state?.status,
      content: part.state?.content,
      error: part.state?.error,
    }));
    result.toolResultObserved = parts.some(
      (part) =>
        part.name === 'mcprobe_echo' &&
        part.state?.status === 'completed' &&
        JSON.stringify(part.state?.content ?? '').includes('mcp-probe'),
    );
    result.terminal = context.some(
      (message) =>
        message.type === 'assistant' &&
        message.finish === 'stop' &&
        JSON.stringify(message.content).includes('MCP_CALL_FINISHED'),
    );
    result.entryTypes = Object.fromEntries(
      [...new Set(entries.map((entry) => entry.type))].map((type) => [
        type,
        entries.filter((entry) => entry.type === type).length,
      ]),
    );
    result.contextToolNames = entries
      .filter((entry) => entry.type === 'hook:session.context')
      .map((entry) => entry.toolNames);
    result.setupToolList = entries.find((entry) => entry.type === 'setup:tool-list')?.tools ?? null;
    result.beforeHooks = entries
      .filter((entry) => entry.type === 'hook:tool.execute.before')
      .map((entry) => ({ tool: entry.tool, input: entry.input }));
    result.toolUnavailable = parts.some(
      (part) => part.state?.error?.message?.includes('is currently available') === true,
    );
    result.denyObserved =
      !allow &&
      result.advertised &&
      result.beforeHook &&
      !result.toolResultObserved &&
      !result.markerExists;
    // A deny observation without an executable positive control is not a gate.
    result.passed = allow ? result.advertised && result.toolResultObserved : false;
  } catch (error) {
    result.error = { code: error.code, message: String(error) };
  } finally {
    if (host) {
      await host.close();
      result.cleaned = true;
    }
    await rm(path, { force: true });
  }
  return result;
}

async function hostedCase(deny) {
  let host;
  const result = { case: deny ? 'hosted-definition-deny' : 'plain-request-control', passed: false };
  try {
    host = await startProbeHost({
      name: `hosted-${deny ? 'deny' : 'control'}`,
      denyHostedTools: deny,
      providerBody: deny ? { tools: [{ type: 'web_search' }] } : undefined,
      script: () => ({ text: 'HOSTED_CONTROL_OK', finish: 'stop' }),
    });
    await host.activate();
    const session = await host.session('Hosted surface');
    try {
      await run(host, session, 'Describe the request surface.');
    } catch (error) {
      result.waitError = String(error);
    }
    const entries = await host.entries();
    result.deniedHook = entries.some(
      (entry) => entry.type === 'hook:session.http.request:denied-hosted-tool',
    );
    result.providerRequests = host.provider.requests.length;
    result.passed = deny
      ? result.deniedHook && result.providerRequests === 0
      : result.providerRequests > 0;
  } catch (error) {
    result.error = { code: error.code, message: String(error) };
  } finally {
    if (host) {
      await host.close();
      result.cleaned = true;
    }
  }
  return result;
}

async function shellInterpolationCase() {
  const path = marker('shell-interpolation');
  let host;
  const result = { case: 'command-shell-interpolation', marker: path, passed: false };
  const script = `require('node:fs').appendFileSync(${JSON.stringify(path)}, String(Date.now()))`;
  const command = `---\ndescription: Shell interpolation probe\n---\nProbe.\n\n!\`${process.execPath} -e ${JSON.stringify(script)}\`\n`;
  try {
    host = await startProbeHost({
      name: 'shell-interpolation',
      commands: { 'probe-shell': command },
      script: () => ({ text: 'SHELL_CONTROL_OK', finish: 'stop' }),
    });
    await host.activate();
    const session = await host.session('Shell interpolation');
    await host.client.session.command({ sessionID: session.id, name: 'probe-shell', text: '' });
    await host.client.session.wait(
      { sessionID: session.id },
      {
        signal: AbortSignal.timeout(30_000),
      },
    );
    const shellAt = Number(await readFile(path, 'utf8'));
    const entries = await host.entries();
    const promptHook = entries.find(
      (entry) => entry.type === 'hook:session.prompt' && entry.sessionID === session.id,
    );
    const toolHook = entries.find(
      (entry) => entry.type === 'hook:tool.execute.before' && entry.sessionID === session.id,
    );
    result.markerExists = Number.isFinite(shellAt);
    result.shellAt = Number.isFinite(shellAt) ? shellAt : null;
    result.promptHookAt = promptHook?.at ?? null;
    result.promptHookBeforeShell = promptHook ? Date.parse(promptHook.at) <= shellAt : null;
    result.shellBeforePromptHook = promptHook ? shellAt < Date.parse(promptHook.at) : null;
    result.toolHookObserved = Boolean(toolHook);
    result.passed =
      result.markerExists && result.shellBeforePromptHook === true && !result.toolHookObserved;
  } catch (error) {
    result.error = { code: error.code, message: String(error) };
  } finally {
    if (host) {
      await host.close();
      result.cleaned = true;
    }
    await rm(path, { force: true });
  }
  return result;
}

async function providerExecutedAttempt() {
  let host;
  const result = { case: 'provider-executed-response', status: 'NOT_VERIFIED', passed: false };
  try {
    const fixture = await readFile(
      new URL('../fixtures/alibaba-hosted-web-search.sse', import.meta.url),
      'utf8',
    );
    host = await startProbeHost({
      name: 'provider-executed-attempt',
      providerPackage: '@opencode/ai/providers/alibaba/responses',
      modelId: 'qwen3.8-max',
      script: () => ({ raw: JSON.parse(fixture).interactions[0].response.body }),
    });
    await host.activate();
    const session = await host.session('Provider executed attempt');
    try {
      await run(host, session, 'Use web search.');
    } catch (error) {
      result.waitError = String(error);
    }
    const context = await host.client.session.context({ sessionID: session.id });
    result.providerRequests = host.provider.requests.length;
    result.terminal = context.some(
      (message) => message.type === 'assistant' && message.finish === 'stop',
    );
    result.providerExecutedToolParts = context.flatMap((message) =>
      message.type === 'assistant'
        ? (message.content ?? []).filter((part) => part.type === 'tool' && part.executed === false)
        : [],
    ).length;
    result.reason =
      'Recorded hosted-tool fixture did not provide a stable host-native completion; no preventive claim is made.';
  } catch (error) {
    result.error = { code: error.code, message: String(error) };
    result.status = 'NOT_VERIFIED';
  } finally {
    if (host) {
      await host.close();
      result.cleaned = true;
    }
  }
  return result;
}

const mcpDeny = await mcpCase(false);
const mcpAllow = await mcpCase(true);
const hostedDeny = await hostedCase(true);
const hostedControl = await hostedCase(false);
const shell = await shellInterpolationCase();
const providerExecuted = await providerExecutedAttempt();
const report = {
  at: new Date().toISOString(),
  surface: 'macOS private CLI/server 2.2.4; deterministic provider; test instrumentation',
  p004: 'NOT_VERIFIED',
  p001: 'BLOCKED',
  decision: 'NO-GO',
  cases: { mcpDeny, mcpAllow, hostedDeny, hostedControl, shell, providerExecuted },
  mcp: {
    advertised: mcpDeny.advertised === true && mcpAllow.advertised === true,
    denyHookObserved: mcpDeny.denyObserved === true,
    positiveControlExecuted: mcpAllow.toolResultObserved === true,
    advertisedButNotExecutable: mcpAllow.toolUnavailable === true,
    preEffectControl:
      mcpAllow.toolResultObserved === true && mcpDeny.denyObserved === true
        ? 'SUPPORTED_BOUNDED'
        : 'NOT_VERIFIED',
  },
  hosted: {
    visibleDefinitionPreventedBeforeProvider:
      hostedDeny.deniedHook === true && hostedDeny.providerRequests === 0,
    controlReachedProvider: hostedControl.providerRequests > 0,
    universalProviderContainment: 'NOT_SUPPORTED',
  },
  shell: {
    shellBlockRan: shell.markerExists === true,
    shellBeforePromptHook: shell.shellBeforePromptHook,
    promptHookBeforeShell: shell.promptHookBeforeShell,
    toolFenceObserved: shell.toolHookObserved === true,
  },
  providerExecuted: {
    status: providerExecuted.status,
    providerRequests: providerExecuted.providerRequests ?? null,
    terminal: providerExecuted.terminal ?? null,
    reason: providerExecuted.reason,
  },
  sourceSha256: {},
};
for (const path of [
  'lib/host.mjs',
  'lib/isolation.mjs',
  'lib/provider.mjs',
  'lib/review-evidence.mjs',
  'lib/mcp-server.mjs',
  'plugin/flowguard-probe.js',
  'probes/p0-prevention-surfaces.mjs',
]) {
  report.sourceSha256[path] = createHash('sha256')
    .update(await readFile(new URL(`../${path}`, import.meta.url)))
    .digest('hex');
}
await writeFile(join(runDir, 'raw.json'), JSON.stringify(report, null, 2) + '\n');
await writeFile(join(runDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ runDir, ...report }, null, 2));
// Exit 0 only confirms the observation program completed; never a P0-04 PASS.
if (Object.values(report.cases).some((item) => item.error)) process.exitCode = 1;
