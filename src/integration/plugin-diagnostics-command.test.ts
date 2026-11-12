/**
 * @module integration/plugin-diagnostics-command.test
 * @description Native `/diagnostics` is portable, read-only and available
 * without ACTIVE governance.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

import { FlowGuardAuditPlugin } from './plugin.js';
import { createV2Host } from './opencode-v2-test-helpers.js';
import { createTestWorkspace, type TestWorkspace } from './test-helpers.js';

let ws: TestWorkspace;
let host: ReturnType<typeof createV2Host>;
const disposers: Array<() => Promise<void>> = [];

beforeEach(async () => {
  ws = await createTestWorkspace();
  host = createV2Host(ws.tmpDir);
});
afterEach(async () => {
  try {
    for (const dispose of disposers.splice(0).reverse()) await dispose();
  } finally {
    vi.restoreAllMocks();
    await ws.cleanup();
  }
});

async function open(): Promise<void> {
  const cleanup = await FlowGuardAuditPlugin.setup(host.ctx);
  if (!cleanup) throw new Error('Expected plugin cleanup');
  disposers.push(async () => {
    await cleanup();
  });
}

describe('native /diagnostics', () => {
  it('registers the read-only view command before governance activation', async () => {
    await open();
    expect([...host.commands.keys()]).toContain('diagnostics');
    const sessionId = randomUUID();

    await host.command('diagnostics', sessionId, 'explorer');

    const report = (await host.presentation(sessionId)).events.at(-1);
    expect(report).toMatchObject({
      kind: 'report',
      message: expect.stringContaining('FlowGuard Session Explorer'),
    });
    expect(report?.message).toContain('Read-only diagnostic projection');
    expect(host.prompt).not.toHaveBeenCalled();
  });

  it('renders the review shell and the explicit unsupported notification report', async () => {
    await open();
    const sessionId = randomUUID();

    await host.command('diagnostics', sessionId, 'review');
    expect((await host.presentation(sessionId)).events.at(-1)?.message).toContain(
      'No reviewable subject recorded',
    );

    await host.command('diagnostics', sessionId, 'notifications');
    expect((await host.presentation(sessionId)).events.at(-1)?.message).toContain(
      'No toast, panel, notification or governance action was attempted.',
    );
    expect(host.prompt).not.toHaveBeenCalled();
  });

  it('renders the bounded log view against the existing file sink location', async () => {
    await open();
    const sessionId = randomUUID();

    await host.command('diagnostics', sessionId, 'logs');

    const report = (await host.presentation(sessionId)).events.at(-1);
    expect(report?.message).toContain('FlowGuard Diagnostic Log View');
    expect(report?.message).toContain('No logger, log file or persistent view state was created');
    expect(host.prompt).not.toHaveBeenCalled();
  });

  it('rejects an unknown mode or filter with a typed usage error', async () => {
    await open();
    const sessionId = randomUUID();

    await host.command('diagnostics', sessionId, 'unknown-mode');
    expect((await host.presentation(sessionId)).events.at(-1)?.message).toContain(
      'Unknown diagnostics mode',
    );

    await host.command('diagnostics', sessionId, 'logs level=loud');
    expect((await host.presentation(sessionId)).events.at(-1)?.message).toContain(
      'Unknown log level',
    );
    expect(host.prompt).not.toHaveBeenCalled();
  });
});
