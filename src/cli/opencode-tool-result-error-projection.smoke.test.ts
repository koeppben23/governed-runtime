/** Real pinned-host contract for error tool-result projection into model messages. */
import { it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { toolResultMismatch } from '../integration/review/dispatch/native-review-initial.js';
import { createNativeHostProbe } from './opencode-native-test-helpers.js';

const LIVE = process.env.OPENCODE_LIVE === '1';

it.skipIf(!LIVE)(
  'the pinned host projects a failed tool as the canonical error envelope',
  async () => {
    let project = '';
    const probe = await createNativeHostProbe({
      plugin: `
export default Plugin.define({ id: 'projection-probe', async setup(ctx) {
  const { appendFileSync } = await import('node:fs');
  const record = value => appendFileSync(ctx.location.directory + '/projection.jsonl', JSON.stringify(value) + '\\n');
  const regs = [];
  regs.push(await ctx.session.hook('context', async event => {
    record({ hook: 'context', sessionID: event.sessionID, messages: event.messages,
      history: await ctx.session.context({ sessionID: event.sessionID }) });
  }));
  return async () => { for (const reg of regs) await reg.dispose(); };
} });
`,
      script: (_body, _sessionID, index) => {
        if (index === 1)
          return {
            tool: { name: 'read', arguments: { path: join(project, 'missing-projection.txt') } },
          };
        return { text: 'done' };
      },
    });
    try {
      project = probe.project;
      const session = await probe.session();
      await probe.prompt(session.id, 'read the missing file');
      const observations = (await readFile(join(probe.project, 'projection.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { messages: unknown; history: unknown });
      const withTool = observations.find((entry) =>
        JSON.stringify(entry.history).includes('missing-projection.txt'),
      );
      expect(withTool).toBeDefined();
      const result = (withTool!.messages as Array<{ content?: Array<Record<string, unknown>> }>)
        .flatMap((message) => message.content ?? [])
        .find((part) => part['type'] === 'tool-result');
      expect(result).toMatchObject({
        result: { type: 'error', value: { error: { type: 'tool.execution' }, content: [] } },
      });
      expect(
        toolResultMismatch(
          withTool!.messages as readonly unknown[],
          withTool!.history as readonly unknown[],
        ),
      ).toBeNull();
    } finally {
      await probe.close();
    }
  },
  120_000,
);
