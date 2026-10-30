#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startProbeHost } from '../lib/host.mjs';

const outDir =
  process.env.FG_PROBE_OUT ??
  join(process.cwd(), 'scripts/opencode-v2-probe/evidence/plugin-activation');
await mkdir(outDir, { recursive: true });

const positive = await startProbeHost({ name: 'activation' });
const positiveResult = {
  serverInfo: positive.serverInfo,
  serverPid: positive.proc.pid,
  project: positive.project,
  journal: positive.journal,
  discoveryLog: null,
  setup: [],
  tools: [],
  commands: [],
  pluginList: null,
  passed: false,
};

try {
  await positive.activate();
  const entries = await positive.entries();
  positiveResult.setup = entries.filter((entry) => entry.type.startsWith('setup:'));
  positiveResult.tools = entries.find((entry) => entry.type === 'setup:tool-list')?.tools ?? [];
  positiveResult.commands =
    entries.find((entry) => entry.type === 'setup:command-list')?.commands ?? [];
  positiveResult.pluginList = entries.find((entry) => entry.type === 'setup:plugin-list')?.plugins;
  positiveResult.discoveryLog = positive
    .output()
    .split('\n')
    .filter((line) => /plugin/i.test(line) && /flowguard-probe|loading/i.test(line))
    .slice(-20);
  const ready = positiveResult.setup.some((entry) => entry.type === 'setup:ready');
  const hasEcho = positiveResult.tools.includes('probe_echo');
  const hasDirect = positiveResult.tools.includes('probe_direct');
  const hasCommand = positiveResult.commands.includes('probe-plugin-command');
  positiveResult.passed = ready && hasEcho && hasDirect && hasCommand;
} catch (error) {
  positiveResult.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
}

const failed = await startProbeHost({ name: 'activation-fail', failSetup: true });
const failedResult = {
  serverInfo: failed.serverInfo,
  project: failed.project,
  journal: failed.journal,
  observed: [],
  sessionCreateError: null,
  survivedSetupFailure: false,
};
try {
  try {
    await failed.client.location.get();
    await failed.client.session.create({
      title: 'probe activation failure',
      location: { directory: failed.project },
    });
  } catch (error) {
    failedResult.sessionCreateError = String(error);
  }
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  failedResult.observed = await failed.entries();
  failedResult.survivedSetupFailure = failed.proc.exitCode === null;
  failedResult.failClosed = !failedResult.survivedSetupFailure;
  failedResult.status = failedResult.failClosed ? 'SUPPORTED' : 'NOT_SUPPORTED';
  failedResult.reason = failedResult.failClosed
    ? 'Host stopped when plugin setup failed.'
    : 'Host remained alive and accepted session operations after plugin setup failed; hooks were absent. Install/doctor must detect this fail-open state.';
} finally {
  await failed.close();
}

const result = {
  at: new Date().toISOString(),
  passed: positiveResult.passed && failedResult.failClosed,
  status:
    positiveResult.passed && failedResult.failClosed
      ? 'SUPPORTED'
      : positiveResult.passed
        ? 'NOT_SUPPORTED'
        : 'NOT_VERIFIED',
  positive: positiveResult,
  failedSetup: failedResult,
};
await writeFile(join(outDir, 'report.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
await positive.close();
if (!result.passed) process.exitCode = 1;
