import { describe, it, expect } from 'vitest';
import { evaluateCompleteness } from './completeness.js';
import { makeState, makeProgressedState, FIXED_TIME, FIXED_SESSION_UUID } from '../__fixtures__.js';
import { benchmarkSync, PERF_BUDGETS } from '../test-policy.js';
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

    it('architecture flow evaluates arch-specific slots', () => {
      const state = makeState('ARCHITECTURE', { architecture: null });
      const report = evaluateCompleteness(state);
      expect(report.phase).toBe('ARCHITECTURE');
      const archSlot = report.slots.find((s) => s.slot === 'architecture');
      expect(archSlot?.required).toBe(true);
      expect(archSlot?.status).toBe('missing');
    });

    it('review flow has no evidence slots (standalone artifact)', () => {
      const state = makeState('REVIEW');
      const report = evaluateCompleteness(state);
      expect(report.slots).toHaveLength(0);
      // 0 slots → missing=0, failed=0, phase !== READY → overallComplete is vacuously true
      expect(report.overallComplete).toBe(true);
    });

    it('architecture flow at ARCH_COMPLETE with accepted ADR — all complete', () => {
      const state = makeProgressedState('ARCH_COMPLETE');
      const report = evaluateCompleteness(state);
      expect(report.phase).toBe('ARCH_COMPLETE');
      expect(report.overallComplete).toBe(true);
    });

    it('four-eyes pending when no review decision recorded', () => {
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
      expect(report.fourEyes.satisfied).toBe(false);
      expect(report.fourEyes.detail).toContain('pending');
    });

    it('evidenceReviewDecision slot is not_yet_required at PLAN phase', () => {
      const state = makeState('PLAN', {
        error: {
          code: 'TOOL_ERROR',
          message: 'broke',
          recoveryHint: 'retry',
          occurredAt: FIXED_TIME,
        },
      });
      const report = evaluateCompleteness(state);
      const slot = report.slots.find((s) => s.slot === 'evidenceReviewDecision');
      // Required from COMPLETE (ordinal 7), PLAN is ordinal 1 → not yet required
      expect(slot?.required).toBe(false);
      expect(slot?.status).toBe('not_yet_required');
    });

    it('planReviewDecision slot is complete at VALIDATION phase', () => {
      const state = makeProgressedState('VALIDATION');
      const report = evaluateCompleteness(state);
      const slot = report.slots.find((s) => s.slot === 'planReviewDecision');
      expect(slot?.required).toBe(true);
      expect(slot?.status).toBe('complete');
      expect(slot?.detail).toContain('topology invariant');
    });

    it('overallComplete is false at READY phase', () => {
      const state = makeState('READY');
      const report = evaluateCompleteness(state);
      expect(report.overallComplete).toBe(false);
    });

    it('all phases of ticket flow have correct slot requirements', () => {
      // Test each phase of the ticket flow and verify required slot counts
      const phases: Array<{ phase: string; expectedRequired: number; expectedTotal: number }> = [
        { phase: 'READY', expectedRequired: 0, expectedTotal: 8 },
        { phase: 'TICKET', expectedRequired: 1, expectedTotal: 8 }, // ticket
        { phase: 'PLAN', expectedRequired: 2, expectedTotal: 8 }, // ticket, plan
        { phase: 'PLAN_REVIEW', expectedRequired: 3, expectedTotal: 8 }, // +selfReview
        { phase: 'VALIDATION', expectedRequired: 4, expectedTotal: 8 }, // +planReviewDecision
        { phase: 'IMPLEMENTATION', expectedRequired: 5, expectedTotal: 8 }, // +validation
        { phase: 'IMPL_REVIEW', expectedRequired: 6, expectedTotal: 8 }, // +implementation
        { phase: 'EVIDENCE_REVIEW', expectedRequired: 7, expectedTotal: 8 }, // +implReview
        { phase: 'COMPLETE', expectedRequired: 8, expectedTotal: 8 }, // +evidenceReviewDecision
      ];
      for (const { phase, expectedRequired } of phases) {
        const state =
          phase === 'READY' || phase === 'TICKET' ? makeState(phase) : makeProgressedState(phase);
        const report = evaluateCompleteness(state);
        const required = report.slots.filter((s) => s.required);
        expect(required.length).toBe(expectedRequired);
      }
    });

    it('slot detail includes digest for ticket evidence', () => {
      const state = makeProgressedState('COMPLETE');
      const report = evaluateCompleteness(state);
      const ticketSlot = report.slots.find((s) => s.slot === 'ticket');
      expect(ticketSlot?.detail).toContain('source: user');
    });

    it('slot detail includes status for architecture evidence', () => {
      const state = makeProgressedState('ARCH_COMPLETE');
      const report = evaluateCompleteness(state);
      const archSlot = report.slots.find((s) => s.slot === 'architecture');
      expect(archSlot?.detail).toContain('status: accepted');
    });

    it('slot detail includes file count for implementation evidence', () => {
      const state = makeProgressedState('COMPLETE');
      const report = evaluateCompleteness(state);
      const implSlot = report.slots.find((s) => s.slot === 'implementation');
      expect(implSlot?.detail).toContain('files changed');
      expect(implSlot?.detail).toContain('digest:');
    });

    it('slot detail shows failed check ids in validation', () => {
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
      expect(valSlot?.detail).toContain('failed: test_quality');
    });

    // ─── MUTATION KILL: arch flow and error conditions ────────
    it('archReviewDecision slot is NOT present at ARCH_COMPLETE with error', () => {
      const state = makeState('ARCH_COMPLETE', {
        ...makeProgressedState('ARCH_COMPLETE'),
        error: {
          code: 'ADR_REJECTED',
          message: 'ADR rejected',
          recoveryHint: 'revise',
          occurredAt: FIXED_TIME,
        },
      });
      const report = evaluateCompleteness(state);
      const slot = report.slots.find((s) => s.slot === 'archReviewDecision');
      // At ARCH_COMPLETE but with error → NOT present (topology invariant fails)
      expect(slot?.present).toBe(false);
      expect(slot?.status).toBe('missing');
    });

    it('archReviewDecision slot is present at ARCH_COMPLETE without error', () => {
      const state = makeProgressedState('ARCH_COMPLETE');
      const report = evaluateCompleteness(state);
      const slot = report.slots.find((s) => s.slot === 'archReviewDecision');
      expect(slot?.present).toBe(true);
      expect(slot?.status).toBe('complete');
    });

    it('archReviewDecision slot is NOT present at ARCH_REVIEW (wrong phase)', () => {
      const state = makeState('ARCH_REVIEW', {
        architecture: makeProgressedState('ARCH_COMPLETE').architecture,
        selfReview: {
          iteration: 1,
          maxIterations: 3,
          prevDigest: null,
          currDigest: 'abc',
          revisionDelta: 'none',
          verdict: 'approve',
        },
      });
      const report = evaluateCompleteness(state);
      const slot = report.slots.find((s) => s.slot === 'archReviewDecision');
      // At ARCH_REVIEW, archReviewDecision is required (ordinal 2 >= 2) but NOT present
      // because phase !== ARCH_COMPLETE
      expect(slot?.present).toBe(false);
    });

    it('archReviewDecision detail at ARCH_COMPLETE without error says topology invariant', () => {
      const state = makeProgressedState('ARCH_COMPLETE');
      const report = evaluateCompleteness(state);
      const slot = report.slots.find((s) => s.slot === 'archReviewDecision');
      expect(slot?.detail).toContain('Approved');
      expect(slot?.detail).toContain('topology invariant');
    });

    it('archReviewDecision detail at ARCH_COMPLETE with error is undefined', () => {
      const state = makeState('ARCH_COMPLETE', {
        ...makeProgressedState('ARCH_COMPLETE'),
        error: {
          code: 'ADR_REJECTED',
          message: 'rejected',
          recoveryHint: 'fix',
          occurredAt: FIXED_TIME,
        },
      });
      const report = evaluateCompleteness(state);
      const slot = report.slots.find((s) => s.slot === 'archReviewDecision');
      // With error, the slot should not be present (or detail should not be "Approved")
      expect(slot?.detail).toBeUndefined();
    });

    it('validation detail shows passed/total and failed check IDs', () => {
      const state = makeState('IMPLEMENTATION', {
        ...makeProgressedState('IMPLEMENTATION'),
        validation: [
          { checkId: 'sec_scan', passed: false, detail: 'vuln', executedAt: FIXED_TIME },
          { checkId: 'test_quality', passed: true, detail: 'ok', executedAt: FIXED_TIME },
        ],
      });
      const report = evaluateCompleteness(state);
      const valSlot = report.slots.find((s) => s.slot === 'validation');
      expect(valSlot?.detail).toContain('1/2 passed');
      expect(valSlot?.detail).toContain('failed: sec_scan');
    });

    it('validation detail shows all passed when no failures', () => {
      const state = makeProgressedState('COMPLETE');
      const report = evaluateCompleteness(state);
      const valSlot = report.slots.find((s) => s.slot === 'validation');
      expect(valSlot?.detail).toContain('passed');
      expect(valSlot?.detail).not.toContain('failed:');
    });

    it('arch flow slots at ARCHITECTURE phase: only architecture required', () => {
      const state = makeState('ARCHITECTURE', {
        architecture: null,
      });
      const report = evaluateCompleteness(state);
      const archSlot = report.slots.find((s) => s.slot === 'architecture');
      const selfReviewSlot = report.slots.find((s) => s.slot === 'selfReview');
      const archDecisionSlot = report.slots.find((s) => s.slot === 'archReviewDecision');
      expect(archSlot?.required).toBe(true);
      expect(archSlot?.status).toBe('missing');
      expect(selfReviewSlot?.required).toBe(false);
      expect(selfReviewSlot?.status).toBe('not_yet_required');
      expect(archDecisionSlot?.required).toBe(false);
    });

    it('evidenceReviewDecision slot at COMPLETE with error → not present', () => {
      const state = makeState('COMPLETE', {
        ...makeProgressedState('COMPLETE'),
        error: {
          code: 'REVIEW_FAILED',
          message: 'review rejected',
          recoveryHint: 'fix',
          occurredAt: FIXED_TIME,
        },
      });
      const report = evaluateCompleteness(state);
      const slot = report.slots.find((s) => s.slot === 'evidenceReviewDecision');
      expect(slot?.present).toBe(false);
      expect(slot?.detail).toContain('REVIEW_FAILED');
    });

    it('evidenceReviewDecision slot at COMPLETE without error → present', () => {
      const state = makeProgressedState('COMPLETE');
      const report = evaluateCompleteness(state);
      const slot = report.slots.find((s) => s.slot === 'evidenceReviewDecision');
      expect(slot?.present).toBe(true);
      expect(slot?.detail).toContain('topology invariant');
    });

    it('validation detail uses comma-space separator with 2+ failed checks', () => {
      // Kill: failedIds.join(', ') → failedIds.join("")
      const state = makeState('IMPLEMENTATION', {
        ...makeProgressedState('IMPLEMENTATION'),
        validation: [
          { checkId: 'chk_alpha', passed: false, detail: 'fail', executedAt: FIXED_TIME },
          { checkId: 'chk_beta', passed: false, detail: 'fail', executedAt: FIXED_TIME },
          { checkId: 'chk_gamma', passed: true, detail: 'ok', executedAt: FIXED_TIME },
        ],
      });
      const report = evaluateCompleteness(state);
      const valSlot = report.slots.find((s) => s.slot === 'validation');
      expect(valSlot?.detail).toContain('chk_alpha, chk_beta');
    });

    it('archReviewDecision detail is undefined at ARCHITECTURE phase', () => {
      // Kill: state.phase === 'ARCH_COMPLETE' → true
      // At ARCHITECTURE (not ARCH_COMPLETE), detail should NOT be the topology-invariant string
      const state = makeState('ARCHITECTURE', {
        architecture: null,
      });
      const report = evaluateCompleteness(state);
      const slot = report.slots.find((s) => s.slot === 'archReviewDecision');
      // At ARCHITECTURE, archReviewDecision is either not present or detail is undefined
      if (slot) {
        expect(slot.detail).toBeUndefined();
      }
    });
  });

  // ─── MUTATION KILL: isSlotPresent, isSlotFailed, getSlotDetail, arch flow ────
  describe('MUTATION_KILL isSlotPresent / isSlotFailed / getSlotDetail', () => {
    it('plan slot: state.plan === null means NOT present', () => {
      const state = makeState('PLAN', { plan: null });
      const report = evaluateCompleteness(state);
      const planSlot = report.slots.find((s) => s.slot === 'plan');
      expect(planSlot?.present).toBe(false);
      expect(planSlot?.status).toBe('missing');
    });

    it('selfReview slot: state.selfReview === null means NOT present', () => {
      const state = makeState('IMPLEMENTATION', {
        ...makeProgressedState('IMPLEMENTATION'),
        selfReview: null,
      });
      const report = evaluateCompleteness(state);
      const slot = report.slots.find((s) => s.slot === 'selfReview');
      expect(slot?.present).toBe(false);
    });

    it('planReviewDecision: false at PLAN phase (below VALIDATION)', () => {
      const state = makeState('PLAN');
      const report = evaluateCompleteness(state);
      const slot = report.slots.find((s) => s.slot === 'planReviewDecision');
      expect(slot?.present).toBe(false);
    });

    it('planReviewDecision: true at VALIDATION phase (>= VALIDATION)', () => {
      const state = makeProgressedState('VALIDATION');
      const report = evaluateCompleteness(state);
      const slot = report.slots.find((s) => s.slot === 'planReviewDecision');
      expect(slot?.present).toBe(true);
    });

    it('validation: empty validation array means NOT present even if activeChecks set', () => {
      const state = makeState('IMPLEMENTATION', {
        ...makeProgressedState('IMPLEMENTATION'),
        validation: [],
        activeChecks: ['test_quality', 'rollback_safety'],
      });
      const report = evaluateCompleteness(state);
      const slot = report.slots.find((s) => s.slot === 'validation');
      expect(slot?.present).toBe(false);
      expect(slot?.status).toBe('missing');
    });

    it('validation: empty activeChecks means NOT present even with validation results', () => {
      const state = makeState('IMPLEMENTATION', {
        ...makeProgressedState('IMPLEMENTATION'),
        validation: [
          { checkId: 'test_quality', passed: true, detail: 'ok', executedAt: FIXED_TIME },
        ],
        activeChecks: [],
      });
      const report = evaluateCompleteness(state);
      const slot = report.slots.find((s) => s.slot === 'validation');
      expect(slot?.present).toBe(false);
    });

    it('validation: matching checkId but passed=false → NOT present', () => {
      const state = makeState('IMPLEMENTATION', {
        ...makeProgressedState('IMPLEMENTATION'),
        validation: [
          { checkId: 'test_quality', passed: false, detail: 'fail', executedAt: FIXED_TIME },
          { checkId: 'rollback_safety', passed: true, detail: 'ok', executedAt: FIXED_TIME },
        ],
        activeChecks: ['test_quality', 'rollback_safety'],
      });
      const report = evaluateCompleteness(state);
      const slot = report.slots.find((s) => s.slot === 'validation');
      expect(slot?.present).toBe(false);
    });

    it('validation: non-matching checkId → NOT present', () => {
      const state = makeState('IMPLEMENTATION', {
        ...makeProgressedState('IMPLEMENTATION'),
        validation: [
          { checkId: 'other_check', passed: true, detail: 'ok', executedAt: FIXED_TIME },
        ],
        activeChecks: ['test_quality'],
      });
      const report = evaluateCompleteness(state);
      const slot = report.slots.find((s) => s.slot === 'validation');
      expect(slot?.present).toBe(false);
    });

    it('validation: all active checks passed → present', () => {
      const state = makeState('IMPLEMENTATION', {
        ...makeProgressedState('IMPLEMENTATION'),
        validation: [
          { checkId: 'test_quality', passed: true, detail: 'ok', executedAt: FIXED_TIME },
          { checkId: 'rollback_safety', passed: true, detail: 'ok', executedAt: FIXED_TIME },
        ],
        activeChecks: ['test_quality', 'rollback_safety'],
      });
      const report = evaluateCompleteness(state);
      const slot = report.slots.find((s) => s.slot === 'validation');
      expect(slot?.present).toBe(true);
      expect(slot?.status).toBe('complete');
    });

    it('implementation slot: null → NOT present', () => {
      const state = makeState('IMPLEMENTATION', {
        ...makeProgressedState('IMPLEMENTATION'),
        implementation: null,
      });
      const report = evaluateCompleteness(state);
      const slot = report.slots.find((s) => s.slot === 'implementation');
      expect(slot?.present).toBe(false);
    });

    it('implReview slot: null → NOT present', () => {
      const state = makeState('IMPLEMENTATION', {
        ...makeProgressedState('IMPLEMENTATION'),
        implReview: null,
      });
      const report = evaluateCompleteness(state);
      const slot = report.slots.find((s) => s.slot === 'implReview');
      expect(slot?.present).toBe(false);
    });

    it('evidenceReviewDecision: not COMPLETE phase → NOT present', () => {
      const state = makeProgressedState('IMPLEMENTATION');
      const report = evaluateCompleteness(state);
      const slot = report.slots.find((s) => s.slot === 'evidenceReviewDecision');
      expect(slot?.present).toBe(false);
    });

    it('isSlotFailed: validation with some failed → failed status', () => {
      const state = makeState('IMPLEMENTATION', {
        ...makeProgressedState('IMPLEMENTATION'),
        validation: [
          { checkId: 'test_quality', passed: false, detail: 'fail', executedAt: FIXED_TIME },
        ],
        activeChecks: ['test_quality', 'rollback_safety'],
      });
      const report = evaluateCompleteness(state);
      const slot = report.slots.find((s) => s.slot === 'validation');
      expect(slot?.status).toBe('failed');
    });

    it('isSlotFailed: validation empty → NOT failed', () => {
      const state = makeState('IMPLEMENTATION', {
        ...makeProgressedState('IMPLEMENTATION'),
        validation: [],
        activeChecks: ['test_quality'],
      });
      const report = evaluateCompleteness(state);
      const slot = report.slots.find((s) => s.slot === 'validation');
      expect(slot?.status).toBe('missing');
    });

    it('getSlotDetail plan: digest.slice(0, 12) truncates', () => {
      const longDigest = 'abcdef0123456789abcdef01234567890123456789';
      const state = makeState('IMPLEMENTATION', {
        ...makeProgressedState('IMPLEMENTATION'),
        plan: {
          current: { body: 'plan', digest: longDigest, sections: [], createdAt: FIXED_TIME },
          history: [],
        },
      });
      const report = evaluateCompleteness(state);
      const slot = report.slots.find((s) => s.slot === 'plan');
      expect(slot?.detail).toContain('abcdef012345...');
      expect(slot?.detail).not.toContain(longDigest);
    });

    it('getSlotDetail implementation: digest.slice(0, 12) truncates', () => {
      const longDigest = 'fedcba9876543210fedcba9876543210fedcba98';
      const state = makeState('IMPLEMENTATION', {
        ...makeProgressedState('IMPLEMENTATION'),
        implementation: {
          changedFiles: ['a.ts', 'b.ts'],
          digest: longDigest,
          createdAt: FIXED_TIME,
        },
      });
      const report = evaluateCompleteness(state);
      const slot = report.slots.find((s) => s.slot === 'implementation');
      expect(slot?.detail).toContain('fedcba987654...');
      expect(slot?.detail).not.toContain(longDigest);
    });

    it('arch flow: at ARCHITECTURE only architecture slot required', () => {
      const state = makeState('ARCHITECTURE', {
        architecture: null,
      });
      const report = evaluateCompleteness(state);
      const archSlot = report.slots.find((s) => s.slot === 'architecture');
      const selfReviewSlot = report.slots.find((s) => s.slot === 'selfReview');
      expect(archSlot?.required).toBe(true);
      expect(selfReviewSlot?.required).toBe(false);
    });

    it('ticket flow: failed validation gets "failed" status not "missing"', () => {
      const state = makeState('IMPLEMENTATION', {
        ...makeProgressedState('IMPLEMENTATION'),
        validation: [
          {
            checkId: 'test_quality',
            passed: false,
            detail: 'Missing tests',
            executedAt: FIXED_TIME,
          },
          { checkId: 'rollback_safety', passed: true, detail: 'OK', executedAt: FIXED_TIME },
        ],
        activeChecks: ['test_quality', 'rollback_safety'],
      });
      const report = evaluateCompleteness(state);
      const valSlot = report.slots.find((s) => s.slot === 'validation');
      expect(valSlot?.status).toBe('failed');
      expect(valSlot?.required).toBe(true);
    });

    it('summary.notYetRequired counts correctly', () => {
      const state = makeState('TICKET');
      const report = evaluateCompleteness(state);
      const nyrCount = report.slots.filter((s) => s.status === 'not_yet_required').length;
      expect(report.summary.notYetRequired).toBe(nyrCount);
      expect(nyrCount).toBeGreaterThan(0);
    });

    it('planReviewDecision detail at PLAN phase is undefined', () => {
      const state = makeState('PLAN');
      const report = evaluateCompleteness(state);
      const slot = report.slots.find((s) => s.slot === 'planReviewDecision');
      expect(slot?.detail).toBeUndefined();
    });

    it('planReviewDecision detail at IMPLEMENTATION phase is topology string', () => {
      const state = makeProgressedState('IMPLEMENTATION');
      const report = evaluateCompleteness(state);
      const slot = report.slots.find((s) => s.slot === 'planReviewDecision');
      expect(slot?.detail).toContain('topology invariant');
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
