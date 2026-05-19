/**
 * @module integration/plugin-audit.test
 * @description Direct tests for the plugin audit module.
 *
 * Verifies audit event emission, prevHash threading, failure modes
 * (regulated vs solo), decision receipt handling, and lifecycle events.
 * All deps are injected via makeDeps() — no vi.mock, no Hoisting risk.
 *
 * @test-policy HAPPY, BAD, CORNER
 * @version v1
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runAudit, type AuditDeps } from './plugin-audit.js';

// ─── Deps Factory ──────────────────────────────────────────────────────────

let chainSeq: number;

function resetChainSeq(): void {
  chainSeq = 0;
}

function makeDeps(overrides: Partial<AuditDeps> = {}): AuditDeps {
  return {
    resolveFingerprint: vi.fn().mockResolvedValue('fp-abc'),
    getSessionDir: vi.fn().mockReturnValue('/tmp/sess-dir'),
    resolveSessionPolicy: vi.fn().mockResolvedValue({
      policy: {
        audit: { emitToolCalls: true, emitTransitions: true, enableChainHash: true },
        actorClassification: {},
        mode: 'solo',
        requireHumanGates: false,
      },
      state: null,
    }),
    initChain: vi.fn().mockResolvedValue('prev-hash-001'),
    invalidateChainState: vi.fn(),
    // Chain-threading contract: appendAndTrack mutates evt.chainHash.
    // plugin-audit.ts reads evt.chainHash! after every call to thread prevHash.
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

const SESSION_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const FIXED_DECISION_AT = '2026-05-15T12:00:00.000Z';

// ─── H1: Noop ohne Session-Dir ────────────────────────────────────────────

describe('runAudit', () => {
  describe('HAPPY', () => {
    it('returns undefined when no session dir exists', async () => {
      const deps = makeDeps({ getSessionDir: vi.fn().mockReturnValue(null) });

      const result = await runAudit(deps, 'flowguard_plan', {}, {}, SESSION_ID);

      expect(result).toBeUndefined();
      expect(deps.initChain).not.toHaveBeenCalled();
      expect(deps.appendAndTrack).not.toHaveBeenCalled();
    });

    // ─── H2: tool_call emitted ──────────────────────────────────────

    it('emits tool_call event with correct phase and tool name', async () => {
      resetChainSeq();
      const deps = makeDeps();
      const output = { phase: 'PLAN', error: false };

      await runAudit(deps, 'flowguard_plan', { args: { key: 'val' } }, output, SESSION_ID);

      expect(deps.appendAndTrack).toHaveBeenCalledWith(
        expect.objectContaining({ detail: expect.objectContaining({ kind: 'tool_call' }) }),
        expect.any(String),
        true,
        SESSION_ID,
      );
      const call = (deps.appendAndTrack as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      const detail = call.detail as Record<string, unknown>;
      expect(detail.kind).toBe('tool_call');
      expect(detail.tool).toBe('flowguard_plan');
      expect(call.phase).toBe('PLAN');
    });

    // ─── H3: tool_call NOT emitted when disabled ────────────────────

    it('does NOT emit tool_call when emitToolCalls is false', async () => {
      resetChainSeq();
      const deps = makeDeps({
        resolveSessionPolicy: vi.fn().mockResolvedValue({
          policy: {
            audit: { emitToolCalls: false, emitTransitions: true, enableChainHash: true },
            actorClassification: {},
            mode: 'solo',
            requireHumanGates: false,
          },
          state: null,
        }),
      });
      const output = { phase: 'PLAN', error: false };

      await runAudit(deps, 'flowguard_plan', {}, output, SESSION_ID);

      expect(deps.appendAndTrack).not.toHaveBeenCalledWith(
        expect.objectContaining({ detail: expect.objectContaining({ kind: 'tool_call' }) }),
        expect.any(String),
        true,
        SESSION_ID,
      );
    });

    // ─── H4: transitions + prevHash threading ───────────────────────

    it('emits transition events with correct prevHash threading', async () => {
      resetChainSeq();
      const deps = makeDeps();
      const output = {
        phase: 'PLAN',
        error: false,
        _audit: {
          transitions: [
            {
              event: 'PLAN_READY',
              from: 'TICKET',
              to: 'PLAN',
              at: FIXED_DECISION_AT,
            },
          ],
        },
      };

      await runAudit(deps, 'flowguard_plan', {}, output, SESSION_ID);

      const calls = (deps.appendAndTrack as ReturnType<typeof vi.fn>).mock.calls;

      // First call: tool_call with initial prevHash
      const firstEvt = calls[0]![0] as Record<string, unknown>;
      const firstDetail = firstEvt.detail as Record<string, unknown>;
      expect(firstDetail.kind).toBe('tool_call');
      expect(firstEvt.prevHash).toBe('prev-hash-001');

      // Second call: transition with prevHash = chainHash of first event
      // Note: prevHash threading uses the real computed chainHash from
      // finalizeWithTimestampEvidence, not the mock-mutated value.
      const secondEvt = calls[1]![0] as Record<string, unknown>;
      const secondDetail = secondEvt.detail as Record<string, unknown>;
      expect(secondDetail.kind).toBe('transition');
      expect(typeof secondEvt.prevHash).toBe('string');
      expect((secondEvt.prevHash as string).length).toBe(64);
    });

    // ─── H4b: metadata.transitions channel (contract gate) ───────────

    it('reads transitions from metadata.transitions (FG-267 contract gate)', async () => {
      resetChainSeq();
      const deps = makeDeps();
      const output = {
        title: 'flowguard_plan',
        output: JSON.stringify({ phase: 'PLAN', error: false }),
        metadata: {
          transitions: [
            {
              event: 'PLAN_READY',
              from: 'TICKET',
              to: 'PLAN',
              at: FIXED_DECISION_AT,
            },
          ],
        },
      };

      await runAudit(deps, 'flowguard_plan', {}, output, SESSION_ID);

      expect(deps.appendAndTrack).toHaveBeenCalledWith(
        expect.objectContaining({ detail: expect.objectContaining({ kind: 'transition' }) }),
        expect.any(String),
        true,
        SESSION_ID,
      );
    });

    it('falls back to _audit.transitions when metadata is absent', async () => {
      resetChainSeq();
      const deps = makeDeps();
      const output = {
        title: 'flowguard_plan',
        output: JSON.stringify({
          phase: 'PLAN',
          error: false,
          _audit: {
            transitions: [
              { event: 'PLAN_READY', from: 'TICKET', to: 'PLAN', at: FIXED_DECISION_AT },
            ],
          },
        }),
      };

      await runAudit(deps, 'flowguard_plan', {}, output, SESSION_ID);

      expect(deps.appendAndTrack).toHaveBeenCalledWith(
        expect.objectContaining({ detail: expect.objectContaining({ kind: 'transition' }) }),
        expect.any(String),
        true,
        SESSION_ID,
      );
    });

    it('metadata.transitions wins when both channels are present', async () => {
      resetChainSeq();
      const deps = makeDeps();
      const output = {
        title: 'flowguard_plan',
        output: JSON.stringify({
          phase: 'PLAN',
          error: false,
          _audit: { transitions: [{ event: 'LEGACY', from: 'X', to: 'Y', at: FIXED_DECISION_AT }] },
        }),
        metadata: {
          transitions: [{ event: 'PLAN_READY', from: 'TICKET', to: 'PLAN', at: FIXED_DECISION_AT }],
        },
      };

      await runAudit(deps, 'flowguard_plan', {}, output, SESSION_ID);

      const transitionCalls = (deps.appendAndTrack as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => {
          const evtDetail = (c[0] as Record<string, unknown>).detail as Record<string, unknown>;
          return evtDetail?.kind === 'transition';
        },
      );
      const evtDetail = transitionCalls[0]![0] as Record<string, unknown>;
      const transitionDetail = evtDetail.detail as Record<string, unknown>;
      expect(transitionDetail.event).toBe('PLAN_READY');
    });

    // ─── H5: hydrate lifecycle + reason string ──────────────────────

    it('emits session_created lifecycle for flowguard_hydrate with reason', async () => {
      resetChainSeq();
      const deps = makeDeps();
      const output = {
        phase: 'TICKET',
        error: false,
        policyResolution: {
          requestedMode: 'regulated',
          effectiveMode: 'solo',
          source: 'local',
          reason: 'degraded',
        },
      };

      await runAudit(deps, 'flowguard_hydrate', {}, output, SESSION_ID);

      expect(deps.appendAndTrack).toHaveBeenCalledWith(
        expect.objectContaining({ detail: expect.objectContaining({ kind: 'lifecycle' }) }),
        expect.any(String),
        true,
        SESSION_ID,
      );
      const lifecycleCall = (deps.appendAndTrack as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: unknown[]) => {
          const evtDetail = (c[0] as Record<string, unknown>).detail as Record<string, unknown>;
          return evtDetail?.kind === 'lifecycle';
        },
      );
      const lifecycleEvent = lifecycleCall![0] as Record<string, unknown>;
      const detail = lifecycleEvent.detail as Record<string, unknown>;
      expect(detail.action).toBe('session_created');
      expect(detail.reason).toEqual(expect.stringContaining('requested_mode'));
      expect(detail.reason).toEqual(expect.stringContaining('effective_mode'));
      expect(detail.reason).toEqual(expect.stringContaining('requested_mode:regulated'));
      expect(detail.reason).toEqual(expect.stringContaining('effective_mode:solo'));
    });
  });

  // ─── BAD ──────────────────────────────────────────────────────────────

  describe('BAD', () => {
    beforeEach(() => {
      resetChainSeq();
    });

    // ─── B1: Append-Fehler in regulated → block ────────────────────

    it('blocks with AUDIT_PERSISTENCE_FAILED in regulated mode', async () => {
      const deps = makeDeps({
        mode: 'regulated',
        resolveSessionPolicy: vi.fn().mockResolvedValue({
          policy: {
            audit: { emitToolCalls: true, emitTransitions: false, enableChainHash: true },
            actorClassification: {},
            mode: 'regulated',
            requireHumanGates: false,
          },
          state: null,
        }),
        appendAndTrack: vi.fn().mockRejectedValue(new Error('disk full')),
      });
      const output = { phase: 'TICKET', error: false };

      const result = await runAudit(deps, 'flowguard_plan', {}, output, SESSION_ID);

      expect(result).toEqual({
        auditOk: false,
        block: true,
        code: 'AUDIT_PERSISTENCE_FAILED',
        reason: 'disk full',
      });
    });

    // ─── B2: Append-Fehler in solo → warn ─────────────────────────

    it('warns and returns undefined in solo mode', async () => {
      const deps = makeDeps({
        mode: 'solo',
        appendAndTrack: vi.fn().mockRejectedValue(new Error('disk full')),
      });
      const output = { phase: 'TICKET', error: false };

      const result = await runAudit(deps, 'flowguard_plan', {}, output, SESSION_ID);

      expect(result).toBeUndefined();
      expect(deps.logError).toHaveBeenCalledWith(
        expect.stringContaining('Failed to write audit events'),
        expect.any(Error),
      );
    });

    // ─── B3: resolveSessionPolicy throws → block even in solo ─────

    it('blocks when resolveSessionPolicy throws, even in solo mode', async () => {
      const deps = makeDeps({
        mode: 'solo',
        resolveSessionPolicy: vi.fn().mockRejectedValue(new Error('policy read failure')),
      });

      const result = await runAudit(deps, 'flowguard_plan', {}, {}, SESSION_ID);

      expect(result).toMatchObject({
        auditOk: false,
        block: true,
        code: 'AUDIT_PERSISTENCE_FAILED',
      });
    });

    // ─── B4: missing decidedBy → error event ──────────────────────

    it('emits error event when decidedBy is missing in flowguard_decision', async () => {
      const deps = makeDeps();
      const output = {
        phase: 'PLAN_REVIEW',
        error: false,
        _audit: {
          transitions: [
            { event: 'APPROVE', from: 'PLAN_REVIEW', to: 'PLAN', at: FIXED_DECISION_AT },
          ],
        },
        reviewDecision: {
          rationale: 'looks good',
          decidedAt: FIXED_DECISION_AT,
          // decidedBy intentionally missing
        },
      };

      await runAudit(deps, 'flowguard_decision', {}, output, SESSION_ID);

      expect(deps.appendAndTrack).toHaveBeenCalledWith(
        expect.objectContaining({ detail: expect.objectContaining({ kind: 'error' }) }),
        expect.any(String),
        true,
        SESSION_ID,
      );
      const errorCall = (deps.appendAndTrack as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: unknown[]) => {
          const evtDetail = (c[0] as Record<string, unknown>).detail as Record<string, unknown>;
          return evtDetail?.kind === 'error';
        },
      );
      const errorDetail = (errorCall![0] as Record<string, unknown>).detail as Record<
        string,
        unknown
      >;
      expect(errorDetail.code).toBe('DECISION_RECEIPT_ACTOR_MISSING');
    });
  });

  // ─── CORNER ────────────────────────────────────────────────────────────

  describe('CORNER', () => {
    beforeEach(() => {
      resetChainSeq();
    });

    // ─── C1: decision receipt with decidedBy ───────────────────────
    // Decision receipts are emitted independently from transition audit emission.

    it('emits decision event for flowguard_decision with decidedBy present', async () => {
      const deps = makeDeps({
        resolveSessionPolicy: vi.fn().mockResolvedValue({
          policy: {
            audit: { emitToolCalls: false, emitTransitions: false, enableChainHash: true },
            actorClassification: {},
            mode: 'solo',
            requireHumanGates: false,
          },
          state: null,
        }),
      });
      const output = {
        phase: 'PLAN_REVIEW',
        error: false,
        _audit: {
          transitions: [
            { event: 'APPROVE', from: 'PLAN_REVIEW', to: 'PLAN', at: FIXED_DECISION_AT },
          ],
        },
        reviewDecision: {
          decidedBy: 'opencode/big-pickle',
          rationale: 'looks good',
          decidedAt: FIXED_DECISION_AT,
        },
      };

      await runAudit(deps, 'flowguard_decision', {}, output, SESSION_ID);

      expect(deps.appendAndTrack).toHaveBeenCalledWith(
        expect.objectContaining({ detail: expect.objectContaining({ kind: 'decision' }) }),
        expect.any(String),
        true,
        SESSION_ID,
      );
      const decisionCall = (deps.appendAndTrack as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: unknown[]) => {
          const evtDetail = (c[0] as Record<string, unknown>).detail as Record<string, unknown>;
          return evtDetail?.kind === 'decision';
        },
      );
      const detail = (decisionCall![0] as Record<string, unknown>).detail as Record<
        string,
        unknown
      >;
      expect(detail.verdict).toBe('approve');
      expect(detail.decisionSequence).toBe(1);
    });
  });
});
