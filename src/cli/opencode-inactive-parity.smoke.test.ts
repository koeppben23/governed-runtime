/** Original P0-00 counterprobe assertions against real packed install bytes.
 * No workflow/activation fixture is seeded; this is not operator-UI proof. */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { SessionMessageAssistantTool } from '@opencode/client';
import { TOOL_FLOWGUARD_HELP } from '../integration/tool-names.js';
import { createNativeHostProbe, type NativeHostProbe } from './opencode-native-test-helpers.js';
import { createPackedFlowGuardInstall } from './opencode-packed-install-test-helpers.js';

const LIVE = process.env.OPENCODE_LIVE === '1' || process.env.FLOWGUARD_OPENCODE_HOST_E2E === '1';
const probes: NativeHostProbe[] = [];
let artifact: Awaited<ReturnType<typeof createPackedFlowGuardInstall>>;
afterEach(async () => {
  for (const probe of probes.splice(0).reverse()) await probe.close();
});

async function observeProduct(probe: NativeHostProbe, installed: boolean) {
  probes.push(probe);
  const plugins = await probe.client.plugin.list({ location: probe.location });
  const product = plugins.data.filter((plugin) => plugin.id === 'flowguard');
  expect(product).toHaveLength(installed ? 1 : 0);
  if (installed) expect(product[0]!.state).toEqual({ status: 'active' });
}

/** Native shell effect valid in PowerShell and POSIX sh: one outer
 * double-quoted `-e` script, single-quoted JS strings, forward-slash paths. */
function nativeWriteCommand(target: string, effect: string) {
  const path = target.replaceAll('\\', '/').replaceAll("'", "\\'");
  return `node -e "require('node:fs').writeFileSync('${path}', '${effect}')"`;
}

async function mutationArm(product: boolean, git: boolean, tool: 'shell' | 'edit') {
  let target = '';
  const emitted = new Set<string>();
  const probe = await createNativeHostProbe({
    git,
    async prepare(project, env) {
      target = join(project, 'native-target.txt');
      await writeFile(target, 'original');
      if (product) await artifact.install(project, env);
    },
    script(_body, sessionID) {
      if (emitted.has(sessionID)) return { text: 'Done.' };
      emitted.add(sessionID);
      return {
        tool: {
          name: tool,
          arguments:
            tool === 'edit'
              ? { path: target, oldString: 'original', newString: 'native-effect' }
              : {
                  command: nativeWriteCommand(target, 'native-effect'),
                  description: 'Bounded native side-effect comparison',
                },
        },
      };
    },
  });
  await observeProduct(probe, product);
  const session = await probe.session();
  await probe.prompt(session.id, 'Perform the requested native operation.');
  const history = await probe.client.session.context({ sessionID: session.id });
  const records = history
    .flatMap((message) => (message.type === 'assistant' ? message.content : []))
    .filter(
      (part): part is SessionMessageAssistantTool => part.type === 'tool' && part.name === tool,
    );
  expect(probe.errors).toEqual([]);
  return {
    effect: await readFile(target, 'utf8'),
    statuses: records.map((part) => part.state.status),
    history,
  };
}

