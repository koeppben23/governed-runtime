#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startProbeHost } from '../lib/host.mjs';

const outDir =
  process.env.FG_PROBE_OUT ??
  join(process.cwd(), 'scripts/opencode-v2-probe/evidence/mandate-source');
await mkdir(outDir, { recursive: true });

const token = 'FG_PROBE_MANDATE_TOKEN_1169';
const host = await startProbeHost({
  name: 'mandate',
  instructions: `# Probe mandate\n\n${token}\n`,
});
const result = {
  at: new Date().toISOString(),
  serverInfo: host.serverInfo,
  contexts: [],
  passed: false,
};
try {
  await host.activate();
  const session = await host.session('mandate');
  await host.prompt(session.id, 'Check the mandate.');
  await host.client.session.wait({ sessionID: session.id });
  const entries = await host.entries();
  result.contexts = entries
    .filter((entry) => entry.type === 'hook:session.context')
    .map((entry) => ({
      instructionKeys: entry.system?.flatMap((part) => part.instructionKeys ?? []) ?? [],
      instructions: entry.system?.flatMap((part) => part.instructions ?? []) ?? [],
    }));
  result.passed = result.contexts.some((context) =>
    context.instructions.some(
      (instruction) => instruction.key === 'core/instructions' && instruction.text?.includes(token),
    ),
  );
} catch (error) {
  result.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
}
await writeFile(join(outDir, 'report.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
await host.close();
if (!result.passed) process.exitCode = 1;
