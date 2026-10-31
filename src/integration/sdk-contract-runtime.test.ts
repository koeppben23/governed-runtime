/** Execute actual native registrations, not test-local replicas of SDK schemas. */
import { afterEach, describe, expect, it } from 'vitest';
import { FlowGuardAuditPlugin } from './plugin.js';
import { createV2Host, v2ToolEvent } from './opencode-v2-test-helpers.js';
import { canonicalBinding, createTestWorkspace } from './test-helpers.js';
import { makeState } from '../fixtures.js';
import { writeState } from '../adapters/persistence.js';
import { sessionDir } from '../adapters/workspace/index.js';
import { randomUUID } from 'node:crypto';

const disposers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});
async function fixture() {
  const ws = await createTestWorkspace();
  disposers.push(ws.cleanup);
  const sessionID = randomUUID();
  const binding = await canonicalBinding(ws.tmpDir, sessionID);
  await writeState(sessionDir(binding.fingerprint, sessionID), makeState('TICKET', { binding }));
  const host = createV2Host(ws.tmpDir);
  const dispose = await FlowGuardAuditPlugin.setup(host.ctx);
  if (dispose) disposers.push(dispose);
  return { host, sessionID };
}

describe('native V2 runtime boundary contracts', () => {
  it('executes read input and preserves native rich content, including file attachments', async () => {
    const h = await fixture();
    const event = v2ToolEvent({ sessionID: h.sessionID, input: { filePath: 'README.md' } });
    await h.host.before(event);
    const result = {
      content: [
        { type: 'text', text: 'read' },
        { type: 'file', uri: 'file:///artifact', mime: 'text/plain' },
      ],
      metadata: { native: true },
    };
    const completed = { ...event, status: 'completed', result };
    await h.host.after(completed);
    expect(completed.result).toBe(result);
  });

  it.each([null, undefined, 1, 'input', []])(
    'rejects non-object tool input before execution: %j',
    async (input) => {
      const h = await fixture();
      await expect(h.host.before(v2ToolEvent({ sessionID: h.sessionID, input }))).rejects.toThrow(
        'governed tool input is not an object',
      );
    },
  );

  it('does not accept the removed separate args/output hook contract', async () => {
    const h = await fixture();
    await expect(
      h.host.before({ tool: 'read', sessionID: h.sessionID, callID: 'old', args: {} }),
    ).rejects.toThrow('governed tool input is not an object');
  });

  it('passes rich native input without mutating ordinary tool arguments', async () => {
    const h = await fixture();
    const input = { nested: { deep: { value: [1, 2, 3] } } };
    const event = { ...v2ToolEvent({ sessionID: h.sessionID, input }), futureField: true };
    await h.host.before(event);
    expect(event.input).toBe(input);
    expect(event.futureField).toBe(true);
  });

  it('does not turn error completion into a successful result', async () => {
    const h = await fixture();
    const event = {
      ...v2ToolEvent({ sessionID: h.sessionID, tool: 'flowguard_status', input: {} }),
      status: 'error',
      error: { message: 'native tool failure' },
    };
    await h.host.after(event);
    expect(event).not.toHaveProperty('result');
  });

  it('preserves authoritative rich completions rather than dropping native attachments', async () => {
    const h = await fixture();
    const event = {
      ...v2ToolEvent({ sessionID: h.sessionID, tool: 'flowguard_status', input: {} }),
      status: 'completed',
      result: {
        content: [
          { type: 'text', text: '{}' },
          { type: 'file', uri: 'file:///artifact', mime: 'text/plain' },
        ],
      },
    };
    const original = structuredClone(event.result.content);
    await h.host.after(event);
    expect(event.result.content).toEqual(original);
  });
});
