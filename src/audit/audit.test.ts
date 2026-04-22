/**
 * @module audit.test
 * @description Comprehensive tests for the FlowGuard audit subsystem.
 *
 * Covers all 5 audit modules:
 * - types: factory functions, computeChainHash, summarizeArgs
 * - integrity: verifyEvent, verifyChain, getLastChainHash
 * - query: filters, combinators, query utilities
 * - summary: generateTimeline, generateComplianceSummary
 * - completeness: evaluateCompleteness, four-eyes principle
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE, PERF — all five categories present.
 */

import { describe, it, expect } from 'vitest';
import {
  computeChainHash,
  GENESIS_HASH,
  createTransitionEvent,
  createToolCallEvent,
  createErrorEvent,
  createLifecycleEvent,
  createDecisionEvent,
  summarizeArgs,
  type ChainedAuditEvent,
  type ActorInfo,
} from './types';
import { verifyEvent, verifyChain, getLastChainHash } from './integrity';
import {
  bySession,
  byPhase,
  byPhases,
  byActor,
  byKind,
  byEvent,
  byTimeRange,
  byDetail,
  allOf,
  anyOf,
  not,
  filterEvents,
  sessionEvents,
  transitionEvents,
  toolCallEvents,
  errorEvents,
  decisionEvents,
  decisionReceipts,
  distinctSessions,
  countByKind,
  countByPhase,
  timeSpan,
} from './query';
import { generateTimeline, generateComplianceSummary } from './summary';
import { evaluateCompleteness } from './completeness';
import type { AuditEvent } from '../state/evidence';
import { makeState, makeProgressedState, FIXED_TIME, FIXED_SESSION_UUID } from '../__fixtures__';
import { benchmarkSync, PERF_BUDGETS } from '../test-policy';

// ─── Test Helpers ─────────────────────────────────────────────────────────────

const SESSION_ID = FIXED_SESSION_UUID;
const TS1 = '2026-01-01T00:00:00.000Z';
const TS2 = '2026-01-01T00:01:00.000Z';
const TS3 = '2026-01-01T00:02:00.000Z';

/** Build a minimal AuditEvent for query tests. */
function makeAuditEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    sessionId: SESSION_ID,
    phase: 'PLAN',
    event: 'transition:PLAN_READY',
    timestamp: TS1,
    actor: 'machine',
    detail: { from: 'TICKET', to: 'PLAN', kind: 'transition' },
    ...overrides,
  };
}

/** Build a chain of N chained audit events (for integrity tests). */
function buildChain(length: number): ChainedAuditEvent[] {
  const events: ChainedAuditEvent[] = [];
  let prevHash = GENESIS_HASH;

  for (let i = 0; i < length; i++) {
    const event = createTransitionEvent(
      SESSION_ID,
      'PLAN',
      {
        from: 'TICKET',
        to: 'PLAN',
        event: 'PLAN_READY',
        autoAdvanced: false,
        chainIndex: -1,
      },
      `2026-01-01T00:${String(i).padStart(2, '0')}:00.000Z`,
      prevHash,
    );
    events.push(event);
    prevHash = event.chainHash;
  }

  return events;
}

/** Build a realistic session event trail for summary/compliance tests. */
function buildSessionTrail(): AuditEvent[] {
  return [
    makeAuditEvent({
      event: 'lifecycle:session_created',
      phase: 'TICKET',
      timestamp: TS1,
      actor: 'system',
      detail: { kind: 'lifecycle', action: 'session_created', finalPhase: 'TICKET' },
    }),
    makeAuditEvent({
      event: 'tool_call:flowguard_ticket',
      phase: 'TICKET',
      timestamp: TS1,
      actor: 'user',
      detail: { kind: 'tool_call', tool: 'flowguard_ticket', success: true, transitionCount: 1 },
    }),
    makeAuditEvent({
      event: 'transition:TICKET_SET',
      phase: 'PLAN',
      timestamp: TS1,
      detail: {
        kind: 'transition',
        from: 'TICKET',
        to: 'PLAN',
        event: 'TICKET_SET',
        autoAdvanced: false,
        chainIndex: -1,
      },
    }),
    makeAuditEvent({
      event: 'transition:PLAN_READY',
      phase: 'PLAN',
      timestamp: TS2,
      detail: {
        kind: 'transition',
        from: 'PLAN',
        to: 'PLAN_REVIEW',
        event: 'PLAN_READY',
        autoAdvanced: true,
        chainIndex: 0,
      },
    }),
    makeAuditEvent({
      event: 'transition:APPROVE',
      phase: 'VALIDATION',
      timestamp: TS2,
      detail: {
        kind: 'transition',
        from: 'PLAN_REVIEW',
        to: 'VALIDATION',
        event: 'APPROVE',
        autoAdvanced: false,
        chainIndex: -1,
      },
    }),
    makeAuditEvent({
      event: 'tool_call:flowguard_validate',
      phase: 'VALIDATION',
      timestamp: TS2,
      actor: 'machine',
      detail: { kind: 'tool_call', tool: 'flowguard_validate', success: true, transitionCount: 1 },
    }),
    makeAuditEvent({
      event: 'transition:ALL_PASSED',
      phase: 'IMPLEMENTATION',
      timestamp: TS2,
      detail: {
        kind: 'transition',
        from: 'VALIDATION',
        to: 'IMPLEMENTATION',
        event: 'ALL_PASSED',
        autoAdvanced: false,
        chainIndex: -1,
      },
    }),
    makeAuditEvent({
      event: 'transition:IMPL_COMPLETE',
      phase: 'IMPL_REVIEW',
      timestamp: TS3,
      detail: {
        kind: 'transition',
        from: 'IMPLEMENTATION',
        to: 'IMPL_REVIEW',
        event: 'IMPL_COMPLETE',
        autoAdvanced: false,
        chainIndex: -1,
      },
    }),
    makeAuditEvent({
      event: 'transition:REVIEW_CONVERGED',
      phase: 'EVIDENCE_REVIEW',
      timestamp: TS3,
      detail: {
        kind: 'transition',
        from: 'IMPL_REVIEW',
        to: 'EVIDENCE_REVIEW',
        event: 'REVIEW_CONVERGED',
        autoAdvanced: false,
        chainIndex: -1,
      },
    }),
    makeAuditEvent({
      event: 'transition:APPROVE',
      phase: 'COMPLETE',
      timestamp: TS3,
      detail: {
        kind: 'transition',
        from: 'EVIDENCE_REVIEW',
        to: 'COMPLETE',
        event: 'APPROVE',
        autoAdvanced: false,
        chainIndex: -1,
      },
    }),
    makeAuditEvent({
      event: 'lifecycle:session_completed',
      phase: 'COMPLETE',
      timestamp: TS3,
      actor: 'system',
      detail: { kind: 'lifecycle', action: 'session_completed', finalPhase: 'COMPLETE' },
    }),
  ];
}

// =============================================================================
// audit/types
// =============================================================================

