/**
 * @module integration/plugin-debug-export-command.test
 * @description Native `/debug-export` is available without ACTIVE governance and
 * writes only a read-only, redacted diagnostic snapshot.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

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

async function latestExportDir(): Promise<string> {
  const parent = path.join(ws.tmpDir, '.opencode', 'diagnostics');
  const entries = await readdir(parent, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  expect(directories).toHaveLength(1);
  return path.join(parent, directories[0]!);
}

describe('native /debug-export', () => {
  it('is registered and usable before governance activation', async () => {
    await open();
    expect([...host.commands.keys()]).toContain('debug-export');
    const sessionId = randomUUID();

    await host.command('debug-export', sessionId);

    expect(host.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionID: sessionId,
        text: expect.stringContaining('Diagnostic export: NOT_VERIFIED'),
      }),
    );
    const manifest = JSON.parse(
      await readFile(path.join(await latestExportDir(), 'manifest.json'), 'utf8'),
    );
    expect(manifest.status).toBe('NOT_VERIFIED');
    expect(manifest.boundary.sessionsWithoutState).toBe(1);
  });

  it('captures an ACTIVE session and redacts host text', async () => {
    await open();
    const sessionId = randomUUID();
    host.sessionContext.mockResolvedValue([
      {
        info: { id: 'msg_1', sessionID: sessionId, role: 'user' },
        parts: [
          {
            id: 'part_1',
            sessionID: sessionId,
            messageID: 'msg_1',
            type: 'text',
            text: 'SECRET_REVIEWER_PROMPT',
          },
        ],
      },
    ]);

    await host.command('start', sessionId);
    const logDir = path.join(ws.tmpDir, '.opencode', 'logs');
    await mkdir(logDir, { recursive: true });
    await writeFile(
      path.join(logDir, 'flowguard-2026-01-01.log'),
      `${JSON.stringify({
        ts: '2026-01-01T00:00:00.000Z',
        level: 'info',
        service: 'flowguard',
        sessionId,
        traceId: 'trace-native',
        message: 'native diagnostic',
        fields: { phase: 'READY' },
      })}\n`,
    );
    await host.command('debug-export', sessionId);

    const outputDir = await latestExportDir();
    const manifest = JSON.parse(await readFile(path.join(outputDir, 'manifest.json'), 'utf8'));
    expect(manifest.status).toBe('COMPLETE');
    expect(manifest.boundary.hostHistory).toBe('included');
    expect(manifest.counts.hostMessages).toBe(1);
    const hostTranscript = await readFile(
      path.join(outputDir, 'sessions', sessionId, 'host.transcript.redacted.json'),
      'utf8',
    );
    expect(hostTranscript).toContain('part_1');
    expect(hostTranscript).not.toContain('SECRET_REVIEWER_PROMPT');
    expect(host.prompt).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('This snapshot is diagnostic only.'),
      }),
    );
  });
});
