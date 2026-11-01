/** Actual native-host opt-in conformance. No workflow/activation fixture is seeded.
 * Loads workspace-built product bytes, not a packed install or operator-UI proof. */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionMessageAssistantTool } from '@opencode/client';
import { TOOL_FLOWGUARD_HELP } from '../integration/tool-names.js';
import { createNativeHostProbe, type NativeHostProbe } from './opencode-native-test-helpers.js';

const LIVE = process.env.OPENCODE_LIVE === '1' || process.env.FLOWGUARD_OPENCODE_HOST_E2E === '1';
const probes: NativeHostProbe[] = [];
afterEach(async () => {
  for (const probe of probes.splice(0).reverse()) await probe.close();
});

async function mutationArm(product: boolean, git: boolean, tool: 'shell' | 'edit') {
  let target = '';
  const emitted = new Set<string>();
  const probe = await createNativeHostProbe({
    product,
    git,
    async prepare(project) {
      target = join(project, 'native-target.txt');
      await writeFile(target, 'original');
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
                  command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(target)}, 'native-effect')`)}`,
                  description: 'Bounded native side-effect comparison',
                },
        },
      };
    },
  });
  probes.push(probe);
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
      const probe = await createNativeHostProbe({ product });
      probes.push(probe);
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
});
