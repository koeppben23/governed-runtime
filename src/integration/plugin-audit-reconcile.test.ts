/**
 * @module integration/plugin-audit-reconcile.test
 * @description Tests for draining the durable audit outbox.
 *
 * The outbox is the state↔audit binding: an operation is committed inside the
 * same state transaction as the mutation it binds, and reconciliation is what
 * turns that commitment into audit evidence. These tests cover the contract
 * that a committed operation is always drained, independent of audit
 * projection policy.
 *
 * @test-policy CORNER
 * @version v1
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { readState, writeState } from '../adapters/persistence.js';
import { makeState } from '../fixtures.js';
import { reconcilePendingAuditOperations, type AuditDeps } from './plugin-audit.js';
import { writeStateWithArtifactsAndAuditOperations } from './tools/helpers.js';

const SESSION_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const FIXED_DECISION_AT = '2026-05-15T12:00:00.000Z';

let chainSeq = 0;

function makeDeps(overrides: Partial<AuditDeps> = {}): AuditDeps {
  return {
    resolveFingerprint: vi.fn().mockResolvedValue('fp-abc'),
    getSessionDir: vi.fn().mockReturnValue('/tmp/sess-dir'),
    resolveSessionPolicy: vi.fn(),
    initChain: vi.fn().mockResolvedValue('prev-hash-001'),
    invalidateChainState: vi.fn(),
    // Chain-threading contract: appendAndTrack mutates evt.chainHash.
    appendAndTrack: vi.fn(async (evt: Record<string, unknown>) => {
      evt.chainHash = `chain-${String(chainSeq++).padStart(3, '0')}`;
    }),
    nextDecisionSequence: vi.fn().mockResolvedValue(1),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    logError: vi.fn(),
    cachedFingerprint: 'fp-abc',
    mode: 'solo',
    ...overrides,
  };
}

/** A state whose policy suppresses per-transition audit events. */
function noTransitionAudit(phase: 'TICKET' | 'PLAN') {
  const base = makeState(phase, { id: SESSION_ID });
  return makeState(phase, {
    id: SESSION_ID,
    policySnapshot: {
      ...base.policySnapshot,
      audit: { ...base.policySnapshot.audit, emitTransitions: false },
    },
  });
}

describe('reconcilePendingAuditOperations', () => {
  describe('CORNER', () => {
    it('drains a committed state_write operation even when the policy does not emit transitions', async () => {
      // emitTransitions governs the transition projection only. A committed
      // operation is authority: gating the drain on the same flag would strand
      // it forever, leaving the authority mutation with no audit evidence and
      // no recovery path.
      const sessDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-audit-reconcile-'));
      try {
        await writeState(sessDir, noTransitionAudit('TICKET'));
        const next = {
          ...noTransitionAudit('PLAN'),
          transition: {
            from: 'TICKET' as const,
            to: 'PLAN' as const,
            event: 'PLAN_READY' as const,
            at: FIXED_DECISION_AT,
          },
        };
        await writeStateWithArtifactsAndAuditOperations(sessDir, next, [
          { from: 'TICKET', to: 'PLAN', event: 'PLAN_READY', at: FIXED_DECISION_AT },
        ]);

        // Producer: the authority write is bound even with transitions off.
        const pending = await readState(sessDir);
        expect(pending!.pendingAuditOperations).toHaveLength(1);
        expect(pending!.pendingAuditOperations[0]!.kind).toBe('state_write');

        const deps = makeDeps({
          getSessionDir: vi.fn().mockReturnValue(sessDir),
          resolveSessionPolicy: vi.fn().mockResolvedValue({
            policy: {
              audit: { emitToolCalls: false, emitTransitions: false, enableChainHash: true },
              actorClassification: {},
              mode: 'regulated',
              requireHumanGates: true,
            },
            state: pending,
          }),
        });

        // Consumer: the committed operation is actually drained.
        await expect(
          reconcilePendingAuditOperations(deps, SESSION_ID, 'flowguard_plan'),
        ).resolves.toBeUndefined();

        expect(deps.appendAndTrack).toHaveBeenCalledTimes(1);
        const emitted = (deps.appendAndTrack as ReturnType<typeof vi.fn>).mock
          .calls[0]![0] as Record<string, unknown>;
        expect(emitted.event).toBe('state_write');
        expect((emitted.detail as Record<string, unknown>).kind).toBe('state_write');
        expect((await readState(sessDir))!.pendingAuditOperations[0]!.status).toBe('reconciled');

        // Re-running must be idempotent and must not report a transition gap
        // for evidence the policy intentionally suppressed.
        await expect(
          reconcilePendingAuditOperations(deps, SESSION_ID, 'flowguard_plan'),
        ).resolves.toBeUndefined();
        expect(deps.appendAndTrack).toHaveBeenCalledTimes(1);
      } finally {
        await fs.rm(sessDir, { recursive: true, force: true });
      }
    });

    it('does not assert a transition gap when the policy suppressed the transition event', async () => {
      // No pending operations, but state.transition is set. With transitions
      // suppressed the transition event was intentionally never emitted, so
      // the legacy-gap assertion must not fire.
      const sessDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-audit-reconcile-'));
      try {
        const state = {
          ...noTransitionAudit('PLAN'),
          transition: {
            from: 'TICKET' as const,
            to: 'PLAN' as const,
            event: 'PLAN_READY' as const,
            at: FIXED_DECISION_AT,
          },
          pendingAuditOperations: [],
        };
        await writeState(sessDir, state);

        const deps = makeDeps({
          getSessionDir: vi.fn().mockReturnValue(sessDir),
          resolveSessionPolicy: vi.fn().mockResolvedValue({
            policy: {
              audit: { emitToolCalls: false, emitTransitions: false, enableChainHash: true },
              actorClassification: {},
              mode: 'regulated',
              requireHumanGates: true,
            },
            state,
          }),
        });

        await expect(
          reconcilePendingAuditOperations(deps, SESSION_ID, 'flowguard_plan'),
        ).resolves.toBeUndefined();
        expect(deps.appendAndTrack).not.toHaveBeenCalled();
      } finally {
        await fs.rm(sessDir, { recursive: true, force: true });
      }
    });
  });
});
