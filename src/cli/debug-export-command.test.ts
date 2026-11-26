/**
 * @module cli/debug-export-command.test
 * @description CLI boundary for the read-only diagnostic snapshot.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createTestWorkspace, type TestWorkspace } from '../integration/test-helpers.js';
import { initWorkspace } from '../adapters/workspace/index.js';
import { writeState } from '../adapters/persistence.js';
import { BINDING, makeState } from '../fixtures.js';
import {
  debugExportMain,
  getDebugExportUsage,
  parseDebugExportArgs,
} from './debug-export-command.js';

const HOST_SESSION_ID = 'ses_cli_test';
const STATE_ID = '00000000-0000-4000-8000-000000000201';

let ws: TestWorkspace;
let originalCwd: string;

beforeEach(async () => {
  ws = await createTestWorkspace();
  originalCwd = process.cwd();
  process.chdir(ws.tmpDir);
});
afterEach(async () => {
  process.chdir(originalCwd);
  await ws.cleanup();
});

async function createRootState(): Promise<void> {
  const { sessionDir, fingerprint } = await initWorkspace(ws.tmpDir, HOST_SESSION_ID);
  await writeState(
    sessionDir,
    makeState('READY', {
      id: STATE_ID,
      flowguardSessionId: STATE_ID,
      binding: { ...BINDING, hostSessionId: HOST_SESSION_ID, worktree: ws.tmpDir, fingerprint },
    }),
  );
  const logDir = path.join(ws.tmpDir, '.opencode', 'logs');
  await mkdir(logDir, { recursive: true });
  await writeFile(
    path.join(logDir, 'flowguard-2026-01-01.log'),
    `${JSON.stringify({
      ts: '2026-01-01T00:00:00.000Z',
      level: 'info',
      service: 'flowguard',
      sessionId: HOST_SESSION_ID,
      traceId: 'trace-cli',
      message: 'cli diagnostic',
      fields: { phase: 'READY' },
    })}\n`,
  );
}

describe('debug-export CLI', () => {
  describe('HAPPY — parsing and successful export', () => {
    it('defaults to basic redaction and host capture enabled', () => {
      const parsed = parseDebugExportArgs(['--session', HOST_SESSION_ID]);
      expect(parsed).toEqual({
        kind: 'ok',
        value: {
          sessionId: HOST_SESSION_ID,
          includeHost: true,
          redaction: 'basic',
          limits: {
            maxSessions: 100,
            maxDiscoveryNodes: 250,
            maxFileBytes: 16 * 1024 * 1024,
            maxTotalBytes: 64 * 1024 * 1024,
            hostTimeoutMs: 60_000,
            maxDurationMs: 120_000,
          },
          json: false,
        },
      });
    });

    it('writes a snapshot through the CLI and reports success', async () => {
      await createRootState();
      const outputDir = path.join(ws.tmpDir, 'cli-diag');

      const code = await debugExportMain([
        '--session',
        HOST_SESSION_ID,
        '--no-host',
        '--out',
        outputDir,
      ]);

      expect(code).toBe(0);
      const manifest = JSON.parse(await readFile(path.join(outputDir, 'manifest.json'), 'utf8'));
      expect(manifest.captureId).toMatch(/^[0-9a-f-]{36}$/);
      expect(manifest.status).toBe('COMPLETE');
    });
  });

  describe('BAD — missing or conflicting arguments are rejected', () => {
    it('requires a session id', () => {
      const parsed = parseDebugExportArgs([]);
      expect(parsed).toMatchObject({ kind: 'error' });
      if (parsed.kind === 'error') expect(parsed.error).toContain('--session');
    });

    it('rejects unknown options', () => {
      const parsed = parseDebugExportArgs(['--session', HOST_SESSION_ID, '--upload']);
      expect(parsed).toMatchObject({ kind: 'error' });
    });

    it('rejects a non-positive numeric limit', () => {
      const parsed = parseDebugExportArgs(['--session', HOST_SESSION_ID, '--max-sessions', '0']);
      expect(parsed).toMatchObject({ kind: 'error' });
    });

    it('accepts explicit total-size and duration budgets', () => {
      const parsed = parseDebugExportArgs([
        '--session',
        HOST_SESSION_ID,
        '--max-total-bytes',
        '200000',
        '--max-duration-ms',
        '5000',
        '--max-discovery-nodes',
        '25',
      ]);
      expect(parsed).toMatchObject({
        kind: 'ok',
        value: {
          limits: { maxTotalBytes: 200000, maxDurationMs: 5000, maxDiscoveryNodes: 25 },
        },
      });
    });
  });

  describe('CORNER — explicit raw mode and help', () => {
    it('treats --raw as explicit no-redaction mode', () => {
      const parsed = parseDebugExportArgs(['--session', HOST_SESSION_ID, '--raw']);
      expect(parsed).toMatchObject({ kind: 'ok', value: { redaction: 'none' } });
    });

    it('rejects --raw combined with an explicit redacted mode', () => {
      const parsed = parseDebugExportArgs([
        '--session',
        HOST_SESSION_ID,
        '--redaction',
        'basic',
        '--raw',
      ]);
      expect(parsed).toMatchObject({ kind: 'error' });
    });

    it('returns help without requiring a session', () => {
      expect(parseDebugExportArgs(['--help'])).toEqual({ kind: 'help' });
      expect(getDebugExportUsage()).toContain('flowguard debug-export');
    });
  });

  describe('EDGE — existing output is never overwritten', () => {
    it('returns a failure code for an existing output directory', async () => {
      await createRootState();
      const outputDir = path.join(ws.tmpDir, 'cli-existing');
      const first = await debugExportMain([
        '--session',
        HOST_SESSION_ID,
        '--no-host',
        '--out',
        outputDir,
      ]);
      const second = await debugExportMain([
        '--session',
        HOST_SESSION_ID,
        '--no-host',
        '--out',
        outputDir,
      ]);
      expect(first).toBe(0);
      expect(second).toBe(1);
    });
  });
});
