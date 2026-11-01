/** Component conformance only: host fixture fault injection is not an installed-host proof. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FlowGuardAuditPlugin } from './plugin.js';
import { OpenCodeHostAdapter } from './opencode-host-adapter.js';
import { createV2Host, v2ToolEvent } from './opencode-v2-test-helpers.js';

let root: string | undefined;
let dispose: (() => void | Promise<void>) | undefined;
afterEach(async () => {
  try {
    await dispose?.();
  } finally {
    if (root) await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
    root = undefined;
    dispose = undefined;
  }
});
describe('ungoverned session isolation after native event-stream failure', () => {
  it('does not turn a global event-stream failure into a shell veto for an unstarted session', async () => {
    root = await mkdtemp(join(tmpdir(), 'fg-inactive-stream-'));
    const host = createV2Host(root);
    const log = vi.spyOn(OpenCodeHostAdapter.prototype, 'log').mockImplementation(() => {});
    dispose = (await FlowGuardAuditPlugin.setup(host.ctx)) || undefined;
    host.failEvents(new Error('Injected event-stream fault'));
    await vi.waitFor(() =>
      expect(log).toHaveBeenCalledWith('error', 'V2 event stream unavailable', expect.anything()),
    );
    const input = { command: 'native ungoverned command' };
    const event = v2ToolEvent({ sessionID: 'unstarted-unrelated-session', tool: 'shell', input });
    await expect(host.before(event)).resolves.toBeUndefined();
    expect(event.input).toBe(input);
    expect(input).toEqual({ command: 'native ungoverned command' });
  });
});
