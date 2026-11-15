/**
 * @module adapters-audit-session-isolation.test
 * @description Prevent cross-session evidence contamination in canonical audit writes.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE.
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyChain } from '../audit/integrity.js';
import { computeChainHash } from '../audit/types.js';
import type { AuditEventBody } from '../state/evidence.js';
import { auditPath } from './persistence.js';
import {
  appendAuditEvent,
  appendAuditEventAlreadyLocked,
  readAuditTrail,
  withAuditTrailLock,
} from './persistence-audit.js';

const SESSION_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const FOREIGN_ID = 'bbbbbbbb-0000-4000-8000-000000000002';
const OCCURRED_AT = '2026-11-15T12:00:00.000Z';

function event(flowguardSessionId: string = SESSION_ID): AuditEventBody {
  return {
    id: randomUUID(),
    flowguardSessionId,
    hostSessionId: 'ses_host_test',
    phase: 'PLAN',
    event: 'transition:PLAN_READY',
    occurredAt: OCCURRED_AT,
    actor: 'machine',
    detail: { kind: 'transition', from: 'TICKET', to: 'PLAN' },
  };
}

describe('canonical audit session identity binding', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-audit-session-isolation-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('HAPPY: accepts same-session events and idempotent replay', async () => {
    const first = event();
    const persisted = await appendAuditEvent(dir, first);
    await appendAuditEvent(dir, event());
    const retried = await appendAuditEvent(dir, first);
    const trail = await readAuditTrail(dir);
    expect(retried).toEqual(persisted);
    expect(trail).toHaveLength(2);
    expect(verifyChain(trail, { expectedFlowguardSessionId: SESSION_ID }).valid).toBe(true);
  });

  it('BAD: rejects foreign-session append without modifying a valid trail', async () => {
    await appendAuditEvent(dir, event());
    const file = auditPath(dir);
    const before = await fs.readFile(file, 'utf8');
    await expect(appendAuditEvent(dir, event(FOREIGN_ID))).rejects.toMatchObject({
      code: 'CHAIN_BREAK',
    });
    expect(await fs.readFile(file, 'utf8')).toBe(before);
  });

  it('CORNER: foreign-session event cannot masquerade as an idempotent retry', async () => {
    const original = event();
    await appendAuditEvent(dir, original);
    const file = auditPath(dir);
    const before = await fs.readFile(file, 'utf8');
    await expect(
      appendAuditEvent(dir, { ...original, flowguardSessionId: FOREIGN_ID }),
    ).rejects.toMatchObject({ code: 'CHAIN_BREAK' });
    expect(await fs.readFile(file, 'utf8')).toBe(before);
  });

  it('EDGE: refuses previously mixed-session history with valid positional hashes', async () => {
    const foreignDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-audit-foreign-'));
    try {
      const first = await appendAuditEvent(dir, event());
      const second = await appendAuditEvent(foreignDir, event(FOREIGN_ID));
      const { chainHash: _originalHash, ...rest } = second;
      const rethreaded = {
        ...rest,
        prevHash: first.chainHash,
        auditSequence: 2,
      };
      const forged = {
        ...rethreaded,
        chainHash: computeChainHash(first.chainHash, rethreaded),
      };
      const file = auditPath(dir);
      const mixed = [JSON.stringify(first), JSON.stringify(forged)].join('\n') + '\n';
      await fs.writeFile(file, mixed, 'utf8');

      expect(verifyChain([first, forged]).valid).toBe(false);
      await expect(appendAuditEvent(dir, event())).rejects.toMatchObject({
        code: 'CHAIN_BREAK',
      });
      expect(await fs.readFile(file, 'utf8')).toBe(mixed);
    } finally {
      await fs.rm(foreignDir, { recursive: true, force: true });
    }
  });

  it('EDGE: caller-held audit lock enforces the same session isolation', async () => {
    await appendAuditEvent(dir, event());
    const file = auditPath(dir);
    const before = await fs.readFile(file, 'utf8');
    await expect(
      withAuditTrailLock(dir, () => appendAuditEventAlreadyLocked(dir, event(FOREIGN_ID))),
    ).rejects.toMatchObject({ code: 'CHAIN_BREAK' });
    expect(await fs.readFile(file, 'utf8')).toBe(before);
  });
});