describe('audit types', () => {
  // ─── HAPPY ──────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('computeChainHash produces 64-char hex string', () => {
      const base: Omit<ChainedAuditEvent, 'chainHash'> = {
        id: 'test-id',
        sessionId: SESSION_ID,
        phase: 'PLAN',
        event: 'transition:PLAN_READY',
        timestamp: TS1,
        actor: 'machine',
        detail: {},
        prevHash: GENESIS_HASH,
      };
      const hash = computeChainHash(GENESIS_HASH, base);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('createTransitionEvent produces valid chained event', () => {
      const event = createTransitionEvent(
        SESSION_ID,
        'PLAN',
        { from: 'TICKET', to: 'PLAN', event: 'PLAN_READY', autoAdvanced: false, chainIndex: -1 },
        TS1,
        GENESIS_HASH,
      );
      expect(event.sessionId).toBe(SESSION_ID);
      expect(event.phase).toBe('PLAN');
      expect(event.event).toBe('transition:PLAN_READY');
      expect(event.actor).toBe('machine');
      expect(event.prevHash).toBe(GENESIS_HASH);
      expect(event.chainHash).toMatch(/^[0-9a-f]{64}$/);
      expect(event.detail.kind).toBe('transition');
      expect(event.detail.from).toBe('TICKET');
      expect(event.detail.to).toBe('PLAN');
    });

    it('createToolCallEvent produces valid chained event', () => {
      const event = createToolCallEvent(
        SESSION_ID,
        'PLAN',
        {
          tool: 'flowguard_plan',
          argsSummary: { text: 'fix auth' },
          success: true,
          transitionCount: 1,
        },
        TS1,
        'user-1',
        GENESIS_HASH,
      );
      expect(event.event).toBe('tool_call:flowguard_plan');
      expect(event.actor).toBe('user-1');
      expect(event.detail.kind).toBe('tool_call');
      expect(event.detail.tool).toBe('flowguard_plan');
    });

    it('createErrorEvent produces valid chained event', () => {
      const event = createErrorEvent(
        SESSION_ID,
        { code: 'TOOL_ERROR', message: 'oops', recoveryHint: 'retry', errorPhase: 'PLAN' },
        TS1,
        GENESIS_HASH,
      );
      expect(event.event).toBe('error:TOOL_ERROR');
      expect(event.phase).toBe('PLAN');
      expect(event.detail.kind).toBe('error');
    });

    it('createLifecycleEvent produces valid chained event', () => {
      const event = createLifecycleEvent(
        SESSION_ID,
        { action: 'session_created', finalPhase: 'TICKET' },
        TS1,
        'system',
        GENESIS_HASH,
      );
      expect(event.event).toBe('lifecycle:session_created');
      expect(event.actor).toBe('system');
      expect(event.detail.kind).toBe('lifecycle');
    });

    it('createDecisionEvent produces valid chained event', () => {
      const event = createDecisionEvent(
        SESSION_ID,
        'PLAN_REVIEW',
        {
          decisionId: 'DEC-001',
          decisionSequence: 1,
          verdict: 'approve',
          rationale: 'LGTM',
          decidedBy: 'reviewer-1',
          decidedAt: TS1,
          fromPhase: 'PLAN_REVIEW',
          toPhase: 'VALIDATION',
          transitionEvent: 'APPROVE',
          policyMode: 'team',
        },
        TS1,
        'human',
        GENESIS_HASH,
      );
      expect(event.event).toBe('decision:DEC-001');
      expect(event.phase).toBe('PLAN_REVIEW');
      expect(event.detail.kind).toBe('decision');
      expect(event.detail.decisionSequence).toBe(1);
    });

    // ─── P27: Actor Identity ───────────────────────────────────

    it('lifecycle event contains actorInfo when provided', () => {
      const actor: ActorInfo = { id: 'jane', email: 'jane@dev.io', source: 'git' };
      const event = createLifecycleEvent(
        SESSION_ID,
        { action: 'session_created', finalPhase: 'TICKET' },
        TS1,
        'system',
        GENESIS_HASH,
        actor,
      );
      expect(event.actorInfo).toEqual(actor);
      expect(event.actor).toBe('system');
    });

    it('tool_call event contains actorInfo when provided', () => {
      const actor: ActorInfo = { id: 'ci-bot', email: null, source: 'env' };
      const event = createToolCallEvent(
        SESSION_ID,
        'PLAN',
        { tool: 'flowguard_plan', argsSummary: {}, success: true, transitionCount: 1 },
        TS1,
        'user',
        GENESIS_HASH,
        actor,
      );
      expect(event.actorInfo).toEqual(actor);
      expect(event.actor).toBe('user');
    });

    it('decision event contains actorInfo when provided', () => {
      const actor: ActorInfo = { id: 'reviewer', email: 'rev@co.com', source: 'env' };
      const event = createDecisionEvent(
        SESSION_ID,
        'PLAN_REVIEW',
        {
          decisionId: 'DEC-002',
          decisionSequence: 1,
          verdict: 'approve',
          rationale: 'ok',
          decidedBy: 'reviewer',
          decidedAt: TS1,
          fromPhase: 'PLAN_REVIEW',
          toPhase: 'VALIDATION',
          transitionEvent: 'APPROVE',
          policyMode: 'team',
        },
        TS1,
        'human',
        GENESIS_HASH,
        actor,
      );
      expect(event.actorInfo).toEqual(actor);
    });

    it('sessionID is still present separately from actorInfo', () => {
      const actor: ActorInfo = { id: 'dev1', email: null, source: 'git' };
      const event = createLifecycleEvent(
        SESSION_ID,
        { action: 'session_created', finalPhase: 'TICKET' },
        TS1,
        'system',
        GENESIS_HASH,
        actor,
      );
      expect(event.sessionId).toBe(SESSION_ID);
      expect(event.actorInfo).toBeDefined();
      expect(event.sessionId).not.toBe(event.actorInfo!.id);
    });

    it('summarizeArgs handles all scalar types', () => {
      const result = summarizeArgs({
        str: 'hello',
        num: 42,
        bool: true,
        nil: null,
        undef: undefined,
      });
      expect(result.str).toBe('hello');
      expect(result.num).toBe('42');
      expect(result.bool).toBe('true');
      expect(result.nil).toBe('null');
      expect(result.undef).toBe('null');
    });
  });

  // ─── BAD ────────────────────────────────────────────────────
  describe('BAD', () => {
    it('summarizeArgs replaces objects and arrays with type indicators', () => {
      const result = summarizeArgs({
        arr: [1, 2, 3],
        obj: { nested: true },
        emptyArr: [],
      });
      expect(result.arr).toBe('[Array(3)]');
      expect(result.obj).toBe('[Object]');
      expect(result.emptyArr).toBe('[Array(0)]');
    });
  });

  // ─── CORNER ─────────────────────────────────────────────────
  describe('CORNER', () => {
    it('summarizeArgs truncates strings > 100 chars', () => {
      const long = 'x'.repeat(150);
      const result = summarizeArgs({ long });
      expect(result.long).toBe('x'.repeat(100) + '...');
      expect(result.long!.length).toBe(103);
    });

    it('summarizeArgs handles empty args', () => {
      expect(summarizeArgs({})).toEqual({});
    });

    it("GENESIS_HASH is 'genesis'", () => {
      expect(GENESIS_HASH).toBe('genesis');
    });

    it('createTransitionEvent with autoAdvanced=true records chain index', () => {
      const event = createTransitionEvent(
        SESSION_ID,
        'PLAN_REVIEW',
        { from: 'PLAN', to: 'PLAN_REVIEW', event: 'PLAN_READY', autoAdvanced: true, chainIndex: 2 },
        TS1,
        GENESIS_HASH,
      );
      expect(event.detail.autoAdvanced).toBe(true);
      expect(event.detail.chainIndex).toBe(2);
    });
  });

  // ─── EDGE ───────────────────────────────────────────────────
  describe('EDGE', () => {
    it('computeChainHash is deterministic (same input → same output)', () => {
      const base: Omit<ChainedAuditEvent, 'chainHash'> = {
        id: 'deterministic-test',
        sessionId: SESSION_ID,
        phase: 'PLAN',
        event: 'transition:PLAN_READY',
        timestamp: TS1,
        actor: 'machine',
        detail: {},
        prevHash: GENESIS_HASH,
      };
      const hash1 = computeChainHash(GENESIS_HASH, base);
      const hash2 = computeChainHash(GENESIS_HASH, base);
      expect(hash1).toBe(hash2);
    });

    it('computeChainHash differs with different prevHash', () => {
      const base: Omit<ChainedAuditEvent, 'chainHash'> = {
        id: 'test-id',
        sessionId: SESSION_ID,
        phase: 'PLAN',
        event: 'transition:PLAN_READY',
        timestamp: TS1,
        actor: 'machine',
        detail: {},
        prevHash: 'hash-a',
      };
      const hash1 = computeChainHash('hash-a', base);
      const hash2 = computeChainHash('hash-b', { ...base, prevHash: 'hash-b' });
      expect(hash1).not.toBe(hash2);
    });

    it('factory event names encode the kind as prefix', () => {
      const t = createTransitionEvent(
        SESSION_ID,
        'PLAN',
        { from: 'TICKET', to: 'PLAN', event: 'PLAN_READY', autoAdvanced: false, chainIndex: -1 },
        TS1,
        GENESIS_HASH,
      );
      const tc = createToolCallEvent(
        SESSION_ID,
        'PLAN',
        { tool: 'test', argsSummary: {}, success: true, transitionCount: 0 },
        TS1,
        'user',
        GENESIS_HASH,
      );
      const e = createErrorEvent(
        SESSION_ID,
        { code: 'ERR', message: 'msg', recoveryHint: 'fix', errorPhase: 'PLAN' },
        TS1,
        GENESIS_HASH,
      );
      const l = createLifecycleEvent(
        SESSION_ID,
        { action: 'session_created', finalPhase: 'TICKET' },
        TS1,
        'system',
        GENESIS_HASH,
      );
      const d = createDecisionEvent(
        SESSION_ID,
        'PLAN_REVIEW',
        {
          decisionId: 'DEC-001',
          decisionSequence: 1,
          verdict: 'approve',
          rationale: 'ok',
          decidedBy: 'r',
          decidedAt: TS1,
          fromPhase: 'PLAN_REVIEW',
          toPhase: 'VALIDATION',
          transitionEvent: 'APPROVE',
          policyMode: 'team',
        },
        TS1,
        'human',
        GENESIS_HASH,
      );

      expect(t.event).toMatch(/^transition:/);
      expect(tc.event).toMatch(/^tool_call:/);
      expect(e.event).toMatch(/^error:/);
      expect(l.event).toMatch(/^lifecycle:/);
      expect(d.event).toMatch(/^decision:/);
    });

    // ─── P27: Hash Backward Compatibility ──────────────────────

    it('event without actorInfo has same hash as event created before P27', () => {
      // Simulate a "pre-P27" event — no actorInfo parameter
      const withoutActor = createLifecycleEvent(
        SESSION_ID,
        { action: 'session_created', finalPhase: 'TICKET' },
        TS1,
        'system',
        GENESIS_HASH,
      );
      // actorInfo should be absent from the object (not undefined-as-value)
      expect('actorInfo' in withoutActor).toBe(false);

      // Manually build the same event object as pre-P27 code would have produced
      const prePatchEvent: Omit<ChainedAuditEvent, 'chainHash'> = {
        id: withoutActor.id,
        sessionId: withoutActor.sessionId,
        phase: withoutActor.phase,
        event: withoutActor.event,
        timestamp: withoutActor.timestamp,
        actor: withoutActor.actor,
        detail: withoutActor.detail,
        prevHash: withoutActor.prevHash,
      };
      const prePatchHash = computeChainHash(GENESIS_HASH, prePatchEvent);
      expect(withoutActor.chainHash).toBe(prePatchHash);
    });

    it('actorInfo changes the chain hash (isolated, same event body)', () => {
      const actor: ActorInfo = { id: 'dev', email: null, source: 'git' };
      const sharedId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      const base = {
        id: sharedId,
        sessionId: SESSION_ID,
        phase: 'TICKET',
        event: 'lifecycle:session_created',
        timestamp: TS1,
        actor: 'system',
        detail: { kind: 'lifecycle', action: 'session_created', finalPhase: 'TICKET' },
        prevHash: GENESIS_HASH,
      };
      const withActorInfo = { ...base, actorInfo: actor };

      const hashWithout = computeChainHash(GENESIS_HASH, base);
      const hashWith = computeChainHash(GENESIS_HASH, withActorInfo);

      // Same body, same ID — only actorInfo differs → different hash
      expect(hashWithout).toMatch(/^[0-9a-f]{64}$/);
      expect(hashWith).toMatch(/^[0-9a-f]{64}$/);
      expect(hashWithout).not.toBe(hashWith);
    });

    it('actorInfo absent on transition and error events', () => {
      const transition = createTransitionEvent(
        SESSION_ID,
        'PLAN',
        { from: 'TICKET', to: 'PLAN', event: 'PLAN_READY', autoAdvanced: false, chainIndex: -1 },
        TS1,
        GENESIS_HASH,
      );
      const error = createErrorEvent(
        SESSION_ID,
        { code: 'ERR', message: 'msg', recoveryHint: 'fix', errorPhase: 'PLAN' },
        TS1,
        GENESIS_HASH,
      );
      expect('actorInfo' in transition).toBe(false);
      expect('actorInfo' in error).toBe(false);
    });
  });

  // ─── PERF ───────────────────────────────────────────────────
  describe('PERF', () => {
    it('computeChainHash < 1ms (p99 over 200 iterations)', () => {
      const base: Omit<ChainedAuditEvent, 'chainHash'> = {
        id: 'perf-test',
        sessionId: SESSION_ID,
        phase: 'PLAN',
        event: 'transition:PLAN_READY',
        timestamp: TS1,
        actor: 'machine',
        detail: { kind: 'transition', from: 'TICKET', to: 'PLAN' },
        prevHash: GENESIS_HASH,
      };
      const { p99Ms } = benchmarkSync(() => computeChainHash(GENESIS_HASH, base), 200, 50);
      expect(p99Ms).toBeLessThan(PERF_BUDGETS.evaluateSingleMs); // 1ms
    });
  });
});

