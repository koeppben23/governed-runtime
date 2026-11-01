/** Actual host hooks/provider wire and product gates with explicitly seeded
 * component authority. This is NOT StartGovernance/operator-UI acceptance. */
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionMessageAssistantTool } from '@opencode/client';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createNativeHostProbe, type NativeHostProbe } from './opencode-native-test-helpers.js';
import {
  COMPONENT_ACTIVATION_SETUP,
  seedNativeActiveScope,
} from './opencode-activation-test-helpers.js';

const LIVE = process.env.OPENCODE_LIVE === '1' || process.env.FLOWGUARD_OPENCODE_HOST_E2E === '1';
let probe: NativeHostProbe | undefined;
afterEach(async () => {
  await probe?.close();
  probe = undefined;
});

describe.skipIf(!LIVE)('native activation scope with component-only authority', () => {
  it('admits a real native delegation, gates the child through root authority and leaves an INACTIVE sibling native', async () => {
    let activeID = '';
    let ordinaryID = '';
    let deniedTarget = '';
    let ordinaryTarget = '';
    let nativeChildID = '';
    let parentTurns = 0;
    const emitted = new Set<string>();
    probe = await createNativeHostProbe({
      product: true,
      productTestSetup: COMPONENT_ACTIVATION_SETUP,
      async prepare(project) {
        deniedTarget = join(project, 'denied-child-effect.txt');
        ordinaryTarget = join(project, 'ordinary-sibling.txt');
        await writeFile(join(project, 'README.md'), 'Native active scope component test.');
      },
      script(_body, sessionID) {
        if (sessionID === activeID) {
          parentTurns++;
          if (parentTurns > 2) return { text: 'Done.' };
          return {
            tool: {
              name: 'subagent',
              arguments: {
                agent: parentTurns === 1 ? 'general' : 'explore',
                ...(parentTurns === 2 ? { sessionID: nativeChildID } : {}),
                description: 'Inspect bounded native scope',
                prompt: 'Perform the requested bounded operation.',
              },
            },
          };
        }
        if (sessionID !== ordinaryID) nativeChildID = sessionID;
        if (emitted.has(sessionID)) return { text: 'Done.' };
        emitted.add(sessionID);
        const target = sessionID === ordinaryID ? ordinaryTarget : deniedTarget;
        return {
          tool: {
            name: 'shell',
            arguments: {
              command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(target)}, 'native-effect')`)}`,
              description: 'Bounded scope side-effect probe',
            },
          },
        };
      },
    });
    const active = await probe.session();
    activeID = active.id;
    await seedNativeActiveScope(probe, active.id, 'PLAN');
    try {
      await probe.prompt(active.id);
    } catch (error) {
      console.error('native-active-scope', probe.output());
      console.error(
        await readFile(join(probe.root, '.local/share/opencode/log/opencode.log'), 'utf8').catch(
          () => 'No fixture host log.',
        ),
      );
      throw error;
    }
    const children = probe.requests.filter((request) => request.sessionID !== active.id);
    expect(children.length, probe.output()).toBeGreaterThan(0);
    const childID = children[0]!.sessionID;
    expect((await probe.client.session.get({ sessionID: childID })).agent).toBe('explore');
    const parentHistory = await probe.client.session.context({ sessionID: active.id });
    const delegations = parentHistory
      .flatMap((message) => (message.type === 'assistant' ? message.content : []))
      .filter(
        (part): part is SessionMessageAssistantTool =>
          part.type === 'tool' && part.name === 'subagent',
      );
    expect(
      delegations.map((part) => part.state.status),
      JSON.stringify(parentHistory),
    ).toEqual(['completed', 'completed']);
    const history = await probe.client.session.context({ sessionID: childID });
    const childTools = history
      .flatMap((message) => (message.type === 'assistant' ? message.content : []))
      .filter((part) => part.type === 'tool');
    expect(childTools, JSON.stringify(history)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'shell',
          state: expect.objectContaining({ status: 'error' }),
        }),
      ]),
    );
    expect(JSON.stringify(childTools)).toContain('HOST_TOOL_PHASE_DENIED');
    await expect(access(deniedTarget)).rejects.toHaveProperty('code', 'ENOENT');
    await probe.restart('SIGKILL');
    // No fixture re-seeding after restart: the product must restore the same
    // committed journal/generation and its productive catalogue itself.
    await probe.prompt(active.id, 'Reply without further tools in the existing scope.');
    const ordinary = await probe.session();
    ordinaryID = ordinary.id;
    await probe.prompt(ordinary.id);
    await expect(access(ordinaryTarget)).resolves.toBeUndefined();
    for (const request of probe.requests) {
      const tools = request.body.tools as Array<{ function: { name: string } }>;
      const names = tools.map((tool) => tool.function.name);
      if (request.sessionID === active.id) expect(names).toContain('flowguard_plan');
      else
        expect(
          names.filter((name) => name.startsWith('flowguard_') && name !== 'flowguard_help'),
        ).toEqual([]);
    }
    expect(probe.errors).toEqual([]);
  }, 180_000);
});
