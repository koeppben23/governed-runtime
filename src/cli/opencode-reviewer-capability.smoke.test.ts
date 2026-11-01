/** Native agent-parser and real-executor permissions, not reviewer-assurance acceptance. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REVIEWER_AGENT } from '../templates/mandates.js';
import { createNativeHostProbe } from './opencode-native-test-helpers.js';

const LIVE = process.env.OPENCODE_LIVE === '1' || process.env.FLOWGUARD_OPENCODE_HOST_E2E === '1';
const attempted = new Set<string>();
const plugin = `
import { appendFileSync } from 'node:fs';
export default Plugin.define({ id: 'capability-probe', async setup(ctx) {
  await ctx.tool.transform(editor => {
    for (const name of ['flowguard_hydrate', 'flowguard_abort_session', 'mcp__flowguard__hydrate', 'flowguard_observe_repository']) editor.add({ name, description: 'Permission control', options: { codemode: false }, input: { type: 'object', properties: {} }, async execute() {
      appendFileSync(ctx.location.directory + '/observer.jsonl', JSON.stringify({ executed: name }) + '\\n');
      return { content: 'executed' };
    } });
  });
} });`;
describe.skipIf(!LIVE)('OpenCode reviewer capability contract', () => {
  let probe: Awaited<ReturnType<typeof createNativeHostProbe>>;
  beforeAll(async () => {
    probe = await createNativeHostProbe({
      agent: REVIEWER_AGENT,
      plugin,
      script: (body, sessionID) => {
        if (attempted.has(sessionID)) return { text: 'Permission probe done.' };
        attempted.add(sessionID);
        const match = JSON.stringify(body.messages).match(/TRY_TOOL:([a-z_]+)/);
        return match ? { tool: { name: match[1]!, arguments: {} } } : { text: 'Ready' };
      },
    });
  }, 180_000);
  afterAll(async () => {
    await probe?.close();
  });
  it('loads the installed reviewer with resolved FlowGuard deny rules', async () => {
    const { data } = await probe.client.agent.get({
      location: probe.location,
      agentID: 'flowguard-reviewer',
    });
    expect(data).toMatchObject({ id: 'flowguard-reviewer', mode: 'subagent' });
    const deny = data.permissions.findIndex(
      (rule) => rule.action === '*' && rule.resource === '*' && rule.effect === 'deny',
    );
    expect(deny).toBeGreaterThanOrEqual(0);
    expect(data.permissions.slice(deny, deny + 4)).toEqual([
      { action: '*', resource: '*', effect: 'deny' },
      { action: 'read', resource: '*', effect: 'allow' },
      { action: 'flowguard_observe_repository', resource: '*', effect: 'allow' },
      { action: 'mcp__flowguard__flowguard_observe_repository', resource: '*', effect: 'allow' },
    ]);
  });
  it('removes direct and MCP-prefixed FlowGuard tools from the reviewer', async () => {
    for (const name of [
      'flowguard_hydrate',
      'flowguard_abort_session',
      'mcp__flowguard__hydrate',
      'subagent',
    ]) {
      const session = await probe.session('flowguard-reviewer');
      await probe.prompt(session.id, `TRY_TOOL:${name}`);
      const request = probe.requests.find((request) => request.sessionID === session.id)!;
      const tools = request.body.tools as Array<{ function?: { name: string } }>;
      expect(tools.some((tool) => tool.function?.name === name)).toBe(false);
      const history = await probe.client.session.context({ sessionID: session.id });
      expect(
        history.some(
          (message) =>
            message.type === 'assistant' &&
            message.content.some(
              (part) => part.type === 'tool' && part.name === name && part.state.status === 'error',
            ),
        ),
      ).toBe(true);
    }
  });
  it('carves out the sanctioned observation tool from the deny rules', async () => {
    const session = await probe.session('flowguard-reviewer');
    await probe.prompt(session.id, 'TRY_TOOL:flowguard_observe_repository');
    const entries = await probe.entries();
    expect(entries).toEqual([{ executed: 'flowguard_observe_repository' }]);
    expect(probe.errors).toEqual([]);
  });
});
