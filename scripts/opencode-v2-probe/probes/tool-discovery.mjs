#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startProbeHost } from '../lib/host.mjs';

const outDir =
  process.env.FG_PROBE_OUT ??
  join(process.cwd(), 'scripts/opencode-v2-probe/evidence/tool-discovery');
await mkdir(outDir, { recursive: true });

const host = await startProbeHost({ name: 'tools', legacyTool: true });
const result = {
  at: new Date().toISOString(),
  serverInfo: host.serverInfo,
  legacyToolFile: join(host.project, '.opencode', 'tools', 'legacy-probe.ts'),
  setupTools: [],
  contextTools: [],
  discoveryLog: [],
  legacyToolDirectCall: null,
  passed: false,
};
try {
  await host.activate();
  const entries = await host.entries();
  result.setupTools = entries.find((entry) => entry.type === 'setup:tool-list')?.tools ?? [];
  result.discoveryLog = host
    .output()
    .split('\n')
    .filter((line) => /tool|legacy|plugin/i.test(line) && /loading|discover|legacy/i.test(line))
    .slice(-30);
  const session = await host.session('tool discovery');
  await host.prompt(session.id, 'Report the available tools.');
  await host.client.session.wait({ sessionID: session.id });
  const context = await host.client.session.context({ sessionID: session.id });
  result.contextTools =
    (await host.entries())
      .filter((entry) => entry.type === 'hook:session.context' && entry.sessionID === session.id)
      .at(-1)?.toolNames ?? [];
  result.contextMessages = context.map((message) => ({
    type: message.type,
    id: message.id,
    finish: message.finish,
  }));

  // A v2 direct plugin tool is callable by name. A legacy v1 tool is not
  // assumed to exist just because its file is present.
  const directCall = await host.prompt(session.id, 'Call probe_direct with text "direct-ok".');
  result.legacyToolDirectCall = {
    admissionID: directCall.id,
    legacyInSetup: result.setupTools.filter((name) => /legacy/i.test(name)),
    legacyInContext: result.contextTools.filter((name) => /legacy/i.test(name)),
    directInContext: result.contextTools.includes('probe_direct'),
    echoIsCodeMode: !result.contextTools.includes('probe_echo'),
  };
  result.passed =
    result.legacyToolDirectCall.directInContext &&
    result.legacyToolDirectCall.echoIsCodeMode &&
    result.legacyToolDirectCall.legacyInSetup.length === 0 &&
    result.legacyToolDirectCall.legacyInContext.length === 0;
} catch (error) {
  result.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
}
await writeFile(join(outDir, 'report.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
await host.close();
if (!result.passed) process.exitCode = 1;