// =============================================================================
// audit/integrity
// =============================================================================

describe('audit integrity', () => {
  // ─── HAPPY ──────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('verifyEvent passes for valid event with correct prevHash', () => {
      const event = createTransitionEvent(
        SESSION_ID,
        'PLAN',
        { from: 'TICKET', to: 'PLAN', event: 'PLAN_READY', autoAdvanced: false, chainIndex: -1 },
        TS1,
        GENESIS_HASH,
      );
      const result = verifyEvent(event, GENESIS_HASH, 0);
      expect(result.valid).toBe(true);
      expect(result.reason).toBeNull();
    });

    it('verifyChain passes for valid 3-event chain', () => {
      const chain = buildChain(3);
      const result = verifyChain(chain as unknown as Record<string, unknown>[]);
      expect(result.valid).toBe(true);
      expect(result.totalEvents).toBe(3);
      expect(result.verifiedCount).toBe(3);
      expect(result.skippedCount).toBe(0);
      expect(result.firstBreak).toBeNull();
      expect(result.reason).toBeNull();
    });

    it('getLastChainHash returns last event chainHash', () => {
      const chain = buildChain(3);
      const lastHash = getLastChainHash(chain as unknown as Record<string, unknown>[]);
      expect(lastHash).toBe(chain[2]!.chainHash);
    });
  });

  // ─── BAD ────────────────────────────────────────────────────
  describe('BAD', () => {
    it('verifyEvent fails on prevHash mismatch', () => {
      const event = createTransitionEvent(
        SESSION_ID,
        'PLAN',
        { from: 'TICKET', to: 'PLAN', event: 'PLAN_READY', autoAdvanced: false, chainIndex: -1 },
        TS1,
        GENESIS_HASH,
      );
      const result = verifyEvent(event, 'wrong-prev-hash', 0);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('prevHash mismatch');
    });

    it('verifyEvent fails on tampered chainHash', () => {
      const event = createTransitionEvent(
        SESSION_ID,
        'PLAN',
        { from: 'TICKET', to: 'PLAN', event: 'PLAN_READY', autoAdvanced: false, chainIndex: -1 },
        TS1,
        GENESIS_HASH,
      );
      // Tamper the chainHash
      const tampered: ChainedAuditEvent = { ...event, chainHash: '0'.repeat(64) };
      const result = verifyEvent(tampered, GENESIS_HASH, 0);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('chainHash mismatch');
    });

    it('verifyChain detects a break in the middle', () => {
      const chain = buildChain(5);
      // Tamper event #2 by modifying its detail
      const tampered = chain.map((e, i) => {
        if (i === 2) return { ...e, phase: 'TAMPERED' } as unknown as Record<string, unknown>;
        return e as unknown as Record<string, unknown>;
      });
      const result = verifyChain(tampered);
      expect(result.valid).toBe(false);
      expect(result.firstBreak).not.toBeNull();
      expect(result.firstBreak!.index).toBe(2);
      expect(result.reason).toBe('CHAIN_BREAK');
    });
  });

  // ─── CORNER ─────────────────────────────────────────────────
  describe('CORNER', () => {
    it('verifyChain with empty trail → valid (vacuously true)', () => {
      const result = verifyChain([]);
      expect(result.valid).toBe(true);
      expect(result.totalEvents).toBe(0);
      expect(result.verifiedCount).toBe(0);
      expect(result.reason).toBeNull();
    });

    it('verifyChain with single event → valid', () => {
      const chain = buildChain(1);
      const result = verifyChain(chain as unknown as Record<string, unknown>[]);
      expect(result.valid).toBe(true);
      expect(result.verifiedCount).toBe(1);
      expect(result.reason).toBeNull();
    });

    it('getLastChainHash with empty trail → GENESIS_HASH', () => {
      expect(getLastChainHash([])).toBe(GENESIS_HASH);
    });

    it('verifyChain skips non-chained (legacy) events', () => {
      const legacyEvent: Record<string, unknown> = {
        id: 'legacy-1',
        sessionId: SESSION_ID,
        phase: 'PLAN',
        event: 'transition:PLAN_READY',
        timestamp: TS1,
        actor: 'machine',
        detail: {},
        // No prevHash, no chainHash
      };
      const result = verifyChain([legacyEvent]);
      expect(result.valid).toBe(true);
      expect(result.totalEvents).toBe(1);
      expect(result.verifiedCount).toBe(0);
      expect(result.skippedCount).toBe(1);
      expect(result.reason).toBeNull();
    });
  });

  // ─── EDGE ───────────────────────────────────────────────────
  describe('EDGE', () => {
    it('verifyChain with mixed chained and legacy events', () => {
      const chain = buildChain(2);
      const legacy: Record<string, unknown> = {
        id: 'legacy-1',
        sessionId: SESSION_ID,
        phase: 'PLAN',
        event: 'some:event',
        timestamp: TS2,
        actor: 'machine',
        detail: {},
      };
      // Insert legacy between two chained events
      const mixed = [
        chain[0] as unknown as Record<string, unknown>,
        legacy,
        chain[1] as unknown as Record<string, unknown>,
      ];
      const result = verifyChain(mixed);
      // Chain continues from event[0].chainHash to event[2].prevHash
      // Event[2] was created with event[0].chainHash as prevHash
      // so after skipping the legacy event, the chain should still be valid
      expect(result.totalEvents).toBe(3);
      expect(result.skippedCount).toBe(1);
      expect(result.verifiedCount).toBe(2);
      // The chain is valid because event[1] (chained, index=2) was built
      // with event[0].chainHash as prevHash
      expect(result.valid).toBe(true);
      expect(result.reason).toBeNull();
    });

    it('insertion attack detected — new event breaks prevHash chain', () => {
      const chain = buildChain(3);
      // Create an "inserted" event with correct prevHash but inserted between [0] and [1]
      const inserted = createTransitionEvent(
        SESSION_ID,
        'PLAN',
        {
          from: 'PLAN',
          to: 'PLAN_REVIEW',
          event: 'PLAN_READY',
          autoAdvanced: false,
          chainIndex: -1,
        },
        TS2,
        chain[0]!.chainHash, // Uses correct prevHash for [0]
      );
      // Insert between [0] and [1] — [1]'s prevHash still points to [0], not inserted
      const tampered = [
        chain[0] as unknown as Record<string, unknown>,
        inserted as unknown as Record<string, unknown>,
        chain[1] as unknown as Record<string, unknown>, // prevHash = chain[0].chainHash, not inserted.chainHash
        chain[2] as unknown as Record<string, unknown>,
      ];
      const result = verifyChain(tampered);
      // Event at index 2 (original chain[1]) has prevHash = chain[0].chainHash
      // but the verifier expects prevHash = inserted.chainHash → break
      expect(result.valid).toBe(false);
      expect(result.firstBreak!.index).toBe(2);
      expect(result.reason).toBe('CHAIN_BREAK');
    });

    it('getLastChainHash skips trailing legacy events', () => {
      const chain = buildChain(2);
      const legacy: Record<string, unknown> = {
        id: 'legacy-tail',
        sessionId: SESSION_ID,
        phase: 'COMPLETE',
        event: 'some:event',
        timestamp: TS3,
        actor: 'machine',
        detail: {},
      };
      const mixed = [...chain.map((e) => e as unknown as Record<string, unknown>), legacy];
      expect(getLastChainHash(mixed)).toBe(chain[1]!.chainHash);
    });
  });

  // ─── PERF ───────────────────────────────────────────────────
  describe('PERF', () => {
    it('verifyChain for 1000 events < 100ms', () => {
      const chain = buildChain(1000);
      const raw = chain.map((e) => e as unknown as Record<string, unknown>);
      const { p99Ms } = benchmarkSync(() => verifyChain(raw), 5, 1);
      expect(p99Ms).toBeLessThan(PERF_BUDGETS.auditChainVerify1000Ms);
    });
  });

  // ─── STRICT MODE ───────────────────────────────────────────
  describe('STRICT MODE', () => {
    // ─── HAPPY ──────────────────────────────────────────────
    describe('HAPPY', () => {
      it('strict mode with all chained events → valid', () => {
        const chain = buildChain(3);
        const raw = chain.map((e) => e as unknown as Record<string, unknown>);
        const result = verifyChain(raw, { strict: true });
        expect(result.valid).toBe(true);
        expect(result.reason).toBeNull();
        expect(result.skippedCount).toBe(0);
        expect(result.verifiedCount).toBe(3);
      });

      it('strict mode with single chained event → valid', () => {
        const chain = buildChain(1);
        const raw = chain.map((e) => e as unknown as Record<string, unknown>);
        const result = verifyChain(raw, { strict: true });
        expect(result.valid).toBe(true);
        expect(result.reason).toBeNull();
      });
    });

    // ─── BAD ────────────────────────────────────────────────
    describe('BAD', () => {
      it('strict mode rejects single legacy event', () => {
        const legacyEvent: Record<string, unknown> = {
          id: 'legacy-strict-1',
          sessionId: SESSION_ID,
          phase: 'PLAN',
          event: 'transition:PLAN_READY',
          timestamp: TS1,
          actor: 'machine',
          detail: {},
        };
        const result = verifyChain([legacyEvent], { strict: true });
        expect(result.valid).toBe(false);
        expect(result.reason).toBe('LEGACY_EVENTS_NOT_ALLOWED_IN_STRICT_MODE');
        expect(result.skippedCount).toBe(1);
        expect(result.verifiedCount).toBe(0);
        expect(result.firstBreak).toBeNull();
      });

      it('strict mode rejects multiple legacy events', () => {
        const legacyEvents: Record<string, unknown>[] = [
          {
            id: 'leg-1',
            sessionId: SESSION_ID,
            phase: 'TICKET',
            event: 'e1',
            timestamp: TS1,
            actor: 'machine',
            detail: {},
          },
          {
            id: 'leg-2',
            sessionId: SESSION_ID,
            phase: 'PLAN',
            event: 'e2',
            timestamp: TS2,
            actor: 'machine',
            detail: {},
          },
          {
            id: 'leg-3',
            sessionId: SESSION_ID,
            phase: 'PLAN',
            event: 'e3',
            timestamp: TS3,
            actor: 'machine',
            detail: {},
          },
        ];
        const result = verifyChain(legacyEvents, { strict: true });
        expect(result.valid).toBe(false);
        expect(result.reason).toBe('LEGACY_EVENTS_NOT_ALLOWED_IN_STRICT_MODE');
        expect(result.skippedCount).toBe(3);
      });

      it('strict mode with tampered event → CHAIN_BREAK (not legacy)', () => {
        const chain = buildChain(3);
        const tampered = chain.map((e, i) => {
          if (i === 1) return { ...e, phase: 'TAMPERED' } as unknown as Record<string, unknown>;
          return e as unknown as Record<string, unknown>;
        });
        const result = verifyChain(tampered, { strict: true });
        expect(result.valid).toBe(false);
        expect(result.reason).toBe('CHAIN_BREAK');
        expect(result.firstBreak).not.toBeNull();
      });
    });

    // ─── CORNER ─────────────────────────────────────────────
    describe('CORNER', () => {
      it('strict mode with empty trail → valid (nothing to skip)', () => {
        const result = verifyChain([], { strict: true });
        expect(result.valid).toBe(true);
        expect(result.reason).toBeNull();
        expect(result.skippedCount).toBe(0);
      });

      it('non-strict (default) with legacy events → still valid (backward compat)', () => {
        const legacyEvent: Record<string, unknown> = {
          id: 'legacy-compat',
          sessionId: SESSION_ID,
          phase: 'PLAN',
          event: 'transition:PLAN_READY',
          timestamp: TS1,
          actor: 'machine',
          detail: {},
        };
        const result = verifyChain([legacyEvent]);
        expect(result.valid).toBe(true);
        expect(result.reason).toBeNull();
        expect(result.skippedCount).toBe(1);
      });

      it('explicit strict: false behaves like default (legacy-tolerant)', () => {
        const legacyEvent: Record<string, unknown> = {
          id: 'legacy-explicit-false',
          sessionId: SESSION_ID,
          phase: 'PLAN',
          event: 'transition:PLAN_READY',
          timestamp: TS1,
          actor: 'machine',
          detail: {},
        };
        const result = verifyChain([legacyEvent], { strict: false });
        expect(result.valid).toBe(true);
        expect(result.reason).toBeNull();
        expect(result.skippedCount).toBe(1);
      });
    });

    // ─── EDGE ───────────────────────────────────────────────
    describe('EDGE', () => {
      it('strict mode with mixed chained + legacy → fails on legacy', () => {
        const chain = buildChain(2);
        const legacy: Record<string, unknown> = {
          id: 'legacy-mixed-strict',
          sessionId: SESSION_ID,
          phase: 'PLAN',
          event: 'some:event',
          timestamp: TS2,
          actor: 'machine',
          detail: {},
        };
        const mixed = [
          chain[0] as unknown as Record<string, unknown>,
          legacy,
          chain[1] as unknown as Record<string, unknown>,
        ];
        const result = verifyChain(mixed, { strict: true });
        expect(result.valid).toBe(false);
        expect(result.reason).toBe('LEGACY_EVENTS_NOT_ALLOWED_IN_STRICT_MODE');
        expect(result.skippedCount).toBe(1);
        expect(result.verifiedCount).toBe(2);
        // Chain hashes themselves are valid — the break is due to legacy event
        expect(result.firstBreak).toBeNull();
      });

      it('strict mode: chain break + legacy events → reason is CHAIN_BREAK (severity priority)', () => {
        const chain = buildChain(3);
        const legacy: Record<string, unknown> = {
          id: 'legacy-plus-break',
          sessionId: SESSION_ID,
          phase: 'PLAN',
          event: 'some:event',
          timestamp: TS2,
          actor: 'machine',
          detail: {},
        };
        // Tamper chain[1] AND insert a legacy event
        const tampered = [
          chain[0] as unknown as Record<string, unknown>,
          legacy,
          { ...chain[1], phase: 'TAMPERED' } as unknown as Record<string, unknown>,
          chain[2] as unknown as Record<string, unknown>,
        ];
        const result = verifyChain(tampered, { strict: true });
        expect(result.valid).toBe(false);
        // CHAIN_BREAK wins over LEGACY — more severe
        expect(result.reason).toBe('CHAIN_BREAK');
        expect(result.skippedCount).toBe(1);
        expect(result.firstBreak).not.toBeNull();
      });
    });

    // ─── PERF ───────────────────────────────────────────────
    describe('PERF', () => {
      it('strict mode adds no measurable overhead vs default', () => {
        const chain = buildChain(1000);
        const raw = chain.map((e) => e as unknown as Record<string, unknown>);
        const { p99Ms } = benchmarkSync(() => verifyChain(raw, { strict: true }), 5, 1);
        expect(p99Ms).toBeLessThan(PERF_BUDGETS.auditChainVerify1000Ms);
      });
    });
  });
});

