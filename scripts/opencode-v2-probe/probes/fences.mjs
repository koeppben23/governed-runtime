#!/usr/bin/env node
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startProbeHost } from '../lib/host.mjs';

const outDir =
  process.env.FG_PROBE_OUT ?? join(process.cwd(), 'scripts/opencode-v2-probe/evidence/fences');
await mkdir(outDir, { recursive: true });

async function startFetchCapture() {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push({ url: req.url, at: new Date().toISOString() });
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('capture');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no capture port');
  return {
    port: address.port,
    hits,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function toolScript(call) {
  return (body) => {
    const hasToolResult =
      Array.isArray(body.messages) && body.messages.some((m) => m.role === 'tool');
    if (hasToolResult) return { text: 'tool-result-observed', finish: 'stop' };
    return { tool: call, finish: 'tool_calls' };
  };
}

async function runCase({ name, deny, call, setup, inspect }) {
  const host = await startProbeHost({
    name,
    denyTools: deny,
    script: toolScript(call),
  });
  const result = {
    name,
    deny,
    call,
    marker: null,
    beforeHooks: [],
    afterHooks: [],
    toolExecuted: false,
    context: [],
    journal: [],
    passed: false,
  };
  try {
    await host.activate();
    await setup?.(host);
    const session = await host.session(name);
    await host.prompt(session.id, `Run the ${name} probe.`);
    try {
      await host.client.session.wait({ sessionID: session.id });
    } catch (error) {
      result.waitError = String(error);
    }
    const entries = await host.entries();
    result.beforeHooks = entries.filter((entry) => entry.type === 'hook:tool.execute.before');
    result.afterHooks = entries.filter((entry) => entry.type === 'hook:tool.execute.after');
    result.toolExecuted = entries.some(
      (entry) => entry.type.startsWith('tool:') && entry.type !== 'hook:tool.execute.after',
    );
    result.context = (await host.client.session.context({ sessionID: session.id })).map(
      (message) => ({
        type: message.type,
        id: message.id,
        finish: message.finish,
      }),
    );
    result.journal = entries
      .filter((entry) => entry.type === 'event' || entry.type.startsWith('hook:'))
      .map((entry) => ({
        type: entry.type,
        tool: entry.tool,
        id: entry.id,
        eventType: entry.eventType,
      }));
    Object.assign(result, (await inspect?.(host, session, entries)) ?? {});
    result.passed = result.expectedPass === true;
  } catch (error) {
    result.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  } finally {
    await host.close();
  }
  return result;
}

const cases = [];

{
  const capture = await startFetchCapture();
  const host = await startProbeHost({
    name: 'fence-edit',
    denyTools: ['edit'],
    script: toolScript({
      name: 'edit',
      arguments: {
        path: 'edit-target.txt',
        oldString: 'original',
        newString: 'modified',
      },
    }),
  });
  const file = join(host.project, 'edit-target.txt');
  await writeFile(file, 'original\n');
  const result = {
    name: 'edit-deny',
    file,
    original: 'original\n',
    after: null,
    deniedHook: false,
    passed: false,
  };
  try {
    await host.activate();
    const session = await host.session('edit deny');
    await host.prompt(session.id, 'Try to edit the file.');
    try {
      await host.client.session.wait({ sessionID: session.id });
    } catch (error) {
      result.waitError = String(error);
    }
    result.after = await readFile(file, 'utf8');
    const entries = await host.entries();
    result.deniedHook = entries.some(
      (entry) =>
        entry.type === 'hook:tool.execute.before' &&
        entry.tool === 'edit' &&
        JSON.stringify(entry.input ?? '').includes('edit-target'),
    );
    result.afterHooks = entries.filter((entry) => entry.type === 'hook:tool.execute.after');
    result.passed = result.after === 'original\n' && result.deniedHook;
  } catch (error) {
    result.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  } finally {
    await host.close();
    await capture.close();
  }
  cases.push(result);
}

{
  const marker = `/tmp/fg-v2-shell-fence-${process.pid}-${Date.now()}`;
  const host = await startProbeHost({
    name: 'fence-shell',
    denyTools: ['shell'],
    script: toolScript({
      name: 'shell',
      arguments: { command: `touch ${marker}`, description: 'fence probe', timeout: 10_000 },
    }),
  });
  const result = {
    name: 'shell-deny',
    marker,
    markerExists: false,
    deniedHook: false,
    passed: false,
  };
  try {
    await host.activate();
    const session = await host.session('shell deny');
    await host.prompt(session.id, 'Try to run a shell command.');
    try {
      await host.client.session.wait({ sessionID: session.id });
    } catch (error) {
      result.waitError = String(error);
    }
    result.markerExists = await readFile(marker)
      .then(() => true)
      .catch(() => false);
    const entries = await host.entries();
    result.deniedHook = entries.some(
      (entry) => entry.type === 'hook:tool.execute.before' && entry.tool === 'shell',
    );
    result.passed = !result.markerExists && result.deniedHook;
  } catch (error) {
    result.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  } finally {
    await host.close();
  }
  cases.push(result);
}

{
  const capture = await startFetchCapture();
  const code = `return await fetch('http://127.0.0.1:${capture.port}/leak').then(r => r.text())`;
  const host = await startProbeHost({
    name: 'fence-code-mode',
    denyTools: ['execute'],
    script: toolScript({ name: 'execute', arguments: { code } }),
  });
  const result = {
    name: 'code-mode-deny',
    captureHits: 0,
    deniedHook: false,
    nestedTool: false,
    passed: false,
  };
  try {
    await host.activate();
    const session = await host.session('code mode deny');
    await host.prompt(session.id, 'Try Code Mode.');
    try {
      await host.client.session.wait({ sessionID: session.id });
    } catch (error) {
      result.waitError = String(error);
    }
    const entries = await host.entries();
    result.captureHits = capture.hits.length;
    result.deniedHook = entries.some(
      (entry) => entry.type === 'hook:tool.execute.before' && entry.tool === 'execute',
    );
    result.nestedTool = entries.some((entry) => entry.type === 'tool:probe_echo');
    result.passed = result.captureHits === 0 && result.deniedHook && !result.nestedTool;
  } catch (error) {
    result.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  } finally {
    await host.close();
    await capture.close();
  }
  cases.push(result);
}

{
  const marker = `/tmp/fg-v2-mcp-fence-${process.pid}-${Date.now()}`;
  const mcpServer = fileURLToPath(new URL('../lib/mcp-server.mjs', import.meta.url));
  const host = await startProbeHost({
    name: 'fence-mcp',
    denyTools: ['mcprobe_echo'],
    mcpServer,
    mcpMarker: marker,
    script: toolScript({ name: 'mcprobe_echo', arguments: { text: 'mcp-probe' } }),
  });
  const result = {
    name: 'mcp-deny',
    status: 'NOT_VERIFIED',
    marker,
    markerExists: false,
    exposed: false,
    deniedHook: false,
    passed: false,
    reason:
      'The MCP server connected, but the host did not advertise its tool in the session tool list. The before-hook saw the attempted name, but no MCP execution path was proven.',
  };
  try {
    await host.activate();
    const session = await host.session('mcp deny');
    await host.prompt(session.id, 'Call the MCP echo tool.');
    try {
      await host.client.session.wait({ sessionID: session.id });
    } catch (error) {
      result.waitError = String(error);
    }
    result.markerExists = await readFile(marker, 'utf8')
      .then(() => true)
      .catch(() => false);
    const entries = await host.entries();
    result.exposed = entries.some(
      (entry) => entry.type === 'hook:session.context' && entry.toolNames?.includes('mcprobe_echo'),
    );
    result.deniedHook = entries.some(
      (entry) => entry.type === 'hook:tool.execute.before' && entry.tool === 'mcprobe_echo',
    );
    result.passed = !result.markerExists && result.exposed && result.deniedHook;
  } catch (error) {
    result.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  } finally {
    await host.close();
  }
  cases.push(result);
}

{
  const host = await startProbeHost({
    name: 'fence-direct-allowed',
    denyTools: [],
    script: (body) => {
      const hasToolResult =
        Array.isArray(body.messages) && body.messages.some((m) => m.role === 'tool');
      return hasToolResult
        ? { text: 'direct-result-observed', finish: 'stop' }
        : {
            tool: { name: 'probe_direct', arguments: { text: 'direct-ok' } },
            finish: 'tool_calls',
          };
    },
  });
  const result = { name: 'direct-tool-allowed', executed: false, after: false, passed: false };
  try {
    await host.activate();
    const session = await host.session('direct allowed');
    await host.prompt(session.id, 'Call the direct tool.');
    try {
      await host.client.session.wait({ sessionID: session.id });
    } catch (error) {
      result.waitError = String(error);
    }
    const entries = await host.entries();
    result.executed = entries.some((entry) => entry.type === 'tool:probe_direct');
    result.after = entries.some(
      (entry) => entry.type === 'hook:tool.execute.after' && entry.tool === 'probe_direct',
    );
    result.passed = result.executed && result.after;
  } catch (error) {
    result.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  } finally {
    await host.close();
  }
  cases.push(result);
}

const result = {
  at: new Date().toISOString(),
  passed:
    cases.filter((item) => item.status !== 'NOT_VERIFIED').every((item) => item.passed) &&
    cases.every((item) => item.status !== 'NOT_VERIFIED'),
  status: cases.some((item) => item.status === 'NOT_VERIFIED') ? 'NOT_VERIFIED' : 'SUPPORTED',
  cases,
  providerExecuted: {
    status: 'NOT_VERIFIED',
    reason:
      'The deterministic OpenAI-compatible chat provider only emits local tool calls. Provider-executed hosted tools require a provider/protocol fixture; source inspection shows the local execute.before hook is not invoked for providerExecuted tool calls.',
  },
};
await writeFile(join(outDir, 'report.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
if (!cases.every((item) => item.passed)) process.exitCode = 1;
