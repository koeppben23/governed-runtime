/**
 * @module integration/plugin-audit-reconcile-snapshot.test
 * @description Regression: one audit read per multi-operation reconciliation.
 *
 * @test-policy HAPPY, BAD.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { makeState } from '../fixtures.js';
import { readState, writeState } from '../adapters/persistence.js';
import { appendAuditEvent, readAuditTrail } from '../adapters/persistence-audit.js';
import { prepareAuditOperations } from './audit-outbox.js';
import { emitTransitionAudits, type AuditDeps } from './plugin-audit-reconcile.js';
import type { AuditContext } from './plugin-audit-context.js';

vi.mock(import('../adapters/persistence-audit.js'), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, readAuditTrail: vi.fn(actual.readAuditTrail) };
});

const SESSION_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const OCCURRED_AT = '2026-11-15T12:00:00.000Z';

describe('audit outbox reconciliation reads', () => {
  it('HAPPY: drains three operations with one audit JSONL read', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-reconcile-snapshot-'));
    try {
      const state = makeState('PLAN', { id: SESSION_ID });
      const intents = [1, 2, 3].map((number) => ({
        phase: 'PLAN' as const,
        event: 'review:claim_verified',
        occurredAt: OCCURRED_AT,
        detail: { claimId: `claim-${number}` },
      }));
      const committed = prepareAuditOperations(state, state, undefined, intents);
      await writeState(dir, committed);
      let persistedHash = 'genesis';
      const append = vi.fn(async (evt: { chainHash?: string }) => {
        const persisted = await appendAuditEvent(
          dir,
          evt as Parameters<typeof appendAuditEvent>[1],
        );
        persistedHash = persisted.chainHash;
      });
      const deps = {
        appendAndTrack: append,
        initChain: vi.fn(async () => persistedHash),
        log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      } as unknown as AuditDeps;
      const ctx: AuditContext = {
        sessDir: dir,
        emitToolCalls: false,
        prevHash: 'genesis',
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
      vi.mocked(readAuditTrail).mockClear();
      await emitTransitionAudits({
        deps,
        ctx,
        sessionId: SESSION_ID,
        timestampTracker: { record: vi.fn(), failure: () => undefined },
      });
      expect(readAuditTrail).toHaveBeenCalledTimes(1);
      expect(append).toHaveBeenCalledTimes(3);
      expect(
        (await readState(dir))?.pendingAuditOperations.every(
          (operation) => operation.status === 'reconciled',
        ),
      ).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
