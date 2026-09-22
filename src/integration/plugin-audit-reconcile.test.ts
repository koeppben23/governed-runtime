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
import { appendAuditEvent, readAuditTrail } from '../adapters/persistence-audit.js';
import { makeState, REVIEW_APPROVE } from '../fixtures.js';
import { reconcilePendingAuditOperations, type AuditDeps } from './plugin-audit.js';
import { TOOL_FLOWGUARD_HYDRATE } from './tool-names.js';
import { writeStateWithArtifactsAndAuditOperations } from './tools/helpers.js';
import { prepareAuditOperations } from './audit-outbox.js';
import { buildDecisionAuditIntent } from './services/decision-audit-intent.js';

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

    it('replays a semantic review event after a state-only crash and acknowledges an already-appended retry without duplication', async () => {
      const sessDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-semantic-reconcile-'));
      try {
        const previous = makeState('PLAN', { id: SESSION_ID });
        // A repeated blocked-review failure is auditworthy despite its idempotent
        // authority projection. The semantic operation must still drain safely.
        const next = previous;
        const committed = prepareAuditOperations(previous, next, undefined, [
          {
            phase: 'PLAN',
            event: 'review:obligation_fulfilled',
            occurredAt: FIXED_DECISION_AT,
            detail: { obligationId: 'obl-1', childSessionId: 'child-1' },
          },
        ]);
        // Crash point 1: state and semantic intent are durable, but no audit
        // record exists yet.
        await writeState(sessDir, committed);
        const appended: string[] = [];
        const deps = makeDeps({
          getSessionDir: vi.fn().mockReturnValue(sessDir),
          resolveSessionPolicy: vi.fn().mockResolvedValue({
            policy: {
              audit: { emitToolCalls: false, emitTransitions: true, enableChainHash: true },
              actorClassification: {},
              mode: 'team',
              requireHumanGates: false,
            },
            state: committed,
          }),
          appendAndTrack: vi.fn(async (event, _archiveDir, _chainEnabled, _hostSessionId) => {
            const persisted = await appendAuditEvent(
              sessDir,
              event as Parameters<typeof appendAuditEvent>[1],
            );
            appended.push(persisted.id);
          }),
        });

        await reconcilePendingAuditOperations(deps, SESSION_ID, 'flowguard_plan');
        const afterFirstDrain = await readState(sessDir);
        const semantic = afterFirstDrain!.pendingAuditOperations.find(
          (item) => item.kind === 'semantic',
        );
        if (!semantic || semantic.kind !== 'semantic')
          throw new Error('expected semantic operation');
        expect(semantic.status).toBe('reconciled');
        expect(
          (await readAuditTrail(sessDir)).filter((event) => event.id === semantic.operationId),
        ).toHaveLength(1);

        // Crash point 2: append succeeded but the acknowledgement was lost.
        await writeState(sessDir, {
          ...afterFirstDrain!,
          pendingAuditOperations: afterFirstDrain!.pendingAuditOperations.map((item) =>
            item.operationId === semantic.operationId
              ? { ...item, status: 'state_committed' as const }
              : item,
          ),
        });
        await reconcilePendingAuditOperations(deps, SESSION_ID, 'flowguard_plan');

        expect(
          (await readAuditTrail(sessDir)).filter((event) => event.id === semantic.operationId),
        ).toHaveLength(1);
        expect(appended.filter((id) => id === semantic.operationId)).toHaveLength(1);
        expect(
          (await readState(sessDir))!.pendingAuditOperations.find(
            (item) => item.operationId === semantic.operationId,
          )!.status,
        ).toBe('reconciled');
      } finally {
        await fs.rm(sessDir, { recursive: true, force: true });
      }
    });

    it('drains a committed decision intent exactly once with the exact human verdict', async () => {
      const sessDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-decision-intent-'));
      try {
        const previous = makeState('PLAN_REVIEW', { id: SESSION_ID });
        const decision = {
          ...REVIEW_APPROVE,
          verdict: 'approve_with_governance_override' as const,
          decidedAt: FIXED_DECISION_AT,
        };
        const committed = prepareAuditOperations(previous, { ...previous }, undefined, [
          buildDecisionAuditIntent({
            transition: {
              from: 'PLAN_REVIEW',
              to: 'VALIDATION',
              event: 'APPROVE',
              at: FIXED_DECISION_AT,
            },
            decision,
            policyMode: 'regulated',
            decisionSequence: 4,
          }),
        ]);
        await writeState(sessDir, committed);
        const deps = makeDeps({
          getSessionDir: vi.fn().mockReturnValue(sessDir),
          resolveSessionPolicy: vi.fn().mockResolvedValue({
            policy: {
              audit: { emitToolCalls: false, emitTransitions: true, enableChainHash: true },
              actorClassification: {},
              mode: 'team',
              requireHumanGates: false,
            },
            state: committed,
          }),
          appendAndTrack: vi.fn(async (event) => {
            await appendAuditEvent(sessDir, event as Parameters<typeof appendAuditEvent>[1]);
          }),
        });

        await reconcilePendingAuditOperations(deps, SESSION_ID, 'flowguard_decision');
        const decisions = (await readAuditTrail(sessDir)).filter(
          (event) => event.detail.kind === 'decision',
        );
        expect(decisions).toHaveLength(1);
        expect(decisions[0]!.event).toBe('decision:DEC-004');
        expect(decisions[0]!.detail.verdict).toBe('approve_with_governance_override');
        expect(decisions[0]!.detail.decisionIdentity).toEqual(decision.decisionIdentity);
        expect(decisions[0]!.detail.gatePhase).toBe('PLAN_REVIEW');

        // Crash point: the append succeeded but the acknowledgement was lost.
        const afterFirstDrain = await readState(sessDir);
        await writeState(sessDir, {
          ...afterFirstDrain!,
          pendingAuditOperations: afterFirstDrain!.pendingAuditOperations.map((item) => ({
            ...item,
            status: 'state_committed' as const,
          })),
        });
        await reconcilePendingAuditOperations(deps, SESSION_ID, 'flowguard_decision');
        expect(
          (await readAuditTrail(sessDir)).filter((event) => event.detail.kind === 'decision'),
        ).toHaveLength(1);
      } finally {
        await fs.rm(sessDir, { recursive: true, force: true });
      }
    });
  });

  describe('phantom identity', () => {
    it('resolves the audit context under the real caller tool name, never a synthetic one', async () => {
      // Regression: reconciliation used to resolve its context under the
      // non-canonical identity 'flowguard_reconcile', which silently missed
      // `policy.actorClassification[toolName]` and misattributed the audit
      // diagnostic tool label. The resolved actor is not consumed by the
      // transition/state-write builders today, so the observable contract is
      // the classification lookup and the diagnostic label themselves.
      const sessDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-audit-reconcile-identity-'));
      try {
        const state = noTransitionAudit('TICKET');
        await writeState(sessDir, state);

        const lookedUpKeys: string[] = [];
        const actorClassification: Record<string, string> = new Proxy(
          { [TOOL_FLOWGUARD_HYDRATE]: 'human' },
          {
            get(target, property, receiver) {
              if (typeof property === 'string') lookedUpKeys.push(property);
              return Reflect.get(target, property, receiver);
            },
          },
        );
        const deps = makeDeps({
          getSessionDir: vi.fn().mockReturnValue(sessDir),
          resolveSessionPolicy: vi.fn().mockResolvedValue({
            policy: {
              audit: { emitToolCalls: false, emitTransitions: false, enableChainHash: true },
              actorClassification,
              mode: 'team',
              requireHumanGates: false,
            },
            state,
          }),
        });

        await expect(
          reconcilePendingAuditOperations(deps, SESSION_ID, TOOL_FLOWGUARD_HYDRATE),
        ).resolves.toBeUndefined();

        expect(lookedUpKeys).toContain(TOOL_FLOWGUARD_HYDRATE);
        expect(lookedUpKeys).not.toContain('flowguard_reconcile');
        expect(deps.log.debug).toHaveBeenCalledWith(
          'audit',
          'processing tool call',
          expect.objectContaining({ tool: TOOL_FLOWGUARD_HYDRATE }),
        );
      } finally {
        await fs.rm(sessDir, { recursive: true, force: true });
      }
    });
  });
});
