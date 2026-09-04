/**
 * @module integration/plugin-workspace.test
 * @description Unit tests for PluginWorkspaceImpl — serialization queue, chain state, session dir.
 *
 * Targets uncovered branches in runSerializedForSession (.catch path)
 * and initChain (GENESIS_HASH fallback).
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 * @version v2
 */

import { describe, it, expect, vi } from 'vitest';

// ─── Hoisted mocks for call-site tests ──────────────────────────────────────

const { mockAppendReviewAudit, mockWithSessionWriteLock, mockReadState } = vi.hoisted(() => ({
  mockAppendReviewAudit: vi.fn(),
  mockWithSessionWriteLock: vi.fn(),
  mockReadState: vi.fn(),
}));

vi.mock('./review/audit-events.js', () => ({
  appendReviewAuditEvent: mockAppendReviewAudit,
}));

vi.mock('../adapters/persistence.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../adapters/persistence.js')>();
  return {
    ...actual,
    withSessionWriteLock: mockWithSessionWriteLock,
    readState: mockReadState,
    writeStateAlreadyLocked: vi.fn(),
  };
});

import { PluginWorkspaceImpl, type WorkspaceDeps } from './plugin-workspace.js';
import type { MutableChainState } from './plugin-workspace.js';
import { recordAssuranceWithAudit, type AssuranceAuditDeps } from './review/shared-helpers.js';
import { makeState } from '../fixtures.js';

function fakeDeps(overrides?: Partial<WorkspaceDeps>): WorkspaceDeps {
  return { auditWorktree: undefined, ...overrides };
}

// ─── Tests ──────────────────────────────────────────────────────────────────────

describe('integration/plugin-workspace', () => {
  describe('PluginWorkspaceImpl', () => {
    describe('HAPPY', () => {
      it('creates instance with default state', () => {
        const ws = new PluginWorkspaceImpl(fakeDeps());
        expect(ws.cachedFingerprint).toBeNull();
        expect(ws.cachedWsDir).toBeNull();
      });

      it('getChainState returns a new state when none exists', () => {
        const ws = new PluginWorkspaceImpl(fakeDeps());
        const state = ws.getChainState('session-1');
        expect(state.initialized).toBe(false);
        expect(state.lastHash).toBeNull();
      });

      it('getChainState returns same state for same session', () => {
        const ws = new PluginWorkspaceImpl(fakeDeps());
        const a = ws.getChainState('session-1');
        const b = ws.getChainState('session-1');
        expect(a).toBe(b);
      });

      it('invalidateChainState removes session state', () => {
        const ws = new PluginWorkspaceImpl(fakeDeps());
        const beforeInvalidate = ws.getChainState('session-1');
        beforeInvalidate.initialized = true;
        beforeInvalidate.lastHash = 'old-chain-hash';
        ws.invalidateChainState('session-1');
        const afterInvalidate = ws.getChainState('session-1');
        expect(afterInvalidate).not.toBe(beforeInvalidate);
        expect(afterInvalidate.initialized).toBe(false);
        expect(afterInvalidate.lastHash).toBeNull();
      });

      it('resolveFingerprint returns null when no auditWorktree', async () => {
        const ws = new PluginWorkspaceImpl(fakeDeps());
        const fp = await ws.resolveFingerprint();
        expect(fp).toBeNull();
      });

      it('getSessionDir returns null when no fingerprint', () => {
        const ws = new PluginWorkspaceImpl(fakeDeps());
        expect(ws.getSessionDir('any')).toBeNull();
      });

      it('getEnforcementState returns a fresh state for new session', () => {
        const ws = new PluginWorkspaceImpl(fakeDeps());
        const eState = ws.getEnforcementState('s1');
        expect(eState).toBeDefined();
        expect(eState.pendingReviews).toBeDefined();
      });

      it('getEnforcementState returns same state for same session', () => {
        const ws = new PluginWorkspaceImpl(fakeDeps());
        const a = ws.getEnforcementState('s1');
        const b = ws.getEnforcementState('s1');
        expect(a).toBe(b);
      });
    });

    describe('CORNER', () => {
      it('runSerializedForSession handles rejected task gracefully', async () => {
        // Covers line 229: .catch(() => undefined) — error recovery in serialization
        const ws = new PluginWorkspaceImpl(fakeDeps());

        // First task fails — the reject is caught by the serialization queue
        await ws
          .runSerializedForSession('s1', async () => {
            throw new Error('task failed');
          })
          .catch(() => undefined);

        let secondRan = false;
        // Second task should still run despite first one failing
        await ws.runSerializedForSession('s1', async () => {
          secondRan = true;
        });

        expect(secondRan).toBe(true);
      });

      it('runSerializedForSession serializes concurrent tasks', async () => {
        const ws = new PluginWorkspaceImpl(fakeDeps());
        const order: number[] = [];

        const p1 = ws.runSerializedForSession('s1', async () => {
          await new Promise((r) => setTimeout(r, 5));
          order.push(1);
        });
        const p2 = ws.runSerializedForSession('s1', async () => {
          order.push(2);
        });

        await Promise.all([p1, p2]);
        expect(order).toEqual([1, 2]);
        expect(
          (ws as unknown as { _sessionQueues: Map<string, Promise<void>> })._sessionQueues.has(
            's1',
          ),
        ).toBe(false);
      });

      it('different sessions run in parallel', async () => {
        const ws = new PluginWorkspaceImpl(fakeDeps());
        let s1Done = false;
        let s2Done = false;

        const p1 = ws.runSerializedForSession('s1', async () => {
          await new Promise((r) => setTimeout(r, 10));
          s1Done = true;
        });
        const p2 = ws.runSerializedForSession('s2', async () => {
          s2Done = true;
        });

        await Promise.all([p1, p2]);
        expect(s1Done).toBe(true);
        expect(s2Done).toBe(true);
      });
    });

    describe('EDGE', () => {
      it('initChain uses GENESIS_HASH when sessDir is null', async () => {
        const ws = new PluginWorkspaceImpl(fakeDeps());
        const hash = await ws.initChain(null, 's1');
        expect(hash).toBe('genesis');
      });

      it('initChain returns same hash when called twice with same session', async () => {
        const ws = new PluginWorkspaceImpl(fakeDeps());
        const h1 = await ws.initChain(null, 's1');
        const h2 = await ws.initChain(null, 's1');
        expect(h1).toBe(h2);
      });
    });
  });
});