// =============================================================================
// audit/query
// =============================================================================

describe('audit query', () => {
  // ─── Shared events for query tests ─────────────────────────
  const events: AuditEvent[] = [
    makeAuditEvent({
      id: 'e1',
      sessionId: 'sess-a',
      phase: 'TICKET',
      event: 'lifecycle:session_created',
      timestamp: TS1,
      actor: 'system',
    }),
    makeAuditEvent({
      id: 'e2',
      sessionId: 'sess-a',
      phase: 'PLAN',
      event: 'transition:TICKET_SET',
      timestamp: TS1,
      actor: 'machine',
    }),
    makeAuditEvent({
      id: 'e3',
      sessionId: 'sess-a',
      phase: 'PLAN',
      event: 'tool_call:flowguard_plan',
      timestamp: TS2,
      actor: 'user-1',
    }),
    makeAuditEvent({
      id: 'e4',
      sessionId: 'sess-b',
      phase: 'TICKET',
      event: 'lifecycle:session_created',
      timestamp: TS2,
      actor: 'system',
    }),
    makeAuditEvent({
      id: 'e5',
      sessionId: 'sess-a',
      phase: 'VALIDATION',
      event: 'error:CHECK_TIMEOUT',
      timestamp: TS3,
      actor: 'machine',
      detail: { kind: 'error', code: 'CHECK_TIMEOUT' },
    }),
    makeAuditEvent({
      id: 'e6',
      sessionId: 'sess-a',
      phase: 'PLAN_REVIEW',
      event: 'decision:DEC-001',
      timestamp: TS3,
      actor: 'human',
      detail: {
        kind: 'decision',
        decisionId: 'DEC-001',
        decisionSequence: 1,
        gatePhase: 'PLAN_REVIEW',
        verdict: 'approve',
        rationale: 'looks good',
        decidedBy: 'reviewer-1',
        decidedAt: TS3,
        fromPhase: 'PLAN_REVIEW',
        toPhase: 'VALIDATION',
        transitionEvent: 'APPROVE',
        policyMode: 'team',
      },
    }),
  ];

  // ─── HAPPY ──────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('bySession filters by session ID', () => {
      const result = filterEvents(events, bySession('sess-a'));
      expect(result).toHaveLength(5);
      expect(result.every((e) => e.sessionId === 'sess-a')).toBe(true);
    });

    it('byPhase filters by exact phase', () => {
      const result = filterEvents(events, byPhase('PLAN'));
      expect(result).toHaveLength(2);
    });

    it('byKind filters by event kind prefix', () => {
      const result = filterEvents(events, byKind('transition'));
      expect(result).toHaveLength(1);
      expect(result[0]!.event).toBe('transition:TICKET_SET');
    });

    it('byEvent filters by exact event name', () => {
      const result = filterEvents(events, byEvent('lifecycle:session_created'));
      expect(result).toHaveLength(2);
    });

    it('byActor filters by actor', () => {
      const result = filterEvents(events, byActor('system'));
      expect(result).toHaveLength(2);
    });

    it('sessionEvents returns events for a session', () => {
      expect(sessionEvents(events, 'sess-b')).toHaveLength(1);
    });

    it('transitionEvents returns only transition events', () => {
      const result = transitionEvents(events);
      expect(result).toHaveLength(1);
    });

    it('toolCallEvents returns only tool call events', () => {
      const result = toolCallEvents(events);
      expect(result).toHaveLength(1);
      expect(result[0]!.event).toBe('tool_call:flowguard_plan');
    });

    it('errorEvents returns only error events', () => {
      const result = errorEvents(events);
      expect(result).toHaveLength(1);
    });

    it('decisionEvents returns only decision events', () => {
      const result = decisionEvents(events);
      expect(result).toHaveLength(1);
      expect(result[0]!.event).toBe('decision:DEC-001');
    });

    it('decisionReceipts extracts structured receipt fields', () => {
      const receipts = decisionReceipts(events);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]!.decisionId).toBe('DEC-001');
      expect(receipts[0]!.decisionSequence).toBe(1);
      expect(receipts[0]!.verdict).toBe('approve');
      expect(receipts[0]!.policyMode).toBe('team');
    });

    it('distinctSessions returns unique session IDs', () => {
      const ids = distinctSessions(events);
      expect(ids).toHaveLength(2);
      expect(ids).toContain('sess-a');
      expect(ids).toContain('sess-b');
    });

    it('countByKind counts events by kind prefix', () => {
      const counts = countByKind(events);
      expect(counts.lifecycle).toBe(2);
      expect(counts.transition).toBe(1);
      expect(counts.tool_call).toBe(1);
      expect(counts.error).toBe(1);
      expect(counts.decision).toBe(1);
    });

    it('countByPhase counts events per phase', () => {
      const counts = countByPhase(events);
      expect(counts.TICKET).toBe(2);
      expect(counts.PLAN).toBe(2);
      expect(counts.VALIDATION).toBe(1);
    });

    it('timeSpan returns first and last timestamps', () => {
      const span = timeSpan(events);
      expect(span).not.toBeNull();
      expect(span!.first).toBe(TS1);
      expect(span!.last).toBe(TS3);
      expect(span!.durationMs).toBe(120000); // 2 minutes
    });
  });

  // ─── BAD ────────────────────────────────────────────────────
  describe('BAD', () => {
    it('empty events array returns empty results', () => {
      expect(filterEvents([], byPhase('PLAN'))).toHaveLength(0);
      expect(transitionEvents([])).toHaveLength(0);
      expect(decisionReceipts([])).toHaveLength(0);
      expect(distinctSessions([])).toHaveLength(0);
      expect(countByKind([])).toEqual({});
    });

    it('no matching events returns empty', () => {
      expect(filterEvents(events, bySession('nonexistent'))).toHaveLength(0);
      expect(filterEvents(events, byPhase('COMPLETE'))).toHaveLength(0);
    });

    it('timeSpan with empty events returns null', () => {
      expect(timeSpan([])).toBeNull();
    });
  });

  // ─── CORNER ─────────────────────────────────────────────────
  describe('CORNER', () => {
    it("byTimeRange with only 'from' (open-ended to)", () => {
      const result = filterEvents(events, byTimeRange(TS2, null));
      expect(result).toHaveLength(4); // TS2 and TS3 events
    });

    it("byTimeRange with only 'to' (open-ended from)", () => {
      const result = filterEvents(events, byTimeRange(null, TS1));
      expect(result).toHaveLength(2); // Only TS1 events
    });

    it('byTimeRange with both bounds', () => {
      const result = filterEvents(events, byTimeRange(TS2, TS2));
      expect(result).toHaveLength(2); // Exactly TS2 events
    });

    it('byTimeRange with null both → returns all', () => {
      const result = filterEvents(events, byTimeRange(null, null));
      expect(result).toHaveLength(6);
    });

    it('byPhases filters by multiple phases (Set-based)', () => {
      const result = filterEvents(events, byPhases(['TICKET', 'VALIDATION']));
      expect(result).toHaveLength(3);
    });

    it('byDetail matches on a specific detail field value', () => {
      const result = filterEvents(events, byDetail('code', 'CHECK_TIMEOUT'));
      expect(result).toHaveLength(1);
      expect(result[0]!.event).toBe('error:CHECK_TIMEOUT');
    });
  });

  // ─── EDGE ───────────────────────────────────────────────────
  describe('EDGE', () => {
    it('allOf combines filters with AND logic', () => {
      const result = filterEvents(events, allOf(bySession('sess-a'), byPhase('PLAN')));
      expect(result).toHaveLength(2);
    });

    it('anyOf combines filters with OR logic', () => {
      const result = filterEvents(events, anyOf(byPhase('TICKET'), byPhase('VALIDATION')));
      expect(result).toHaveLength(3);
    });

    it('not negates a filter', () => {
      const result = filterEvents(events, not(bySession('sess-a')));
      expect(result).toHaveLength(1);
      expect(result[0]!.sessionId).toBe('sess-b');
    });

    it('allOf with zero filters matches everything', () => {
      const result = filterEvents(events, allOf());
      expect(result).toHaveLength(6);
    });

    it('decisionReceipts skips malformed decision payloads', () => {
      const malformed = makeAuditEvent({
        id: 'bad-decision',
        event: 'decision:DEC-999',
        detail: { kind: 'decision', decisionId: 999 as unknown as string },
      });
      const receipts = decisionReceipts([...events, malformed]);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]!.decisionId).toBe('DEC-001');
    });

    it('anyOf with zero filters matches nothing', () => {
      const result = filterEvents(events, anyOf());
      expect(result).toHaveLength(0);
    });

    it('complex composed query', () => {
      // "sess-a events that are either transitions or errors"
      const filter = allOf(bySession('sess-a'), anyOf(byKind('transition'), byKind('error')));
      const result = filterEvents(events, filter);
      expect(result).toHaveLength(2);
    });
  });

  // ─── PERF ───────────────────────────────────────────────────
  describe('PERF', () => {
    it(`filterEvents with 10000 events < ${PERF_BUDGETS.filterEvents10000Ms}ms (p95)`, () => {
      const largeTrail: AuditEvent[] = Array.from({ length: 10000 }, (_, i) =>
        makeAuditEvent({
          id: `perf-${i}`,
          sessionId: i % 2 === 0 ? 'sess-a' : 'sess-b',
          phase: i % 3 === 0 ? 'PLAN' : 'TICKET',
          event: `transition:EVENT_${i}`,
        }),
      );
      const { p95Ms } = benchmarkSync(
        () => filterEvents(largeTrail, allOf(bySession('sess-a'), byPhase('PLAN'))),
        50,
        10,
      );
      expect(p95Ms).toBeLessThan(PERF_BUDGETS.filterEvents10000Ms);
    });
  });
});

