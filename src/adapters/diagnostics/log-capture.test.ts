/**
 * @module adapters/diagnostics/log-capture.test
 * @description Bounded FlowGuard JSONL capture contract.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createTestWorkspace, type TestWorkspace } from '../../integration/test-helpers.js';
import { DiagnosticLogCaptureError, captureLogs } from './log-capture.js';

let ws: TestWorkspace;
let logDir: string;

beforeEach(async () => {
  ws = await createTestWorkspace();
  logDir = path.join(ws.tmpDir, '.opencode', 'logs');
  await mkdir(logDir, { recursive: true });
});
afterEach(async () => {
  await ws.cleanup();
});

function entry(sessionId: string | null, overrides: Record<string, unknown> = {}) {
  return {
    ts: '2026-01-01T00:00:00.000Z',
    level: 'info',
    service: 'flowguard',
    sessionId,
    traceId: sessionId === null ? null : `trace-${sessionId}`,
    message: 'diagnostic entry',
    fields: { phase: 'READY' },
    ...overrides,
  };
}

async function writeLines(name: string, entries: readonly unknown[]): Promise<void> {
  await writeFile(
    path.join(logDir, name),
    `${entries.map((item) => JSON.stringify(item)).join('\n')}\n`,
  );
}

describe('bounded FlowGuard log capture', () => {
  it('captures matching entries from normal and rotated files with source provenance', async () => {
    await writeLines('flowguard-2026-01-01.log', [
      entry('ses_root'),
      entry('ses_child'),
      entry('ses_foreign'),
    ]);
    await writeLines('flowguard-2026-01-01.1.log', [entry('ses_root', { message: 'rotated' })]);

    const result = await captureLogs({
      directory: logDir,
      filter: { sessionIds: ['ses_root', 'ses_child'] },
    });

    expect(result.status).toBe('COMPLETE');
    expect(result.entries.map((item) => item.message)).toEqual(
      expect.arrayContaining(['diagnostic entry', 'rotated']),
    );
    expect(result.entries.every((item) => item.sessionId !== 'ses_foreign')).toBe(true);
    expect(result.entries.every((item) => item.sourceFile.length > 0)).toBe(true);
    expect(result.entries.every((item) => item.sourceLine > 0)).toBe(true);
    expect(result.correlation.withSessionId).toBe(4);
    expect(result.correlation.withoutSessionId).toBe(0);
    expect(result.files).toHaveLength(2);
  });

  it('reports malformed lines and keeps reading valid entries', async () => {
    await writeFile(
      path.join(logDir, 'flowguard-2026-01-01.log'),
      `${JSON.stringify(entry('ses_root'))}\nnot-json\n${JSON.stringify(entry('ses_root'))}\n`,
    );

    const result = await captureLogs({ directory: logDir, filter: { sessionIds: ['ses_root'] } });
    expect(result.status).toBe('PARTIAL');
    expect(result.parseErrors).toBe(1);
    expect(result.entries).toHaveLength(2);
  });

  it('reports missing directories and empty log sets as not verified', async () => {
    const missing = await captureLogs({ directory: path.join(ws.tmpDir, 'missing') });
    expect(missing.status).toBe('NOT_VERIFIED');
    expect(missing.truncationReasons[0]).toContain('missing or unreadable');

    await writeFile(path.join(logDir, 'not-a-flowguard-log.txt'), '{}\n');
    const empty = await captureLogs({ directory: logDir });
    expect(empty.status).toBe('NOT_VERIFIED');
    expect(empty.truncationReasons[0]).toContain('no FlowGuard log files');
  });

  it('reports file, byte and line-budget truncation explicitly', async () => {
    await writeLines('flowguard-2026-01-01.log', [entry('ses_root'), entry('ses_root')]);
    await writeLines('flowguard-2026-01-01.1.log', [entry('ses_root')]);

    const fileLimited = await captureLogs({
      directory: logDir,
      filter: { sessionIds: ['ses_root'] },
      limits: { maxFiles: 1, maxBytes: 10_000, maxLines: 10 },
    });
    expect(fileLimited.status).toBe('PARTIAL');
    expect(fileLimited.filesSkipped).toBe(1);
    expect(fileLimited.skippedFiles).toHaveLength(1);
    expect(fileLimited.truncationReasons.join(' ')).toContain('file budget');

    await writeLines('flowguard-2026-01-02.log', [
      entry('ses_root'),
      entry('ses_root'),
      entry('ses_root'),
    ]);
    const lineLimited = await captureLogs({
      directory: logDir,
      filter: { sessionIds: ['ses_root'] },
      limits: { maxFiles: 10, maxBytes: 10_000, maxLines: 1 },
    });
    expect(lineLimited.status).toBe('PARTIAL');
    expect(lineLimited.entries).toHaveLength(1);
    expect(lineLimited.truncationReasons.join(' ')).toContain('line budget');
  });

  it('reports sessions without entries and uncorrelated entries', async () => {
    await writeLines('flowguard-2026-01-01.log', [
      entry('ses_root'),
      entry(null, { message: 'uncorrelated' }),
    ]);

    const result = await captureLogs({
      directory: logDir,
      filter: { sessionIds: ['ses_root', 'ses_child'] },
    });

    expect(result.correlation.sessionsWithEntries).toBe(1);
    expect(result.correlation.sessionsWithoutEntries).toEqual(['ses_child']);
    expect(result.correlation.withoutSessionId).toBe(1);
    expect(result.status).toBe('PARTIAL');
    expect(result.entries.map((item) => item.sessionId)).toEqual(['ses_root']);
  });

  it('redacts secrets and paths by default but preserves raw mode', async () => {
    await writeLines('flowguard-2026-01-01.log', [
      entry('ses_root', {
        message: 'token=abcdef password=secret at /private/secret/file',
        fields: { token: 'abcdef', authorization: 'Bearer abc', safe: 'ok' },
      }),
    ]);

    const redacted = await captureLogs({ directory: logDir });
    expect(redacted.entries[0]?.message).not.toContain('abcdef');
    expect(redacted.entries[0]?.message).not.toContain('/private/secret');
    expect(redacted.entries[0]?.fields).toMatchObject({
      token: '[REDACTED]',
      authorization: '[REDACTED]',
      safe: 'ok',
    });

    const raw = await captureLogs({ directory: logDir, redact: false });
    expect(raw.entries[0]?.fields).toMatchObject({ token: 'abcdef' });
  });

  it('drops non-technical trace IDs in redacted mode without leaking their content', async () => {
    await writeLines('flowguard-2026-01-01.log', [
      entry('ses_root', {
        traceId: 'token=supersecret/../../private/path',
        message: 'trace redaction probe',
      }),
      entry('ses_root', { traceId: 'trace-valid_1' }),
    ]);

    const redacted = await captureLogs({ directory: logDir });
    expect(redacted.entries[0]?.traceId).toBeNull();
    expect(JSON.stringify(redacted)).not.toContain('supersecret');
    expect(redacted.entries[1]?.traceId).toBe('trace-valid_1');

    const raw = await captureLogs({ directory: logDir, redact: false });
    expect(raw.entries[0]?.traceId).toBe('token=supersecret/../../private/path');
  });

  it('validates filters and limits', async () => {
    await expect(
      captureLogs({ directory: logDir, filter: { levels: ['loud' as never] } }),
    ).rejects.toBeInstanceOf(DiagnosticLogCaptureError);
    await expect(captureLogs({ directory: logDir, limits: { maxFiles: 0 } })).rejects.toMatchObject(
      { code: 'INVALID_LIMIT' },
    );
  });
});
