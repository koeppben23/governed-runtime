/**
 * @module integration/plugin-audit-reconciliation-snapshot-integrity.test
 * @description Reject unverified persisted audit evidence even without a new append.
 *
 * @test-policy HAPPY, BAD, CORNER.
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeState } from '../fixtures.js';
import { auditPath, writeState } from '../adapters/persistence.js';
import { appendAuditEvent } from '../adapters/persistence-audit.js';
import type { AuditEventBody } from '../state/evidence.js';
import type { AuditContext } from './plugin-audit-context.js';
import {
  emitTransitionAudits,
  type AuditDeps,
  type StrictTimestampTracker,
} from './plugin-audit-reconcile.js';

const SESSION_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const OCCURRED_AT = '2026-11-15T12:00:00.000Z';
const TRANSITION = {
  from: 'TICKET',
  to: 'PLAN',
  event: 'PLAN_READY',
  at: OCCURRED_AT,
} as const;

function transitionEvent(): AuditEventBody {
  return {
    id: randomUUID(),
    flowguardSessionId: SESSION_ID,
    hostSessionId: 'ses_host_test',
    phase: 'PLAN',
    event: 'transition:PLAN_READY',
    occurredAt: OCCURRED_AT,
    actor: 'machine',
    detail: {
      kind: 'transition',
      from: TRANSITION.from,
      to: TRANSITION.to,
      event: TRANSITION.event,
      autoAdvanced: false,
      chainIndex: 0,
    },
  };
}

function ctx(dir: string): AuditContext {
  return {
    sessDir: dir,
    prevHash: 'genesis',
    emitToolCalls: false,
    emitTransitions: true,
    enableChainHash: true,
    actor: 'machine',
    now: OCCURRED_AT,
    phase: 'PLAN',
    success: true,
    errorMessage: undefined,
    parsed: null,
    timestampAssurance: {
      enabled: false,
      mode: 'local_only',
      strict: false,
      criticalEvents: [],
      ntpDriftThresholdMs: 30_000,
      tsaTimeoutMs: 10_000,
    },
  };
}

const tracker: StrictTimestampTracker = {
  record: () => undefined,
  failure: () => undefined,
};

describe('read-only audit reconciliation chain integrity', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-reconcile-verification-'));
    await writeState(
      dir,
      makeState('PLAN', {
        id: SESSION_ID,
        transition: TRANSITION,
        pendingAuditOperations: [],
      }),
    );
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function reconcile(): Promise<void> {
    await emitTransitionAudits({
      deps: {} as AuditDeps,
      ctx: ctx(dir),
      sessionId: SESSION_ID,
      timestampTracker: tracker,
    });
  }

  it('HAPPY: accepts matching transition evidence in a verified chain', async () => {
    await appendAuditEvent(dir, transitionEvent());
    await expect(reconcile()).resolves.toBeUndefined();
  });

  it('BAD: refuses a matching record whose chain hash was modified', async () => {
    await appendAuditEvent(dir, transitionEvent());
    const file = auditPath(dir);
    const record = JSON.parse((await fs.readFile(file, 'utf8')).trim()) as Record<string, unknown>;
    record.chainHash = '0'.repeat(64);
    const tampered = JSON.stringify(record) + '\n';
    await fs.writeFile(file, tampered);
    await expect(reconcile()).rejects.toMatchObject({ code: 'CHAIN_BREAK' });
    expect(await fs.readFile(file, 'utf8')).toBe(tampered);
  });

  it('CORNER: rejects earlier tampering despite matching final transition', async () => {
    await appendAuditEvent(dir, {
      ...transitionEvent(),
      id: randomUUID(),
      detail: {
        kind: 'transition',
        from: 'READY',
        to: 'TICKET',
        event: 'TICKET_SELECTED',
        autoAdvanced: false,
        chainIndex: 0,
      },
      phase: 'TICKET',
      event: 'transition:TICKET_SELECTED',
      occurredAt: '2026-11-15T11:59:00.000Z',
    });
    await appendAuditEvent(dir, transitionEvent());
    const file = auditPath(dir);
    const lines = (await fs.readFile(file, 'utf8')).trimEnd().split('\n');
    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    first.chainHash = 'f'.repeat(64);
    const tampered = [JSON.stringify(first), lines[1]].join('\n') + '\n';
    await fs.writeFile(file, tampered);
    await expect(reconcile()).rejects.toMatchObject({ code: 'CHAIN_BREAK' });
    expect(await fs.readFile(file, 'utf8')).toBe(tampered);
  });
});
