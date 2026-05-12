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
} from './types.js';
import { benchmarkSync, PERF_BUDGETS } from '../test-policy.js';
import { SESSION_ID, TS1, TS2, TS3 } from './audit-test-helpers.js';
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
      const event = createToolCallEvent({
        sessionId: SESSION_ID,
        phase: 'PLAN',
        detail: {
          tool: 'flowguard_plan',
          argsSummary: { text: 'fix auth' },
          success: true,
          transitionCount: 1,
        },
        timestamp: TS1,
        actor: 'user-1',
        prevHash: GENESIS_HASH,
      });
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
      const event = createDecisionEvent({
        sessionId: SESSION_ID,
        gatePhase: 'PLAN_REVIEW',
        detail: {
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
        timestamp: TS1,
        actor: 'human',
        prevHash: GENESIS_HASH,
      });
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
      const event = createToolCallEvent({
        sessionId: SESSION_ID,
        phase: 'PLAN',
        detail: { tool: 'flowguard_plan', argsSummary: {}, success: true, transitionCount: 1 },
        timestamp: TS1,
        actor: 'user',
        prevHash: GENESIS_HASH,
        actorInfo: actor,
      });
      expect(event.actorInfo).toEqual(actor);
      expect(event.actor).toBe('user');
    });

    it('decision event contains actorInfo when provided', () => {
      const actor: ActorInfo = { id: 'reviewer', email: 'rev@co.com', source: 'env' };
      const event = createDecisionEvent({
        sessionId: SESSION_ID,
        gatePhase: 'PLAN_REVIEW',
        detail: {
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
        timestamp: TS1,
        actor: 'human',
        prevHash: GENESIS_HASH,
        actorInfo: actor,
      });
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
      const tc = createToolCallEvent({
        sessionId: SESSION_ID,
        phase: 'PLAN',
        detail: { tool: 'test', argsSummary: {}, success: true, transitionCount: 0 },
        timestamp: TS1,
        actor: 'user',
        prevHash: GENESIS_HASH,
      });
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
      const d = createDecisionEvent({
        sessionId: SESSION_ID,
        gatePhase: 'PLAN_REVIEW',
        detail: {
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
        timestamp: TS1,
        actor: 'human',
        prevHash: GENESIS_HASH,
      });

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