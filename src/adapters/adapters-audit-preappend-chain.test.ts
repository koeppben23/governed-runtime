/**
 * @module adapters-audit-preappend-chain.test
 * @description Ensure the audit append writer rejects tampered persisted v3 chains.
 *
 * @test-policy BAD, CORNER, EDGE
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FIXED_SESSION_UUID, FIXED_TIME } from '../fixtures.js';
import { verifyChain } from '../audit/integrity.js';
import type { AuditEventBody } from '../state/evidence.js';
import { auditPath } from './persistence.js';
import { appendAuditEvent, readAuditTrail } from './persistence-audit.js';

function makeEvent(): AuditEventBody {
  return {
    id: randomUUID(),
    flowguardSessionId: FIXED_SESSION_UUID,
    hostSessionId: 'ses_host_test',
    phase: 'PLAN',
    event: 'transition:PLAN_READY',
    occurredAt: FIXED_TIME,
    actor: 'machine',
    detail: { kind: 'transition', from: 'TICKET', to: 'PLAN' },
  };
}

describe('fail-closed audit append with a damaged persisted chain', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-audit-integrity-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('BAD: rejects a modified canonical record and retains its exact bytes', async () => {
    await appendAuditEvent(tmpDir, makeEvent());
    const file = auditPath(tmpDir);
    const original = await fs.readFile(file, 'utf-8');
    const event = JSON.parse(original.trim()) as Record<string, unknown>;
    event.occurredAt = new Date(FIXED_TIME).toISOString().replace('00.000Z', '01.000Z');
    const tampered = JSON.stringify(event) + '\n';
    await fs.writeFile(file, tampered, 'utf-8');

    await expect(appendAuditEvent(tmpDir, makeEvent())).rejects.toMatchObject({
      code: 'CHAIN_BREAK',
    });
    expect(await fs.readFile(file, 'utf-8')).toBe(tampered);
  });

  it('CORNER: rejects reordered records without modifying audit evidence', async () => {
    await appendAuditEvent(tmpDir, makeEvent());
    await appendAuditEvent(tmpDir, makeEvent());
    const file = auditPath(tmpDir);
    const original = await fs.readFile(file, 'utf-8');
    const lines = original.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    const reordered = [lines[1], lines[0]].join('\n') + '\n';
    await fs.writeFile(file, reordered, 'utf-8');

    await expect(appendAuditEvent(tmpDir, makeEvent())).rejects.toMatchObject({
      code: 'CHAIN_BREAK',
    });
    expect(await fs.readFile(file, 'utf-8')).toBe(reordered);
  });

  it('EDGE: idempotent retry never bypasses chain verification', async () => {
    const first = makeEvent();
    await appendAuditEvent(tmpDir, first);
    const file = auditPath(tmpDir);
    const original = await fs.readFile(file, 'utf-8');
    const event = JSON.parse(original.trim()) as Record<string, unknown>;
    event.auditSequence = 2;
    const tampered = JSON.stringify(event) + '\n';
    await fs.writeFile(file, tampered, 'utf-8');

    await expect(appendAuditEvent(tmpDir, first)).rejects.toMatchObject({
      code: 'CHAIN_BREAK',
    });
    expect(await fs.readFile(file, 'utf-8')).toBe(tampered);
  });

  it('HAPPY: a valid chain still accepts new events', async () => {
    await appendAuditEvent(tmpDir, makeEvent());
    await appendAuditEvent(tmpDir, makeEvent());
    const events = await readAuditTrail(tmpDir);
    expect(events).toHaveLength(2);
    expect(verifyChain(events).valid).toBe(true);
  });
});