// =============================================================================
// audit/summary
// =============================================================================

describe('audit summary', () => {
  // ─── HAPPY ──────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('generateTimeline produces correct timeline for a complete session', () => {
      const trail = buildSessionTrail();
      const timeline = generateTimeline(trail, SESSION_ID);
      expect(timeline.sessionId).toBe(SESSION_ID);
      expect(timeline.eventCount).toBe(trail.length);
      expect(timeline.timeSpan).not.toBeNull();
      expect(timeline.entries).toHaveLength(trail.length);
      // Phase progression should be deduped
      expect(timeline.phaseProgression).toEqual([
        'TICKET',
        'PLAN',
        'VALIDATION',
        'IMPLEMENTATION',
        'IMPL_REVIEW',
        'EVIDENCE_REVIEW',
        'COMPLETE',
      ]);
    });

    it('generateComplianceSummary passes for complete session with all checks', () => {
      const trail = buildSessionTrail();
      const chainResult = verifyChain([] /* no chained events for this test */);
      const summary = generateComplianceSummary(trail, SESSION_ID, chainResult, TS3);
      expect(summary.sessionId).toBe(SESSION_ID);
      expect(summary.generatedAt).toBe(TS3);
      expect(summary.stats.totalEvents).toBe(trail.length);
      // Check that at least session_created and session_terminated pass
      const createdCheck = summary.checks.find((c) => c.name === 'session_created');
      expect(createdCheck?.passed).toBe(true);
      const terminatedCheck = summary.checks.find((c) => c.name === 'session_terminated');
      expect(terminatedCheck?.passed).toBe(true);
    });

    it('timeline entries have correct structure', () => {
      const trail = buildSessionTrail();
      const timeline = generateTimeline(trail, SESSION_ID);
      const first = timeline.entries[0]!;
      expect(first).toHaveProperty('timestamp');
      expect(first).toHaveProperty('kind');
      expect(first).toHaveProperty('event');
      expect(first).toHaveProperty('phase');
      expect(first).toHaveProperty('actor');
      expect(first).toHaveProperty('description');
      expect(first.kind).toBe('lifecycle');
      expect(first.description).toContain('session created');
    });
  });

  // ─── BAD ────────────────────────────────────────────────────
  describe('BAD', () => {
    it('timeline for nonexistent session → empty', () => {
      const trail = buildSessionTrail();
      const timeline = generateTimeline(trail, 'nonexistent');
      expect(timeline.eventCount).toBe(0);
      expect(timeline.timeSpan).toBeNull();
      expect(timeline.entries).toHaveLength(0);
      expect(timeline.phaseProgression).toHaveLength(0);
    });

    it('compliance for incomplete session flags missing termination', () => {
      // Session with only creation, no completion
      const trail: AuditEvent[] = [
        makeAuditEvent({
          event: 'lifecycle:session_created',
          phase: 'TICKET',
          timestamp: TS1,
          actor: 'system',
          detail: { kind: 'lifecycle', action: 'session_created', finalPhase: 'TICKET' },
        }),
        makeAuditEvent({
          event: 'transition:TICKET_SET',
          phase: 'PLAN',
          timestamp: TS2,
          detail: { from: 'TICKET', to: 'PLAN' },
        }),
      ];
      const summary = generateComplianceSummary(trail, SESSION_ID, null, TS3);
      const terminated = summary.checks.find((c) => c.name === 'session_terminated');
      expect(terminated?.passed).toBe(false);
    });
  });

  // ─── CORNER ─────────────────────────────────────────────────
  describe('CORNER', () => {
    it('compliance summary without chain verification omits chain_integrity check', () => {
      const trail = buildSessionTrail();
      const summary = generateComplianceSummary(trail, SESSION_ID, null, TS3);
      const chainCheck = summary.checks.find((c) => c.name === 'chain_integrity');
      expect(chainCheck).toBeUndefined();
    });

    it('compliance summary with broken chain reports failure', () => {
      const trail = buildSessionTrail();
      const brokenChain = {
        valid: false,
        totalEvents: 10,
        verifiedCount: 8,
        skippedCount: 2,
        firstBreak: { index: 3, eventId: 'broken-event', valid: false, reason: 'tampered' },
        results: [],
        reason: 'CHAIN_BREAK' as const,
      };
      const summary = generateComplianceSummary(trail, SESSION_ID, brokenChain, TS3);
      const chainCheck = summary.checks.find((c) => c.name === 'chain_integrity');
      expect(chainCheck).toBeDefined();
      expect(chainCheck!.passed).toBe(false);
      expect(chainCheck!.detail).toContain('BROKEN');
    });

    it('compliance with error events that are resolved (session reaches COMPLETE)', () => {
      const trail: AuditEvent[] = [
        makeAuditEvent({
          event: 'lifecycle:session_created',
          phase: 'TICKET',
          timestamp: TS1,
          actor: 'system',
          detail: { kind: 'lifecycle', action: 'session_created', finalPhase: 'TICKET' },
        }),
        makeAuditEvent({
          event: 'error:TOOL_TIMEOUT',
          phase: 'PLAN',
          timestamp: TS2,
          actor: 'machine',
          detail: { kind: 'error', code: 'TOOL_TIMEOUT' },
        }),
        makeAuditEvent({
          event: 'lifecycle:session_completed',
          phase: 'COMPLETE',
          timestamp: TS3,
          actor: 'system',
          detail: { kind: 'lifecycle', action: 'session_completed', finalPhase: 'COMPLETE' },
        }),
      ];
      const summary = generateComplianceSummary(trail, SESSION_ID, null, TS3);
      const errorCheck = summary.checks.find((c) => c.name === 'no_unresolved_errors');
      expect(errorCheck?.passed).toBe(true);
    });

    it('empty events for compliance summary produces all-fail checks', () => {
      const summary = generateComplianceSummary([], SESSION_ID, null, TS3);
      expect(summary.stats.totalEvents).toBe(0);
      expect(summary.compliant).toBe(false);
    });
  });

  // ─── EDGE ───────────────────────────────────────────────────
  describe('EDGE', () => {
    it('describeEvent produces correct descriptions for each kind', () => {
      const trail = buildSessionTrail();
      const timeline = generateTimeline(trail, SESSION_ID);
      // lifecycle event
      const lifecycleEntry = timeline.entries.find((e) => e.kind === 'lifecycle');
      expect(lifecycleEntry?.description).toContain('Lifecycle');

      // transition event
      const transitionEntry = timeline.entries.find((e) => e.kind === 'transition');
      expect(transitionEntry?.description).toContain('State transition');

      // tool_call event
      const toolEntry = timeline.entries.find((e) => e.kind === 'tool_call');
      expect(toolEntry?.description).toContain('Tool call');
    });

    it('compliance: review gates not applicable if session never reached those phases', () => {
      const trail: AuditEvent[] = [
        makeAuditEvent({
          event: 'lifecycle:session_created',
          phase: 'TICKET',
          timestamp: TS1,
          actor: 'system',
          detail: { kind: 'lifecycle', action: 'session_created', finalPhase: 'TICKET' },
        }),
        makeAuditEvent({
          event: 'lifecycle:session_aborted',
          phase: 'TICKET',
          timestamp: TS2,
          actor: 'user',
          detail: { kind: 'lifecycle', action: 'session_aborted', finalPhase: 'TICKET' },
        }),
      ];
      const summary = generateComplianceSummary(trail, SESSION_ID, null, TS3);
      const planReview = summary.checks.find((c) => c.name === 'plan_review_honored');
      const evidenceReview = summary.checks.find((c) => c.name === 'evidence_review_honored');
      // Not applicable → passes by default
      expect(planReview?.passed).toBe(true);
      expect(evidenceReview?.passed).toBe(true);
    });
  });

  // ─── PERF ───────────────────────────────────────────────────
  describe('PERF', () => {
    it(`generateComplianceSummary for 500 events < ${PERF_BUDGETS.complianceSummary500Ms}ms (p95)`, () => {
      const largeTrail: AuditEvent[] = Array.from({ length: 500 }, (_, i) =>
        makeAuditEvent({
          id: `perf-${i}`,
          event: `transition:EVENT_${i}`,
          phase: i < 250 ? 'PLAN' : 'VALIDATION',
          timestamp: `2026-01-01T00:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`,
        }),
      );
      const { p95Ms } = benchmarkSync(
        () => generateComplianceSummary(largeTrail, SESSION_ID, null, TS3),
        20,
        5,
      );
      expect(p95Ms).toBeLessThan(PERF_BUDGETS.complianceSummary500Ms);
    });
  });

  // ─── STRICT CHAIN SUMMARY ─────────────────────────────────
  describe('STRICT CHAIN SUMMARY', () => {
    it('compliance summary with strict failure (legacy events) reports STRICT detail', () => {
      const trail = buildSessionTrail();
      const strictFailure = {
        valid: false,
        totalEvents: 5,
        verifiedCount: 3,
        skippedCount: 2,
        firstBreak: null,
        results: [],
        reason: 'LEGACY_EVENTS_NOT_ALLOWED_IN_STRICT_MODE' as const,
      };
      const summary = generateComplianceSummary(trail, SESSION_ID, strictFailure, TS3);
      const chainCheck = summary.checks.find((c) => c.name === 'chain_integrity');
      expect(chainCheck).toBeDefined();
      expect(chainCheck!.passed).toBe(false);
      expect(chainCheck!.detail).toContain('STRICT');
      expect(chainCheck!.detail).toContain('legacy');
      expect(chainCheck!.detail).toContain('2');
    });

    it('compliance summary with strict valid (all chained) passes', () => {
      const trail = buildSessionTrail();
      const strictValid = {
        valid: true,
        totalEvents: 5,
        verifiedCount: 5,
        skippedCount: 0,
        firstBreak: null,
        results: [],
        reason: null,
      };
      const summary = generateComplianceSummary(trail, SESSION_ID, strictValid, TS3);
      const chainCheck = summary.checks.find((c) => c.name === 'chain_integrity');
      expect(chainCheck).toBeDefined();
      expect(chainCheck!.passed).toBe(true);
      expect(chainCheck!.detail).toContain('verified');
    });
  });
});

