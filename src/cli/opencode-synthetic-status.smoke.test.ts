/** Actual pinned host: synthetic status admission semantics used by the native
 * command result channel. `resume:false` stays pending; `resume:true` is
 * delivered immediately and starts exactly one turn. */
import { afterEach, describe, expect, it } from 'vitest';
import { createNativeHostProbe } from './opencode-native-test-helpers.js';

const LIVE = process.env.OPENCODE_LIVE === '1' || process.env.FLOWGUARD_OPENCODE_HOST_E2E === '1';
let probe: Awaited<ReturnType<typeof createNativeHostProbe>> | undefined;

afterEach(async () => {
  await probe?.close();
  probe = undefined;
});

async function waitFor(check: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for the host condition.');
}

describe.skipIf(!LIVE)('native synthetic status transport', () => {
  it('keeps resume:false pending and delivers resume:true immediately with one turn', async () => {
    probe = await createNativeHostProbe();

    const pending = await probe.session();
    await probe.client.session.synthetic({
      sessionID: pending.id,
      text: 'FlowGuard: ACTIVE (team, READY)',
      description: 'FlowGuard status',
      resume: false,
    });
    await waitFor(async () => {
      const inbox = await probe!.client.session.inbox.list({ sessionID: pending.id });
      return inbox.some((item) => item.type === 'synthetic');
    });
    expect(await probe.client.session.context({ sessionID: pending.id })).toEqual([]);
    expect(probe.requests).toEqual([]);

    const delivered = await probe.session();
    await probe.client.session.synthetic({
      sessionID: delivered.id,
      text: 'FlowGuard: ACTIVE (team, READY)',
      description: 'FlowGuard status',
      resume: true,
    });
    await waitFor(async () => {
      const history = await probe!.client.session.context({ sessionID: delivered.id });
      return history.some((message) => message.type === 'synthetic');
    });
    const history = await probe.client.session.context({ sessionID: delivered.id });
    expect(history[0]).toMatchObject({
      type: 'synthetic',
      text: 'FlowGuard: ACTIVE (team, READY)',
      description: 'FlowGuard status',
    });
    await waitFor(async () => probe!.requests.length === 1);
    expect(probe.requests).toHaveLength(1);
    expect(probe.errors).toEqual([]);
  }, 120_000);
});
