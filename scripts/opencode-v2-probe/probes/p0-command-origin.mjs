#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startProbeHost } from '../lib/host.mjs';

const outDir =
  process.env.FG_PROBE_OUT ??
  join(process.cwd(), 'scripts/opencode-v2-probe/evidence/phase02/p0-01');
await mkdir(outDir, { recursive: true });
let attackCommand;
function script(body) {
  if (body.messages?.some((message) => message.role === 'tool'))
    return { text: 'ATTACKER_FINISHED' };
  const text = JSON.stringify(body.messages?.at(-1));
  if (text.includes('agent-origin-attempt'))
    return {
      tool: {
        name: 'shell',
        arguments: {
          command: attackCommand,
          description: 'Attempt command admission from an agent shell',
          timeout: 10_000,
        },
      },
    };
  return { text: 'RECEIVER_FINISHED' };
}

let host;
const result = {
  at: new Date().toISOString(),
  surface: 'private CLI/server; SDK and model-driven native shell',
  candidate: 'session.command + plugin command callback as human-origin proof',
  candidateStatus: 'NOT_VERIFIED',
  operatorChannel: 'NOT_VERIFIED',
  p001: 'BLOCKED',
  actualHumanTui: 'NOT_VERIFIED',
  actualHumanDesktop: 'NOT_VERIFIED',
};
try {
  host = await startProbeHost({ name: 'p0-01-origin', script });
  result.artifact = host.artifact;
  await host.activate();
  const sdkReceiver = await host.session('SDK command receiver');
  const shellReceiver = await host.session('Agent-shell command receiver');
  const attacker = await host.session('Untrusted model caller');
  await host.client.session.command({
    sessionID: sdkReceiver.id,
    name: 'probe-plugin-command',
    text: 'sdk-origin',
  });
  await host.client.session.wait(
    { sessionID: sdkReceiver.id },
    { signal: AbortSignal.timeout(30_000) },
  );

  const clientModule = new URL(
    '../node_modules/@opencode/client/dist/promise/index.js',
    import.meta.url,
  ).href;
  const attackFile = join(host.project, 'agent-caller.mjs');
  await writeFile(
    attackFile,
    `import { OpenCode } from ${JSON.stringify(clientModule)};
const password = process.env.OPENCODE_PASSWORD;
if (!password) throw new Error('Fixture credential not visible to shell');
const client = OpenCode.make({ baseUrl: ${JSON.stringify(host.baseUrl)}, headers: { Authorization: 'Basic ' + Buffer.from('opencode:' + password).toString('base64') } });
await client.session.command({ sessionID: ${JSON.stringify(shellReceiver.id)}, name: 'probe-plugin-command', text: 'agent-shell-origin' });
console.log('AGENT_COMMAND_ADMITTED');
`,
  );
  attackCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(attackFile)}`;
  await host.prompt(attacker.id, 'agent-origin-attempt');
  await host.client.session.wait(
    { sessionID: attacker.id },
    { signal: AbortSignal.timeout(30_000) },
  );
  await host.client.session.wait(
    { sessionID: shellReceiver.id },
    { signal: AbortSignal.timeout(30_000) },
  );
  const entries = await host.entries();
  const calls = entries.filter((entry) => entry.type === 'command:probe-plugin-command');
  result.observations = {
    sdkCallback: calls.some(
      (entry) => entry.sessionID === sdkReceiver.id && entry.prompt === 'sdk-origin',
    ),
    agentShellCallback: calls.some(
      (entry) => entry.sessionID === shellReceiver.id && entry.prompt === 'agent-shell-origin',
    ),
    callbackKeys: calls.map((entry) => entry.keys),
    shellCompleted: entries.some(
      (entry) =>
        entry.type === 'hook:tool.execute.after' &&
        entry.sessionID === attacker.id &&
        entry.tool === 'shell' &&
        entry.status === 'completed' &&
        JSON.stringify(entry.result).includes('AGENT_COMMAND_ADMITTED'),
    ),
  };
  if (
    result.observations.sdkCallback &&
    result.observations.agentShellCallback &&
    result.observations.shellCompleted
  )
    result.candidateStatus = 'NOT_SUPPORTED';
  await writeFile(
    join(outDir, 'raw.json'),
    JSON.stringify(
      {
        entries,
        contexts: await Promise.all(
          [sdkReceiver, shellReceiver, attacker].map((session) =>
            host.client.session.context({ sessionID: session.id }),
          ),
        ),
      },
      null,
      2,
    ) + '\n',
  );
} catch (error) {
  result.error = { code: error.code, message: String(error) };
} finally {
  if (host) {
    await host.close();
    result.cleaned = true;
  }
}
result.interpretation =
  'The fixture credential is deliberately available to the agent process. A successful agent call refutes human-origin inference from this API/callback, not every possible independently authenticated operator channel. No approval or governance activation was attempted.';
result.sourceSha256 = {};
for (const path of [
  'lib/host.mjs',
  'lib/isolation.mjs',
  'lib/provider.mjs',
  'plugin/flowguard-probe.js',
  'probes/p0-command-origin.mjs',
]) {
  result.sourceSha256[path] = createHash('sha256')
    .update(await readFile(new URL(`../${path}`, import.meta.url)))
    .digest('hex');
}
await writeFile(join(outDir, 'report.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
// A reproduced negative capability is an observation, never a passing P0-01.
if (result.candidateStatus !== 'NOT_SUPPORTED') process.exitCode = 1;
