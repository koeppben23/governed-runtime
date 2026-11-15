/**
 * @module persistence-audit-clone.test
 * @description CoW snapshot preparation preserves canonical atomic audit behavior.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    copyFile: vi.fn((...args: Parameters<typeof actual.copyFile>) => actual.copyFile(...args)),
    rename: vi.fn((...args: Parameters<typeof actual.rename>) => actual.rename(...args)),
  };
});

import { auditPath } from './persistence.js';
import { appendAuditEvent, readAuditTrail } from './persistence-audit.js';
import { verifyChain } from '../audit/integrity.js';
import type { AuditEventBody } from '../state/evidence.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

function body(): AuditEventBody {
  return {
    id: randomUUID(),
    flowguardSessionId: SESSION_ID,
    hostSessionId: 'ses_host',
    phase: 'PLAN',
    event: 'transition:PLAN_READY',
    occurredAt: '2026-11-15T12:00:00.000Z',
    actor: 'machine',
    detail: { kind: 'transition', from: 'TICKET', to: 'PLAN' },
  };
}

describe('durable clone-append audit writer', () => {
  let dir: string;
  let actual: typeof fs;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-audit-clone-'));
    actual = await vi.importActual<typeof fs>('node:fs/promises');
    vi.mocked(fs.copyFile).mockImplementation((...args) => actual.copyFile(...args));
    vi.mocked(fs.rename).mockImplementation((...args) => actual.rename(...args));
  });

  afterEach(async () => {
    vi.mocked(fs.copyFile).mockReset();
    vi.mocked(fs.rename).mockReset();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('HAPPY: clone path preserves v3 ordering and chain integrity', async () => {
    const first = await appendAuditEvent(dir, body());
    vi.mocked(fs.copyFile).mockImplementationOnce(async (src, dest) => {
      await actual.copyFile(src, dest);
    });
    const second = await appendAuditEvent(dir, body());

    expect(fs.copyFile).toHaveBeenCalledOnce();
    const trail = await readAuditTrail(dir);
    expect(trail.map((event) => event.id)).toEqual([first.id, second.id]);
    expect(verifyChain(trail).valid).toBe(true);
  });

  it('BAD: unexpected clone I/O failure leaves durable evidence unchanged', async () => {
    await appendAuditEvent(dir, body());
    const original = await fs.readFile(auditPath(dir), 'utf8');
    vi.mocked(fs.copyFile).mockRejectedValueOnce(
      Object.assign(new Error('disk I/O failed'), { code: 'EIO' }),
    );
    await expect(appendAuditEvent(dir, body())).rejects.toMatchObject({
      code: 'WRITE_FAILED',
    });
    expect(await fs.readFile(auditPath(dir), 'utf8')).toBe(original);
  });

  it('CORNER: unsupported reflink falls back to atomic rewrite', async () => {
    await appendAuditEvent(dir, body());
    vi.mocked(fs.copyFile).mockRejectedValueOnce(
      Object.assign(new Error('no reflink'), { code: 'EOPNOTSUPP' }),
    );
    await appendAuditEvent(dir, body());
    const trail = await readAuditTrail(dir);
    expect(trail).toHaveLength(2);
    expect(verifyChain(trail).valid).toBe(true);
  });

  it('EDGE: rename failure preserves original file and cleans clone temp', async () => {
    await appendAuditEvent(dir, body());
    const original = await fs.readFile(auditPath(dir), 'utf8');
    vi.mocked(fs.copyFile).mockImplementationOnce(async (src, dest) => {
      await actual.copyFile(src, dest);
    });
    vi.mocked(fs.rename).mockRejectedValueOnce(
      Object.assign(new Error('atomic rename failed'), { code: 'EIO' }),
    );
    await expect(appendAuditEvent(dir, body())).rejects.toMatchObject({
      code: 'WRITE_FAILED',
    });
    expect(await fs.readFile(auditPath(dir), 'utf8')).toBe(original);
    expect((await fs.readdir(dir)).some((entry) => entry.endsWith('.tmp'))).toBe(false);
  });
});
