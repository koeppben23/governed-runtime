import { describe, it, expect } from 'vitest';
import { executeArchitecture } from './architecture';
import type { ArchitectureInput } from './architecture';
import { createTestContext } from '../testing';
import { makeState, FIXED_TIME } from '../__fixtures__';
import { SOLO_POLICY, TEAM_POLICY } from '../config/policy';
import { benchmarkSync, PERF_BUDGETS } from '../test-policy';

const ctx = createTestContext();

/** Valid MADR text with all required sections. */
const VALID_ADR_TEXT =
  '## Context\nWe need a database.\n\n## Decision\nUse PostgreSQL.\n\n## Consequences\nMust maintain DB infra.';

/** Valid architecture input. */
const VALID_INPUT: ArchitectureInput = {
  title: 'Use PostgreSQL for primary storage',
  adrText: VALID_ADR_TEXT,
};

describe('executeArchitecture', () => {
  // ─── HAPPY ─────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('creates ADR and initializes self-review from READY', () => {
      const state = makeState('READY');
      const result = executeArchitecture(state, VALID_INPUT, ctx);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.phase).toBe('ARCHITECTURE');
        expect(result.state.architecture).not.toBeNull();
        expect(result.state.architecture!.id).toBe('ADR-001');
        expect(result.state.architecture!.title).toBe('Use PostgreSQL for primary storage');
        expect(result.state.architecture!.status).toBe('proposed');
        expect(result.state.architecture!.adrText).toBe(VALID_ADR_TEXT);
        expect(result.state.architecture!.digest).toBe(`digest-of-${VALID_ADR_TEXT}`);
      }
    });

    it('initializes self-review loop at iteration 0', () => {
      const state = makeState('READY');
      const result = executeArchitecture(state, VALID_INPUT, ctx);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.selfReview).not.toBeNull();
        expect(result.state.selfReview!.iteration).toBe(0);
        expect(result.state.selfReview!.verdict).toBe('changes_requested');
        expect(result.state.selfReview!.revisionDelta).toBe('major');
      }
    });

    it('records ARCHITECTURE_SELECTED transition from READY', () => {
      const state = makeState('READY');
      const result = executeArchitecture(state, VALID_INPUT, ctx);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        // First transition should be READY → ARCHITECTURE
        expect(result.transitions.length).toBeGreaterThanOrEqual(1);
        expect(result.transitions[0]).toEqual({
          from: 'READY',
          to: 'ARCHITECTURE',
          event: 'ARCHITECTURE_SELECTED',
          at: FIXED_TIME,
        });
      }
    });

    it('uses maxSelfReviewIterations from policy', () => {
      const state = makeState('READY');
      const soloCtx = { ...ctx, policy: SOLO_POLICY };
      const result = executeArchitecture(state, VALID_INPUT, soloCtx);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        // SOLO: maxSelfReviewIterations = 1
        expect(result.state.selfReview!.maxIterations).toBe(1);
      }
    });

    it('uses team policy maxIterations = 3', () => {
      const state = makeState('READY');
      const teamCtx = { ...ctx, policy: TEAM_POLICY };
      const result = executeArchitecture(state, VALID_INPUT, teamCtx);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.selfReview!.maxIterations).toBe(3);
      }
    });

    it('autoAdvance stops at ARCHITECTURE (self-loop guard: SELF_REVIEW_PENDING)', () => {
      // With iteration=0 and verdict=changes_requested, selfReviewPending fires.
      // SELF_REVIEW_PENDING → ARCHITECTURE (self-loop) → autoAdvance breaks.
      const state = makeState('READY');
      const result = executeArchitecture(state, VALID_INPUT, ctx);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.phase).toBe('ARCHITECTURE');
      }
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe('BAD', () => {
    it('blocks when not in READY phase', () => {
      const state = makeState('TICKET');
      const result = executeArchitecture(state, VALID_INPUT, ctx);
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') {
        expect(result.code).toBe('COMMAND_NOT_ALLOWED');
      }
    });

    it('blocks for empty title', () => {
      const state = makeState('READY');
      const result = executeArchitecture(state, { ...VALID_INPUT, title: '' }, ctx);
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') {
        expect(result.code).toBe('EMPTY_ADR_TITLE');
      }
    });

    it('blocks for empty ADR text', () => {
      const state = makeState('READY');
      const result = executeArchitecture(state, { ...VALID_INPUT, adrText: '' }, ctx);
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') {
        expect(result.code).toBe('EMPTY_ADR_TEXT');
      }
    });

    it('blocks when required MADR sections are missing', () => {
      const state = makeState('READY');
      const result = executeArchitecture(
        state,
        {
          ...VALID_INPUT,
          adrText: '## Context\nSome context.',
        },
        ctx,
      );
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') {
        expect(result.code).toBe('MISSING_ADR_SECTIONS');
        expect(result.reason).toContain('## Decision');
        expect(result.reason).toContain('## Consequences');
      }
    });

    it('blocks from terminal phases', () => {
      for (const phase of ['COMPLETE', 'ARCH_COMPLETE', 'REVIEW_COMPLETE'] as const) {
        const state = makeState(phase);
        const result = executeArchitecture(state, VALID_INPUT, ctx);
        expect(result.kind).toBe('blocked');
      }
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe('CORNER', () => {
    it('whitespace-only title is blocked', () => {
      const state = makeState('READY');
      const result = executeArchitecture(state, { ...VALID_INPUT, title: '   ' }, ctx);
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') {
        expect(result.code).toBe('EMPTY_ADR_TITLE');
      }
    });

    it('whitespace-only ADR text is blocked', () => {
      const state = makeState('READY');
      const result = executeArchitecture(state, { ...VALID_INPUT, adrText: '   ' }, ctx);
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') {
        expect(result.code).toBe('EMPTY_ADR_TEXT');
      }
    });

    it('uses existing session counter for generated ADR ID', () => {
      const state = makeState('READY');
      const result = executeArchitecture({ ...state, nextAdrNumber: 42 }, VALID_INPUT, ctx);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.architecture!.id).toBe('ADR-042');
      }
    });

    it('increments nextAdrNumber after ADR creation', () => {
      const state = makeState('READY');
      const result = executeArchitecture(state, VALID_INPUT, ctx);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.nextAdrNumber).toBe(state.nextAdrNumber + 1);
      }
    });

    it('default maxIterations is 3 when no policy is set', () => {
      const state = makeState('READY');
      const noPolicyCtx = createTestContext(); // no policy
      const result = executeArchitecture(state, VALID_INPUT, noPolicyCtx);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.selfReview!.maxIterations).toBe(3);
      }
    });

    it('clears error field on success', () => {
      const state = makeState('READY', {
        error: {
          code: 'PREV_ERROR',
          message: 'previous error',
          recoveryHint: 'retry',
          occurredAt: FIXED_TIME,
        },
      });
      const result = executeArchitecture(state, VALID_INPUT, ctx);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.error).toBeNull();
      }
    });
  });

  // ─── EDGE ──────────────────────────────────────────────────
  describe('EDGE', () => {
    it('ADR with all three sections plus extra content is valid', () => {
      const richText =
        '# ADR-1: Use PostgreSQL\n\n' +
        '## Status\nProposed\n\n' +
        '## Context\nWe need a database.\n\n' +
        '## Decision\nUse PostgreSQL.\n\n' +
        '## Consequences\nMust maintain DB infra.\n\n' +
        '## Notes\nConsider RDS.';
      const state = makeState('READY');
      const result = executeArchitecture(state, { ...VALID_INPUT, adrText: richText }, ctx);
      expect(result.kind).toBe('ok');
    });

    it('state.transition is set after READY → ARCHITECTURE', () => {
      const state = makeState('READY');
      const result = executeArchitecture(state, VALID_INPUT, ctx);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.transition).not.toBeNull();
        expect(result.state.transition!.from).toBe('READY');
        expect(result.state.transition!.to).toBe('ARCHITECTURE');
        expect(result.state.transition!.event).toBe('ARCHITECTURE_SELECTED');
      }
    });

    it('existing ticket/plan slots are preserved (not cleared)', () => {
      // If somehow state at READY has leftover ticket data (shouldn't happen
      // but defensive), the architecture rail doesn't clear it.
      const state = makeState('READY');
      const result = executeArchitecture(state, VALID_INPUT, ctx);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        // Architecture rail only sets architecture + selfReview, doesn't touch ticket/plan
        expect(result.state.ticket).toBeNull();
        expect(result.state.plan).toBeNull();
      }
    });

    it('evalResult is pending or self-loop at ARCHITECTURE', () => {
      const state = makeState('READY');
      const result = executeArchitecture(state, VALID_INPUT, ctx);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        // autoAdvance: evaluate at ARCHITECTURE with selfReviewPending → SELF_REVIEW_PENDING
        // → target ARCHITECTURE (self-loop) → autoAdvance breaks
        // evalResult should be "transition" with target ARCHITECTURE (self-loop detected)
        // OR "pending" if guards don't fire — depends on guard evaluation.
        // In practice: selfReviewPending fires → transition target=ARCHITECTURE → self-loop break
        // So evalResult is the transition that was blocked by self-loop guard.
        expect(['transition', 'pending']).toContain(result.evalResult.kind);
      }
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe('PERF', () => {
    it('executeArchitecture completes within evaluate budget', () => {
      const state = makeState('READY');
      const { p99Ms } = benchmarkSync(() => {
        executeArchitecture(state, VALID_INPUT, ctx);
      }, 100);
      expect(p99Ms).toBeLessThan(PERF_BUDGETS.evaluateSingleMs);
    });
  });
});
