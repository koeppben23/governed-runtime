/**
 * @module integration/plugin-audit-committed-tip.test
 * @description Audit reconciliation uses only writer-committed chain hashes.
 *
 * @test-policy HAPPY, BAD, CORNER
 */
import { describe, expect, it, vi } from 'vitest';
import { buildStateWriteBody } from '../audit/types.js';
import type { AuditContext } from './plugin-audit-context.js';
import {
  emitAuditBodyWithEvidence,
  type AuditDeps,
  type StrictTimestampTracker,
} from './plugin-audit-reconcile.js';

const TIME = '2026-11-15T12:00:00.000Z';
const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const COMMITTED_HASH = 'a'.repeat(64);

function context(): AuditContext {
  return {
    sessDir: '/unused-audit-dir',
    emitToolCalls: false,
    emitTransitions: true,
    enableChainHash: true,
    actor: 'machine',
    now: TIME,
    prevHash: 'genesis',
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

function body() {
  return buildStateWriteBody({
    flowguardSessionId: SESSION_ID,
    hostSessionId: 'ses_host',
    phase: 'PLAN',
    occurredAt: TIME,
    prevHash: 'genesis',
    detail: {
      operationId: '22222222-2222-4222-8222-222222222222',
      preStateDigest: '1'.repeat(64),
      mutationDigest: '2'.repeat(64),
      postStateDigest: '3'.repeat(64),
    },
  });
}

function tracker(): StrictTimestampTracker {
  return { record: vi.fn(), failure: () => undefined };
}

function auditDeps(
  appendAndTrack: AuditDeps['appendAndTrack'],
  initChain: AuditDeps['initChain'],
): AuditDeps {
  return { appendAndTrack, initChain } as AuditDeps;
}

describe('reconciliation chain tip durability', () => {
  it('BAD: leaves context unchanged if the append fails', async () => {
    const append = vi.fn(async () => {
      throw new Error('simulated audit write failure');
    });
    const init = vi.fn(async () => COMMITTED_HASH);
    const ctx = context();
    await expect(
      emitAuditBodyWithEvidence({
        deps: auditDeps(append, init),
        ctx,
        sessionId: 'ses_host',
        body: body(),
        eventKind: 'state_write',
        localTimestamp: TIME,
        timestampTracker: tracker(),
      }),
    ).rejects.toThrow('simulated audit write failure');

    expect(ctx.prevHash).toBe('genesis');
    expect(init).not.toHaveBeenCalled();
  });

  it('HAPPY: advances only after append has acknowledged durable evidence', async () => {
    const append = vi.fn(async () => undefined);
    const init = vi.fn(async () => {
      expect(append).toHaveBeenCalledOnce();
      return COMMITTED_HASH;
    });
    const ctx = context();
    await emitAuditBodyWithEvidence({
      deps: auditDeps(append, init),
      ctx,
      sessionId: 'ses_host',
      body: body(),
      eventKind: 'state_write',
      localTimestamp: TIME,
      timestampTracker: tracker(),
    });

    expect(ctx.prevHash).toBe(COMMITTED_HASH);
    expect(init).toHaveBeenCalledWith('/unused-audit-dir', 'ses_host');
  });

  it('CORNER: an unavailable committed chain tip fails closed', async () => {
    const append = vi.fn(async () => undefined);
    const init = vi.fn(async () => {
      throw new Error('cannot load committed chain hash');
    });
    const ctx = context();
    await expect(
      emitAuditBodyWithEvidence({
        deps: auditDeps(append, init),
        ctx,
        sessionId: 'ses_host',
        body: body(),
        eventKind: 'state_write',
        localTimestamp: TIME,
        timestampTracker: tracker(),
      }),
    ).rejects.toThrow('cannot load committed chain hash');
    expect(ctx.prevHash).toBe('genesis');
  });
});
