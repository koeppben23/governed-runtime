/** Actual pinned host: native `/start` through the real plugin command channel.
 * The command is invoked through the SDK, which the host cannot distinguish from
 * operator UI input; the decision is therefore `host_command`, never human proof. */
import { afterEach, describe, expect, it } from 'vitest';
import { realpath } from 'node:fs/promises';
import { createNativeHostProbe, type NativeHostProbe } from './opencode-native-test-helpers.js';
import { resolveSessionAuthority } from '../adapters/session-authority.js';
import { withTestEnv } from '../integration/test-helpers.js';

const LIVE = process.env.OPENCODE_LIVE === '1' || process.env.FLOWGUARD_OPENCODE_HOST_E2E === '1';
let probe: NativeHostProbe | undefined;
let restore: (() => void) | undefined;
afterEach(async () => {
  try {
    await probe?.close();
  } finally {
    restore?.();
    probe = undefined;
    restore = undefined;
  }
});

function productiveTools(request: { body: Record<string, unknown> }): string[] {
  const tools = (request.body.tools ?? []) as Array<{ function?: { name: string } }>;
  return tools
    .map((tool) => tool.function?.name ?? '')
    .filter((name) => name.startsWith('flowguard_') && name !== 'flowguard_help');
}

describe.skipIf(!LIVE)('native /start command on the pinned host', () => {
  it('activates only the invoked root session, survives restart and leaves siblings native', async () => {
    probe = await createNativeHostProbe({ product: true, script: () => ({ text: 'Done.' }) });
    restore = withTestEnv({ OPENCODE_CONFIG_DIR: probe.env.OPENCODE_CONFIG_DIR! });
    const commands = await probe.client.command.list({ location: probe.location });
    expect(commands.data.map((command) => command.name)).toContain('start');

    const governed = await probe.session();
    await probe.prompt(governed.id, 'Before start.');
    expect(productiveTools(probe.requests.at(-1)!)).toEqual([]);
    const before = probe.requests.length;

    await probe.client.session.command({ sessionID: governed.id, name: 'start', text: '' });
    await probe.client.session.wait(
      { sessionID: governed.id },
      { signal: AbortSignal.timeout(120_000) },
    );
    // The non-resuming report must not start a model turn by itself.
    expect(probe.requests.length, probe.output()).toBe(before);
    const authority = await resolveSessionAuthority({
      root: await realpath(probe.project),
      sessionId: governed.id,
    });
    expect(authority.status, probe.output()).toBe('resolved');
    const history = await probe.client.session.context({ sessionID: governed.id });
    expect(JSON.stringify(history)).toContain('FlowGuard governance is ACTIVE');

    await probe.prompt(governed.id, 'After start.');
    expect(productiveTools(probe.requests.at(-1)!)).toContain('flowguard_status');

    await probe.restart('SIGKILL');
    await probe.prompt(governed.id, 'After restart.');
    expect(productiveTools(probe.requests.at(-1)!)).toContain('flowguard_status');

    const sibling = await probe.session();
    await probe.prompt(sibling.id, 'Ordinary sibling.');
    expect(productiveTools(probe.requests.at(-1)!)).toEqual([]);
    expect(probe.errors).toEqual([]);
  }, 300_000);
});