describe.skipIf(!LIVE)('native parity before trusted FlowGuard start', () => {
  beforeAll(async () => {
    artifact = await createPackedFlowGuardInstall();
  }, 300_000);
  afterAll(async () => {
    await artifact?.close();
  });
  it.each([
    { git: true, tool: 'shell' },
    { git: true, tool: 'edit' },
    { git: false, tool: 'shell' },
    { git: false, tool: 'edit' },
  ] as const)(
    'does not veto ordinary $tool effects, Git=$git',
    async ({ git, tool }) => {
      const absent = await mutationArm(false, git, tool);
      expect(absent.effect, JSON.stringify(absent.history)).toBe('native-effect');
      expect(absent.statuses).toEqual(['completed']);
      const installed = await mutationArm(true, git, tool);
      expect(installed.effect, JSON.stringify(installed.history)).toBe(absent.effect);
      expect(installed.statuses).toEqual(absent.statuses);
    },
    180_000,
  );

  it('keeps the effective provider-wire tool catalogue native except for an inert help affordance', async () => {
    const catalogues: string[][] = [];
    for (const product of [false, true]) {
      const probe = await createNativeHostProbe({
        async prepare(project, env) {
          if (product) await artifact.install(project, env);
        },
      });
      await observeProduct(probe, product);
      const session = await probe.session();
      await probe.prompt(session.id, 'Reply OK without any tool calls.');
      expect(probe.requests).toHaveLength(1);
      const tools = probe.requests[0]!.body.tools as Array<{ function: { name: string } }>;
      const names = tools.map((tool) => tool.function.name).sort();
      expect(names).toEqual(expect.arrayContaining(['edit', 'shell']));
      expect(probe.errors).toEqual([]);
      catalogues.push(names.filter((name) => name !== TOOL_FLOWGUARD_HELP));
    }
    expect(catalogues[1]).toEqual(catalogues[0]);
  }, 180_000);

  it('keeps ordinary native subagent execution and its child effects unchanged before start', async () => {
    for (const product of [false, true]) {
      let rootID = '';
      let target = '';
      const emitted = new Set<string>();
      const probe = await createNativeHostProbe({
        async prepare(project, env) {
          target = join(project, 'child-effect.txt');
          await writeFile(target, 'original');
          if (product) await artifact.install(project, env);
        },
        script(_body, sessionID) {
          rootID ||= sessionID;
          if (emitted.has(sessionID)) return { text: 'Done.' };
          emitted.add(sessionID);
          if (sessionID === rootID)
            return {
              tool: {
                name: 'subagent',
                arguments: {
                  agent: 'general',
                  description: 'Bounded native child effect',
                  prompt: 'Perform the requested operation.',
                },
              },
            };
          return {
            tool: {
              name: 'shell',
              arguments: {
                command: nativeWriteCommand(target, 'child-effect'),
                description: 'Bounded native child side effect',
              },
            },
          };
        },
      });
      await observeProduct(probe, product);
      const session = await probe.session();
      await probe.prompt(session.id);
      expect(await readFile(target, 'utf8'), probe.output()).toBe('child-effect');
      const history = await probe.client.session.context({ sessionID: session.id });
      const delegated = history
        .flatMap((message) => (message.type === 'assistant' ? message.content : []))
        .filter(
          (part): part is SessionMessageAssistantTool =>
            part.type === 'tool' && part.name === 'subagent',
        );
      expect(
        delegated.map((part) => part.state.status),
        JSON.stringify(history),
      ).toEqual(['completed']);
      const childRequests = probe.requests.filter((request) => request.sessionID !== session.id);
      expect(childRequests.length).toBeGreaterThan(0);
      for (const request of childRequests) {
        const tools = request.body.tools as Array<{ function: { name: string } }>;
        expect(
          tools
            .map((tool) => tool.function.name)
            .filter((name) => name.startsWith('flowguard_') && name !== TOOL_FLOWGUARD_HELP),
        ).toEqual([]);
      }
      expect(probe.errors).toEqual([]);
    }
  }, 180_000);

  it('does not inject governance mandates into native INACTIVE compaction', async () => {
    for (const product of [false, true]) {
      const probe = await createNativeHostProbe({
        async prepare(project, env) {
          if (product) await artifact.install(project, env);
        },
      });
      await observeProduct(probe, product);
      const session = await probe.session();
      await probe.prompt(session.id, 'Reply OK without tool calls.');
      const count = probe.requests.length;
      await probe.client.session.compact({ sessionID: session.id });
      await probe.client.session.wait(
        { sessionID: session.id },
        { signal: AbortSignal.timeout(60_000) },
      );
      const compacted = probe.requests.slice(count);
      expect(compacted.length, probe.output()).toBeGreaterThan(0);
      for (const request of compacted)
        expect(JSON.stringify(request.body)).not.toContain('FlowGuard Governance State');
      expect(probe.errors).toEqual([]);
    }
  }, 180_000);
});
