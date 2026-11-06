#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startProbeHost } from '../lib/host.mjs';

const outDir =
  process.env.FG_PROBE_OUT ??
  join(process.cwd(), 'scripts/opencode-v2-probe/evidence/provider-executed');
await mkdir(outDir, { recursive: true });

const fixture = await readFile(
  join(process.cwd(), 'scripts/opencode-v2-probe/fixtures/alibaba-hosted-web-search.sse'),
  'utf8',
);

const host = await startProbeHost({
  name: 'provider-executed',
  providerPackage: '@opencode/ai/providers/alibaba/responses',
  modelId: 'qwen3.8-max',
  script: () => ({ raw: fixture }),
});
const result = {
  at: new Date().toISOString(),
  status: 'NOT_VERIFIED',
  serverInfo: host.serverInfo,
  providerRequests: [],
  events: [],
  toolHooks: [],
  context: [],
  passed: false,
  reason:
    'A recorded hosted-tool fixture was replayed through the Alibaba Responses runtime. The host did not reach a stable provider-executed tool completion, so no preventive or observational guarantee can be claimed.',
};
try {
  await host.activate();
  const session = await host.session('provider executed');
  await host.prompt(session.id, 'Search the web.');
  try {
    await host.client.session.wait({ sessionID: session.id });
  } catch (error) {
    result.waitError = String(error);
  }
  result.providerRequests = host.provider.requests.map((request) => ({
    url: request.url,
    body: request.body,
  }));
  const entries = await host.entries();
  result.events = entries
    .filter((entry) => entry.type === 'event')
    .map((entry) => ({ type: entry.eventType, data: entry.data }));
  result.toolHooks = entries.filter((entry) => entry.type.startsWith('hook:tool.execute'));
  result.context = (await host.client.session.context({ sessionID: session.id })).map(
    (message) => ({
      type: message.type,
      finish: message.finish,
      content: Array.isArray(message.content)
        ? message.content.map((part) => ({
            type: part.type,
            name: part.name,
            executed: part.executed,
            state: part.state?.status,
          }))
        : undefined,
    }),
  );
  const hostedCalls = result.events.filter(
    (entry) =>
      entry.type === 'session.tool.called' &&
      ['web_search', 'web_extractor'].includes(entry.data?.tool ?? ''),
  );
  result.observation = {
    hostedCalls,
    localHooksForHostedTools: result.toolHooks.filter((entry) =>
      ['web_search', 'web_extractor'].includes(entry.tool),
    ),
    providerRequestCount: result.providerRequests.length,
  };
  result.passed =
    hostedCalls.length > 0 && result.observation.localHooksForHostedTools.length === 0;
} catch (error) {
  result.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
}
await writeFile(join(outDir, 'report.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
await host.close();
if (!result.passed) process.exitCode = 1;