// ─── recordAssuranceWithAudit ─────────────────────────────────────────────────

function mockAssuranceDeps(overrides?: Partial<AssuranceAuditDeps>): AssuranceAuditDeps {
  return {
    updateReviewAssurance: vi.fn(),
    ...overrides,
  };
}

describe('recordAssuranceWithAudit', () => {
  it('commits the semantic audit intent with the state mutation', async () => {
    const updateReviewAssurance = vi.fn();
    const deps = mockAssuranceDeps({ updateReviewAssurance });
    const result = await recordAssuranceWithAudit(deps, {
      sessDir: '/tmp/sess',
      stateMutation: () => ({ phase: 'PLAN' }) as never,
      auditEventName: 'review:obligation_blocked',
      auditDetail: { code: 'X' },
    });
    expect(result.auditOk).toBe(true);
    expect(updateReviewAssurance).toHaveBeenCalled();
    const intentFactory = updateReviewAssurance.mock.calls[0]![2] as (
      state: { phase: string },
      now: string,
    ) => unknown[];
    expect(intentFactory({ phase: 'PLAN' }, '2026-01-01T00:00:00.000Z')).toEqual([
      {
        phase: 'PLAN',
        event: 'review:obligation_blocked',
        occurredAt: '2026-01-01T00:00:00.000Z',
        detail: { code: 'X' },
      },
    ]);
  });

  it('BAD: state failure propagates and prevents audit write', async () => {
    const deps = mockAssuranceDeps({
      updateReviewAssurance: vi.fn().mockRejectedValue(new Error('LOCK_TIMEOUT')),
    });
    await expect(
      recordAssuranceWithAudit(deps, {
        sessDir: '/tmp/sess',
        stateMutation: () => ({ phase: 'PLAN' }) as never,
        auditEventName: 'review:obligation_blocked',
        auditDetail: { code: 'X' },
      }),
    ).rejects.toThrow('LOCK_TIMEOUT');
  });

  it('CALL-SITE: blockReviewOutcome commits a recoverable semantic intent', async () => {
    const mockState = makeState('PLAN');
    mockReadState.mockResolvedValue(mockState);
    mockWithSessionWriteLock.mockImplementation(async (_dir: string, fn: () => Promise<void>) =>
      fn(),
    );

    const ws = new PluginWorkspaceImpl({ auditWorktree: '/tmp' } as WorkspaceDeps);
    const output: { output: string } = { output: '' };

    await ws.blockReviewOutcome(
      { sessDir: '/tmp/sess', sessionId: 's1', phase: 'PLAN' },
      'obl-1',
      'SUBAGENT_REVIEW_NOT_INVOKED',
      { reason: 'test' },
      output,
    );

    expect(output.output).toContain('SUBAGENT_REVIEW_NOT_INVOKED');
    expect(mockReadState).toHaveBeenCalled();
  });

  it('REGISTRY: AUDIT_PERSISTENCE_FAILED is centrally registered with recovery', async () => {
    const { defaultReasonRegistry } = await import('../config/reasons.js');
    const reason = defaultReasonRegistry.get('AUDIT_PERSISTENCE_FAILED');
    expect(reason).toBeDefined();
    expect(reason!.code).toBe('AUDIT_PERSISTENCE_FAILED');
    expect(reason!.category).toBe('adapter');
    expect(reason!.recoverySteps.length).toBeGreaterThan(0);
  });
});
