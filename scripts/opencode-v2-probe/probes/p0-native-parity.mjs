#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startProbeHost } from '../lib/host.mjs';
import { compareNativeParity, normalizeFixturePaths } from '../lib/native-parity.mjs';

const outDir =
  process.env.FG_PROBE_OUT ??
  join(process.cwd(), 'scripts/opencode-v2-probe/evidence/phase02/p0-00');
await mkdir(outDir, { recursive: true });

function script(body) {
  if (body.messages?.some((message) => message.role === 'tool'))
    return { text: 'NATIVE_PARITY_OK' };
  return {
    tool: {
      name: 'shell',
      arguments: {
        command: "printf 'native-side-effect\\n' > native-marker.txt",
        description: 'Disposable native parity side effect',
        timeout: 10_000,
      },
    },
  };
}

async function run(plugin) {
  let host;
  const result = { plugin, passed: false };
  try {
    host = await startProbeHost({ name: `p0-00-${plugin}`, plugin, script });
    result.artifact = host.artifact;
    result.discovery = host.discovery;
    result.serverInfo = host.serverInfo;
    await host.activate();
    const location = { directory: host.project };
    result.plugins = await host.client.plugin.list({ location });
    result.models = await host.client.model.list({ location });
    result.agents = await host.client.agent.list({ location });
    result.hostPaths = host.hostPaths;
    const session = await host.session('P0-00 native parity');
    await host.client.session.switchModel({
      sessionID: session.id,
      model: { providerID: 'probe', id: 'probe', variant: 'chosen' },
    });
    await host.prompt(session.id, 'Run the native parity fixture.');
    await host.client.session.wait(
      { sessionID: session.id },
      { signal: AbortSignal.timeout(30_000) },
    );
    result.context = await host.client.session.context({ sessionID: session.id });
    result.marker = await readFile(join(host.project, 'native-marker.txt'), 'utf8');
    result.journal = await host.entries();
    // Raw wire/context retained only in ignored local evidence, never published wholesale.
    result.requests = host.provider.requests;
    result.summary = {
      tools: result.requests[0]?.body?.tools,
      toolNames: (result.requests[0]?.body?.tools ?? []).map((tool) => tool.function?.name).sort(),
      model: result.requests[0]?.body?.model,
      reasoningEffort: result.requests[0]?.body?.reasoning_effort,
      toolResultReceived: result.requests.some((request) =>
        request.body?.messages?.some((message) => message.role === 'tool'),
      ),
      nativeMarker: result.marker === 'native-side-effect\n',
      normalAnswer: result.context.some(
        (message) =>
          message.type === 'assistant' &&
          message.finish === 'stop' &&
          JSON.stringify(message.content).includes('NATIVE_PARITY_OK'),
      ),
      journalTypes: result.journal.map((entry) => entry.type),
      pluginActive: result.plugins.data.some(
        (entry) => entry.id === 'flowguard.passive-probe' && entry.state.status === 'active',
      ),
      models: result.models.data
        .map((model) => ({ providerID: model.providerID, id: model.id, variants: model.variants }))
        .sort((a, b) => `${a.providerID}/${a.id}`.localeCompare(`${b.providerID}/${b.id}`)),
      agents: result.agents.data
        .map((agent) => ({ id: agent.id, permissions: agent.permissions }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    };
    result.summary = normalizeFixturePaths(result.summary, host.root);
    result.passed =
      result.summary.nativeMarker &&
      result.summary.normalAnswer &&
      result.summary.toolResultReceived;
  } catch (error) {
    result.error = { code: error.code, message: String(error) };
  } finally {
    if (host) {
      await host.close();
      result.cleaned = true;
    }
  }
  await writeFile(join(outDir, `${plugin}.json`), JSON.stringify(result, null, 2) + '\n');
  return result;
}

const absent = await run('absent');
const passive = await run('passive');
const { comparisons, fixtureStatus } = compareNativeParity(absent, passive);
const report = {
  at: new Date().toISOString(),
  host: absent.artifact,
  surface: 'private CLI/server; SDK-driven',
  scope: 'Absent versus passive loader fixture, NOT installed FlowGuard INACTIVE certification',
  fixtureStatus,
  normalization:
    'Only exact per-case disposable root replaced by <FIXTURE_ROOT>; raw local evidence retained.',
  productP000: 'NOT_VERIFIED',
  desktop: 'NOT_VERIFIED',
  tui: 'NOT_VERIFIED',
  comparisons,
  cases: [absent, passive].map((result) => ({
    plugin: result.plugin,
    passed: result.passed,
    cleaned: result.cleaned,
    error: result.error,
    summary: result.summary,
  })),
  sourceSha256: {},
};
for (const path of [
  'lib/host.mjs',
  'lib/isolation.mjs',
  'lib/provider.mjs',
  'lib/native-parity.mjs',
  'plugin/passive.js',
  'probes/p0-native-parity.mjs',
]) {
  report.sourceSha256[path] = createHash('sha256')
    .update(await readFile(new URL(`../${path}`, import.meta.url)))
    .digest('hex');
}
await writeFile(join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (report.fixtureStatus !== 'SUPPORTED') process.exitCode = 1;
