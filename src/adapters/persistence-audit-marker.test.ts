/**
 * @module adapters/persistence-audit-marker.test
 * @description Crash-consistency contract for the durable audit continuity marker.
 */
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  (globalThis as Record<string, unknown>).__markerFsActual = actual;
  return {
    ...actual,
    rename: vi.fn((...args: Parameters<typeof actual.rename>) => actual.rename(...args)),
  };
});

import { appendAuditEvent } from './persistence-audit.js';
import { ensureAuditHistoryMarker } from './persistence-audit-continuity.js';
import { auditPath, writeState } from './persistence.js';
import { makeState, FIXED_TIME } from '../fixtures.js';
import type { AuditEventBody } from '../state/evidence.js';
import type { SessionState } from '../state/schema.js';

let dir: string;

function body(overrides: Partial<AuditEventBody> = {}): AuditEventBody {
  return {
    id: randomUUID(),
    flowguardSessionId: '11111111-1111-4111-8111-111111111111',
    hostSessionId: 'ses_host',
    phase: 'PLAN',
    event: 'state_write',
    occurredAt: FIXED_TIME,
    actor: 'machine',
    detail: { operationId: randomUUID() },
    ...overrides,
  };
}

function operation(status: 'state_committed' | 'audit_committed' | 'reconciled') {
  return {
    operationId: randomUUID(),
    preStateDigest: 'a'.repeat(64),
    mutationDigest: 'b'.repeat(64),
    postStateDigest: 'c'.repeat(64),
    auditEventDigest: 'd'.repeat(64),
    status,
    kind: 'state_write' as const,
    stateWrite: { phase: 'PLAN' as const, at: FIXED_TIME },
  };
}

function restoreRename(): void {
  const actual = (globalThis as Record<string, unknown>).__markerFsActual as typeof fs;
  vi.mocked(fs.rename).mockImplementation((...args: Parameters<(typeof fs)['rename']>) =>
    actual.rename(...args),
  );
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-audit-marker-'));
  restoreRename();
});

afterEach(async () => {
  restoreRename();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('audit continuity marker', () => {
  it('persists the marker before publishing the first audit record', async () => {
    let observed:
      | { readonly marker: boolean; readonly trail: boolean; readonly sessionDir: string }
      | undefined;
    const subscriber = (message: unknown): void => {
      observed = {
        marker: existsSync(path.join(dir, '.audit-history')),
        trail: existsSync(auditPath(dir)),
        sessionDir: (message as { readonly sessionDir: string }).sessionDir,
      };
    };
    subscribe('flowguard.audit.continuity-marker', subscriber);
    try {
      await appendAuditEvent(dir, body());
    } finally {
      unsubscribe('flowguard.audit.continuity-marker', subscriber);
    }

    expect(observed).toEqual({ marker: true, trail: false, sessionDir: dir });
    expect(existsSync(auditPath(dir))).toBe(true);
  });

  it('does not recreate or republish an existing marker', async () => {
    await fs.writeFile(path.join(dir, '.audit-history'), 'audit-chain.v3\n', 'utf-8');
    let published = false;
    const subscriber = (): void => {
      published = true;
    };
    subscribe('flowguard.audit.continuity-marker', subscriber);
    try {
      await expect(ensureAuditHistoryMarker(dir)).resolves.toEqual({ created: false });
    } finally {
      unsubscribe('flowguard.audit.continuity-marker', subscriber);
    }
    expect(published).toBe(false);
  });

  it('fails closed when a crash leaves the marker without a trail', async () => {
    await fs.writeFile(path.join(dir, '.audit-history'), 'audit-chain.v3\n', 'utf-8');

    await expect(appendAuditEvent(dir, body())).rejects.toThrow(
      /prior history marker exists.*explicit recovery/i,
    );
    expect(existsSync(auditPath(dir))).toBe(false);
  });

  it('removes a freshly created marker when publication fails before the trail exists', async () => {
    const actual = (globalThis as Record<string, unknown>).__markerFsActual as typeof fs;
    let failed = false;
    vi.mocked(fs.rename).mockImplementation((src, dest) => {
      if (!failed && String(dest).endsWith('audit.jsonl')) {
        failed = true;
        return Promise.reject(Object.assign(new Error('injected write fault'), { code: 'EIO' }));
      }
      return actual.rename(src, dest);
    });

    await expect(appendAuditEvent(dir, body())).rejects.toThrow(/durable atomic write failed/i);
    expect(existsSync(path.join(dir, '.audit-history'))).toBe(false);
    expect(existsSync(auditPath(dir))).toBe(false);

    restoreRename();
    await expect(appendAuditEvent(dir, body())).resolves.toMatchObject({ auditSequence: 1 });
    expect(existsSync(path.join(dir, '.audit-history'))).toBe(true);
  });

  it('keeps the marker when a failed publication still leaves audit bytes behind', async () => {
    const actual = (globalThis as Record<string, unknown>).__markerFsActual as typeof fs;
    let failed = false;
    vi.mocked(fs.rename).mockImplementation((src, dest) => {
      if (!failed && String(dest).endsWith('audit.jsonl')) {
        failed = true;
        return actual
          .rename(src, dest)
          .then(() => Promise.reject(Object.assign(new Error('fsync fault'), { code: 'EIO' })));
      }
      return actual.rename(src, dest);
    });

    // The rename committed but the caller observed a failure; the trail exists,
    // so deleting the marker would hide a real history loss on the next start.
    await expect(appendAuditEvent(dir, body())).rejects.toThrow(/durable atomic write failed/i);
    expect(existsSync(auditPath(dir))).toBe(true);
    expect(existsSync(path.join(dir, '.audit-history'))).toBe(true);
  });

  it('refuses a missing trail when state already records audit publication', async () => {
    await writeState(dir, {
      ...makeState('PLAN'),
      pendingAuditOperations: [operation('reconciled')],
    } satisfies SessionState);

    await expect(appendAuditEvent(dir, body())).rejects.toThrow(
      /persisted audit evidence.*explicit recovery/i,
    );
  });

  it('refuses a missing trail anchored by a retired outbox checkpoint', async () => {
    await writeState(dir, {
      ...makeState('PLAN'),
      auditOutboxCheckpoint: {
        version: 1,
        reconciledCount: 33,
        lastOperationId: randomUUID(),
        auditSequence: 33,
        chainHash: 'a'.repeat(64),
        auditEventDigest: 'b'.repeat(64),
      },
    } satisfies SessionState);

    await expect(appendAuditEvent(dir, body())).rejects.toThrow(
      /persisted audit evidence.*explicit recovery/i,
    );
  });

  it('allows a legitimate first append with a state-committed (pre-audit) outbox', async () => {
    await writeState(dir, {
      ...makeState('PLAN'),
      pendingAuditOperations: [operation('state_committed')],
    } satisfies SessionState);

    await expect(appendAuditEvent(dir, body())).resolves.toMatchObject({ auditSequence: 1 });
  });
});