// =============================================================================
// audit/completeness
// =============================================================================

describe('audit completeness', () => {
  // ─── HAPPY ──────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('evaluateCompleteness at TICKET phase — only ticket required', () => {
      const state = makeState('TICKET', { ticket: null });
      const report = evaluateCompleteness(state);
      expect(report.sessionId).toBe(state.id);
      expect(report.phase).toBe('TICKET');
      expect(report.policyMode).toBe('team');

      // ticket slot is required and missing
      const ticketSlot = report.slots.find((s) => s.slot === 'ticket');
      expect(ticketSlot?.required).toBe(true);
      expect(ticketSlot?.status).toBe('missing');

      // plan slot is not yet required
      const planSlot = report.slots.find((s) => s.slot === 'plan');
      expect(planSlot?.required).toBe(false);
      expect(planSlot?.status).toBe('not_yet_required');
    });

    it('evaluateCompleteness at COMPLETE phase — all complete', () => {
      const state = makeProgressedState('COMPLETE');
      const report = evaluateCompleteness(state);
      expect(report.phase).toBe('COMPLETE');
      expect(report.overallComplete).toBe(true);
      expect(report.summary.complete).toBe(8); // All 8 slots
      expect(report.summary.missing).toBe(0);
      expect(report.summary.failed).toBe(0);
    });

    it('evaluateCompleteness at VALIDATION phase — 4 required, 4 not yet', () => {
      const state = makeProgressedState('VALIDATION');
      const report = evaluateCompleteness(state);
      expect(report.phase).toBe('VALIDATION');
      // ticket, plan, selfReview, planReviewDecision should be required and complete
      const requiredSlots = report.slots.filter((s) => s.required);
      expect(requiredSlots).toHaveLength(4);
      expect(requiredSlots.every((s) => s.status === 'complete')).toBe(true);
    });

    it('four-eyes not required when policy allows self-approval', () => {
      const state = makeProgressedState('COMPLETE');
      const report = evaluateCompleteness(state);
      expect(report.fourEyes.required).toBe(false);
      expect(report.fourEyes.satisfied).toBe(true);
      expect(report.fourEyes.detail).toContain('not required');
    });
  });

  // ─── BAD ────────────────────────────────────────────────────
  describe('BAD', () => {
    it('missing evidence at required phase → missing status', () => {
      // At PLAN phase but no plan evidence
      const state = makeState('PLAN', { ticket: null, plan: null });
      const report = evaluateCompleteness(state);
      const ticketSlot = report.slots.find((s) => s.slot === 'ticket');
      const planSlot = report.slots.find((s) => s.slot === 'plan');
      expect(ticketSlot?.status).toBe('missing');
      expect(planSlot?.status).toBe('missing');
      expect(report.overallComplete).toBe(false);
    });

    it('failed validation evidence → failed status', () => {
      const state = makeState('IMPLEMENTATION', {
        ...makeProgressedState('IMPLEMENTATION'),
        validation: [
          {
            checkId: 'test_quality',
            passed: false,
            detail: 'Missing tests',
            executedAt: FIXED_TIME,
          },
          { checkId: 'rollback_safety', passed: true, detail: 'ok', executedAt: FIXED_TIME },
        ],
      });
      const report = evaluateCompleteness(state);
      const valSlot = report.slots.find((s) => s.slot === 'validation');
      expect(valSlot?.status).toBe('failed');
      expect(valSlot?.detail).toContain('failed: test_quality');
      expect(report.overallComplete).toBe(false);
    });
  });

  // ─── CORNER ─────────────────────────────────────────────────
  describe('CORNER', () => {
    it('four-eyes violated — same person initiated and reviewed', () => {
      const state = makeState('COMPLETE', {
        ...makeProgressedState('COMPLETE'),
        policySnapshot: {
          ...makeProgressedState('COMPLETE').policySnapshot!,
          allowSelfApproval: false,
        },
        initiatedBy: 'alice',
        reviewDecision: {
          verdict: 'approve',
          rationale: 'LGTM',
          decidedAt: FIXED_TIME,
          decidedBy: 'alice', // Same as initiatedBy
        },
      });
      const report = evaluateCompleteness(state);
      expect(report.fourEyes.required).toBe(true);
      expect(report.fourEyes.satisfied).toBe(false);
      expect(report.fourEyes.detail).toContain('VIOLATED');
      expect(report.overallComplete).toBe(false);
    });

    it('four-eyes satisfied — different people', () => {
      const state = makeState('COMPLETE', {
        ...makeProgressedState('COMPLETE'),
        policySnapshot: {
          ...makeProgressedState('COMPLETE').policySnapshot!,
          allowSelfApproval: false,
        },
        initiatedBy: 'alice',
        reviewDecision: {
          verdict: 'approve',
          rationale: 'LGTM',
          decidedAt: FIXED_TIME,
          decidedBy: 'bob',
        },
      });
      const report = evaluateCompleteness(state);
      expect(report.fourEyes.required).toBe(true);
      expect(report.fourEyes.satisfied).toBe(true);
      expect(report.fourEyes.detail).toContain('satisfied');
    });

    it('four-eyes pending — no review decision yet', () => {
      const state = makeState('PLAN_REVIEW', {
        ...makeProgressedState('PLAN_REVIEW'),
        policySnapshot: {
          ...makeProgressedState('PLAN_REVIEW').policySnapshot!,
          allowSelfApproval: false,
        },
        reviewDecision: null,
      });
      const report = evaluateCompleteness(state);
      expect(report.fourEyes.required).toBe(true);
      // No decision yet → decidedBy is null → fourEyesSatisfied is false
      expect(report.fourEyes.satisfied).toBe(false);
      expect(report.fourEyes.detail).toContain('pending');
    });

    it('planReviewDecision slot uses topology invariant (phase >= VALIDATION)', () => {
      // At PLAN_REVIEW: planReviewDecision should be required but missing
      const state = makeProgressedState('PLAN_REVIEW');
      const report = evaluateCompleteness(state);
      const slot = report.slots.find((s) => s.slot === 'planReviewDecision');
      expect(slot?.required).toBe(false); // ordinal 2 < 3 (VALIDATION)
      // At VALIDATION: planReviewDecision should be complete (topology invariant)
      const state2 = makeProgressedState('VALIDATION');
      const report2 = evaluateCompleteness(state2);
      const slot2 = report2.slots.find((s) => s.slot === 'planReviewDecision');
      expect(slot2?.required).toBe(true);
      expect(slot2?.status).toBe('complete');
      expect(slot2?.detail).toContain('topology invariant');
    });

    it('evidenceReviewDecision slot at COMPLETE with error → missing', () => {
      const state = makeState('COMPLETE', {
        ...makeProgressedState('COMPLETE'),
        error: {
          code: 'FATAL',
          message: 'Something broke',
          recoveryHint: 'restart',
          occurredAt: FIXED_TIME,
        },
      });
      const report = evaluateCompleteness(state);
      const slot = report.slots.find((s) => s.slot === 'evidenceReviewDecision');
      expect(slot?.status).toBe('missing');
      expect(slot?.detail).toContain('error');
    });
  });

  // ─── EDGE ───────────────────────────────────────────────────
  describe('EDGE', () => {
    it('slot detail generation for each evidence type', () => {
      const state = makeProgressedState('COMPLETE');
      const report = evaluateCompleteness(state);

      const ticketSlot = report.slots.find((s) => s.slot === 'ticket');
      expect(ticketSlot?.detail).toContain('source:');
      expect(ticketSlot?.detail).toContain('digest:');

      const planSlot = report.slots.find((s) => s.slot === 'plan');
      expect(planSlot?.detail).toContain('v1'); // history.length + 1

      const selfReviewSlot = report.slots.find((s) => s.slot === 'selfReview');
      expect(selfReviewSlot?.detail).toContain('iteration');
      expect(selfReviewSlot?.detail).toContain('verdict:');

      const implSlot = report.slots.find((s) => s.slot === 'implementation');
      expect(implSlot?.detail).toContain('files changed');

      const implReviewSlot = report.slots.find((s) => s.slot === 'implReview');
      expect(implReviewSlot?.detail).toContain('iteration');
    });

    it("no policy snapshot → policyMode is 'unknown'", () => {
      const state = makeState('TICKET', { policySnapshot: undefined as any });
      const report = evaluateCompleteness(state);
      expect(report.policyMode).toBe('unknown');
    });

    it('summary counts add up to total slots', () => {
      const state = makeProgressedState('VALIDATION');
      const report = evaluateCompleteness(state);
      const { complete, missing, notYetRequired, failed } = report.summary;
      expect(complete + missing + notYetRequired + failed).toBe(report.summary.total);
      expect(report.summary.total).toBe(8);
    });
  });

  // ─── PERF ───────────────────────────────────────────────────
  describe('PERF', () => {
    it('evaluateCompleteness < 2ms (p99 over 200 iterations)', () => {
      const state = makeProgressedState('COMPLETE');
      const { p99Ms } = benchmarkSync(() => evaluateCompleteness(state), 200, 50);
      expect(p99Ms).toBeLessThan(PERF_BUDGETS.completenessEvalMs);
    });
  });
});
