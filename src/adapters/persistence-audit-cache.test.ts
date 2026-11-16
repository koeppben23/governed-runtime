/**
 * @module adapters/persistence-audit-cache.test
 * @description In-process append-proof lifecycle and bounded cache retention.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendAuditEvent, auditAppendCacheForTests } from './persistence-audit.js';
import { auditPath } from './persistence.js';
import type { AuditEventBody } from '../state/evidence.js';

let dir: string;

function body(overrides: Partial<AuditEventBody> = {}): AuditEventBody {
  return {
    id: randomUUID(),
    flowguardSessionId: '11111111-1111-4111-8111-111111111111',
    hostSessionId: 'ses_host',
    phase: 'PLAN',
    event: 'state_write',
    occurredAt: '2026-11-15T12:00:00.000Z',
    actor: 'machine',
    detail: { operationId: randomUUID() },
    ...overrides,
  };
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-audit-cache-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('audit append proof cache', () => {
  it('reuses the proof across appends and refreshes it after each event', async () => {
    await appendAuditEvent(dir, body());
    expect(auditAppendCacheForTests(dir)).toMatchObject({
      lastSequence: 1,
      appendsSinceVerify: 1,
    });

    await appendAuditEvent(dir, body());
    expect(auditAppendCacheForTests(dir)).toMatchObject({
      lastSequence: 2,
      appendsSinceVerify: 2,
    });
  });

  it('detects content tampering even when size and mtime are restored', async () => {
    await appendAuditEvent(dir, body());
    const filePath = auditPath(dir);
    const before = await fs.stat(filePath);
    const raw = await fs.readFile(filePath, 'utf8');
    const event = JSON.parse(raw.trim()) as Record<string, unknown>;
    const chainHash = String(event['chainHash']);
    event['chainHash'] = `${chainHash.charAt(0) === 'a' ? 'b' : 'a'}${chainHash.slice(1)}`;
    await fs.writeFile(filePath, `${JSON.stringify(event)}\n`, 'utf8');
    await fs.utimes(filePath, before.atime, before.mtime);

    await expect(appendAuditEvent(dir, body())).rejects.toThrow(/invalid audit chain/i);
  });

  it('clears the proof when an append fails', async () => {
    const first = body();
    await appendAuditEvent(dir, first);
    expect(auditAppendCacheForTests(dir)).toBeDefined();

    await expect(appendAuditEvent(dir, { ...first, event: 'state_write:forged' })).rejects.toThrow(
      /duplicate id/i,
    );
    expect(auditAppendCacheForTests(dir)).toBeUndefined();
  });

  it('forces a full verification after the bounded append window', async () => {
    for (let index = 0; index < 256; index++) await appendAuditEvent(dir, body());
    expect(auditAppendCacheForTests(dir)?.appendsSinceVerify).toBe(256);

    await appendAuditEvent(dir, body());
    expect(auditAppendCacheForTests(dir)?.appendsSinceVerify).toBe(1);
  });

  it('forces a full verification after the time window', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      await appendAuditEvent(dir, body());
      expect(auditAppendCacheForTests(dir)?.appendsSinceVerify).toBe(1);

      clock.mockReturnValue(1_061_000);
      await appendAuditEvent(dir, body());
      expect(auditAppendCacheForTests(dir)?.appendsSinceVerify).toBe(1);
    } finally {
      clock.mockRestore();
    }
  });

  it('bounds the number of retained session proofs', async () => {
    const dirs: string[] = [];
    try {
      for (let index = 0; index < 70; index++) {
        const next = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-audit-cache-cap-'));
        dirs.push(next);
        await appendAuditEvent(next, body());
      }
      expect(auditAppendCacheForTests(dirs[0]!)).toBeUndefined();
      expect(auditAppendCacheForTests(dirs.at(-1)!)).toBeDefined();
    } finally {
      await Promise.all(dirs.map((entry) => fs.rm(entry, { recursive: true, force: true })));
    }
  });
});
