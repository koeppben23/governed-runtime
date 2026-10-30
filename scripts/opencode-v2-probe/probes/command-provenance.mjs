#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startProbeHost } from '../lib/host.mjs';

const outDir =
  process.env.FG_PROBE_OUT ??
  join(process.cwd(), 'scripts/opencode-v2-probe/evidence/command-provenance');
await mkdir(outDir, { recursive: true });

const marker = `/tmp/fg-v2-command-shell-${process.pid}-${Date.now()}`;
const host = await startProbeHost({
  name: 'commands',
  commands: {
    'probe-shell': `---\ndescription: Probe shell block\n---\nShell block command.\n\n!\`touch ${marker}\`\n`,
  },
});
const result = {
  at: new Date().toISOString(),
  serverInfo: host.serverInfo,
  marker,
  nativeCommand: null,
  rawPrompt: null,
  pluginCommand: null,
  observations: {},
  passed: false,
};
try {
  await host.activate();
  const session = await host.session('command provenance');

  await host.client.session.command({
    sessionID: session.id,
    name: 'probe-shell',
    text: '',
  });
  try {
    await host.client.session.wait({ sessionID: session.id });
  } catch (error) {
    result.nativeCommand = { waitError: String(error) };
  }
  const markerAfterNative = await readFile(marker)
    .then(() => true)
    .catch(() => false);
  const nativeEntries = await host.entries();
  result.nativeCommand = {
    markerExists: markerAfterNative,
    promptHooks: nativeEntries.filter((entry) => entry.type === 'hook:session.prompt'),
    toolHooks: nativeEntries.filter((entry) => entry.type === 'hook:tool.execute.before'),
    events: nativeEntries.filter((entry) => entry.type === 'event').map((entry) => entry.eventType),
  };

  await rm(marker, { force: true });
  const raw = await host.prompt(session.id, '/probe-shell');
  try {
    await host.client.session.wait({ sessionID: session.id });
  } catch (error) {
    result.rawPrompt = { waitError: String(error) };
  }
  const rawEntries = await host.entries();
  result.rawPrompt = {
    admissionID: raw.id,
    markerExists: await readFile(marker)
      .then(() => true)
      .catch(() => false),
    promptHooks: rawEntries.filter(
      (entry) => entry.type === 'hook:session.prompt' && entry.sessionID === session.id,
    ),
    commandExecutions: rawEntries.filter((entry) => entry.type === 'command:probe-plugin-command'),
  };

  await host.client.session.command({
    sessionID: session.id,
    name: 'probe-plugin-command',
    text: 'from-command',
  });
  try {
    await host.client.session.wait({ sessionID: session.id });
  } catch (error) {
    result.pluginCommand = { waitError: String(error) };
  }
  const pluginEntries = await host.entries();
  result.pluginCommand = {
    commandExecutions: pluginEntries.filter(
      (entry) => entry.type === 'command:probe-plugin-command',
    ),
    promptHooks: pluginEntries.filter(
      (entry) => entry.type === 'hook:session.prompt' && entry.sessionID === session.id,
    ),
    events: pluginEntries
      .filter((entry) => entry.type === 'event' && entry.data?.sessionID === session.id)
      .map((entry) => entry.eventType),
  };

  result.observations = {
    shellBlockCanRunBeforePrompt:
      result.nativeCommand.promptHooks.length > 0 && result.nativeCommand.markerExists === true,
    rawPromptDoesNotRunCommandShell:
      result.rawPrompt.markerExists === false &&
      result.rawPrompt.promptHooks.some((entry) => entry.prompt === '/probe-shell'),
    pluginCommandHasPromptButNoHostOrigin:
      result.pluginCommand.commandExecutions.length > 0 &&
      result.pluginCommand.promptHooks.some(
        (entry) => entry.prompt === 'plugin-command:from-command',
      ),
    hostExposesCommandOrigin: false,
  };
  result.passed =
    result.observations.shellBlockCanRunBeforePrompt &&
    result.observations.pluginCommandHasPromptButNoHostOrigin;
} catch (error) {
  result.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
}
await writeFile(join(outDir, 'report.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
await host.close();
if (!result.passed) process.exitCode = 1;
