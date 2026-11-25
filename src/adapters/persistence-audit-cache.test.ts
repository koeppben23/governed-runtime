/**
 * @module adapters/persistence-audit-cache.test
 * @description In-process append-proof lifecycle and bounded cache retention.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendAuditEvent,
  auditAppendCacheForTests,
  readAuditTrail,
  resetAuditAppendCacheForTests,
} from './persistence-audit.js';
import { AUDIT_ID_FILTER_BYTES } from './persistence-audit-id-filter.js';
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
  resetAuditAppendCacheForTests();
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
    const trail = await fs.open(auditPath(dir), 'r+');
    try {
      const before = await trail.stat();
      const raw = await trail.readFile('utf8');
      const event = JSON.parse(raw.trim()) as Record<string, unknown>;
      const chainHash = String(event['chainHash']);
      event['chainHash'] = `${chainHash.charAt(0) === 'a' ? 'b' : 'a'}${chainHash.slice(1)}`;
      const tampered = Buffer.from(`${JSON.stringify(event)}\n`, 'utf8');
      expect(tampered.length).toBe(before.size);
      const { bytesWritten } = await trail.write(tampered, 0, tampered.length, 0);
      expect(bytesWritten).toBe(tampered.length);
      await trail.utimes(before.atime, before.mtime);
    } finally {
      await trail.close();
    }

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
    expect(auditAppendCacheForTests(dir)?.idFilterBytes).toBe(AUDIT_ID_FILTER_BYTES);

    await appendAuditEvent(dir, body());
    expect(auditAppendCacheForTests(dir)?.appendsSinceVerify).toBe(1);
    expect(auditAppendCacheForTests(dir)?.idFilterBytes).toBe(AUDIT_ID_FILTER_BYTES);
  }, 30_000);

  it('retains fixed-size id membership even after a long history', async () => {
    const first = body();
    await appendAuditEvent(dir, first);
    for (let index = 0; index < 300; index++) await appendAuditEvent(dir, body());

    expect(auditAppendCacheForTests(dir)?.idFilterBytes).toBe(AUDIT_ID_FILTER_BYTES);
    // A filter hit (real duplicate or false positive) must still replay exactly.
    await expect(appendAuditEvent(dir, first)).resolves.toMatchObject({ id: first.id });
    expect(await readAuditTrail(dir)).toHaveLength(301);
  }, 30_000);

  it('forces a full verification only after the time window elapses', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      await appendAuditEvent(dir, body());
      expect(auditAppendCacheForTests(dir)?.appendsSinceVerify).toBe(1);

      clock.mockReturnValue(1_060_000);
      await appendAuditEvent(dir, body());
      expect(auditAppendCacheForTests(dir)?.appendsSinceVerify).toBe(2);

      clock.mockReturnValue(1_060_001);
      await appendAuditEvent(dir, body());
      expect(auditAppendCacheForTests(dir)?.appendsSinceVerify).toBe(1);
    } finally {
      clock.mockRestore();
    }
  });

  it('blocks a missing trail through the in-process proof when the marker is also gone', async () => {
    await appendAuditEvent(dir, body());
    await fs.unlink(auditPath(dir));
    await fs.unlink(path.join(dir, '.audit-history'));

    await expect(appendAuditEvent(dir, body())).rejects.toThrow(
      /disappeared after canonical history/i,
    );
  });

  it('clears the proof projection on a simulated restart', async () => {
    await appendAuditEvent(dir, body());
    expect(auditAppendCacheForTests(dir)).toBeDefined();

    resetAuditAppendCacheForTests();
    expect(auditAppendCacheForTests(dir)).toBeUndefined();
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

  it('keeps exactly the configured number of cached sessions', async () => {
    const dirs: string[] = [];
    try {
      for (let index = 0; index < 65; index++) {
        const next = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-audit-cache-exact-'));
        dirs.push(next);
        await appendAuditEvent(next, body());
        if (index === 63) {
          expect(
            dirs.filter((entry) => auditAppendCacheForTests(entry) !== undefined),
          ).toHaveLength(64);
        }
      }
      expect(dirs.filter((entry) => auditAppendCacheForTests(entry) !== undefined)).toHaveLength(
        64,
      );
      expect(auditAppendCacheForTests(dirs[0]!)).toBeUndefined();
    } finally {
      await Promise.all(dirs.map((entry) => fs.rm(entry, { recursive: true, force: true })));
    }
  });
});
