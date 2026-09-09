import { describe, it, expect } from 'vitest';
import { evaluateCompleteness } from './completeness.js';
import { makeState, makeProgressedState, FIXED_TIME, FIXED_SESSION_UUID } from '../fixtures.js';
import { benchmarkSync, PERF_BUDGETS } from '../test-policy.js';
import type { ValidationResult } from '../state/evidence.js';
import type { SessionState } from '../state/schema.js';
import { computeRecordDigest } from '../state/evidence-plan.js';

function validationResult(checkId: string, passed: boolean, detail: string): ValidationResult {
  return {
    checkId,
    passed,
    detail,
    executedAt: FIXED_TIME,
    kind: 'test',
    command: 'npm test',
    exitCode: passed ? 0 : 1,
    executionMs: 1,
    outputDigest: 'a'.repeat(64),
    timedOut: false,
    outcome: (passed ? 'supported' : 'inconclusive') as 'supported' | 'inconclusive',
  };
}

function zeroCheckCompleteState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    ...makeProgressedState('COMPLETE'),
    activeChecks: [],
    validation: [],
    implValidation: [],
    ...overrides,
  };
}

describe('audit completeness', () => {
  describe('HAPPY', () => {
    it('evaluateCompleteness at TICKET phase — only ticket required', () => {
      const state = makeState('TICKET', { ticket: null });
      const report = evaluateCompleteness(state);
      expect(report.sessionId).toBe(state.id);
      expect(report.phase).toBe('TICKET');
      expect(report.policyMode).toBe('team');
      const ticketSlot = report.slots.find((s) => s.slot === 'ticket');
      expect(ticketSlot?.required).toBe(true);
      expect(ticketSlot?.status).toBe('missing');
      const planSlot = report.slots.find((s) => s.slot === 'plan');
      expect(planSlot?.required).toBe(false);
      expect(planSlot?.status).toBe('not_yet_required');
    });

    it('evaluateCompleteness at COMPLETE phase — all complete', () => {
      const state = makeProgressedState('COMPLETE');
      const report = evaluateCompleteness(state);
      expect(report.phase).toBe('COMPLETE');
      expect(report.overallComplete).toBe(true);
      expect(report.summary.complete).toBe(9);
      expect(report.summary.missing).toBe(0);
      expect(report.summary.failed).toBe(0);
    });

    it('evaluateCompleteness at VALIDATION phase — 4 required, 4 not yet', () => {
      const state = makeProgressedState('VALIDATION');
      const report = evaluateCompleteness(state);
      expect(report.phase).toBe('VALIDATION');
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

  describe('BAD', () => {
    it('missing evidence at required phase → missing status', () => {
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
          validationResult('test_quality', false, 'Missing tests'),
          validationResult('rollback_safety', true, 'ok'),
        ],
      });
      const report = evaluateCompleteness(state);
      const valSlot = report.slots.find((s) => s.slot === 'validation');
      expect(valSlot?.status).toBe('failed');
      expect(valSlot?.detail).toContain('failed: test_quality');
      expect(report.overallComplete).toBe(false);
    });

    it('failed post-implementation evidence is isolated from complete validation evidence', () => {
      const state = makeState('IMPL_REVIEW', {
        ...makeProgressedState('IMPL_REVIEW'),
        activeChecks: ['unit', 'lint'],
        validation: [validationResult('unit', true, 'ok'), validationResult('lint', true, 'ok')],
        implValidation: [
          validationResult('unit', false, 'failed'),
          validationResult('lint', true, 'ok'),
        ],
      });
      const report = evaluateCompleteness(state);
      const validationSlot = report.slots.find((slot) => slot.slot === 'validation');
      const implValidationSlot = report.slots.find((slot) => slot.slot === 'implValidation');
      expect(validationSlot).toMatchObject({ status: 'complete', detail: '2/2 passed' });
      expect(implValidationSlot).toMatchObject({
        status: 'failed',
        detail: 'post-impl 1/2 passed, failed: unit',
      });
      expect(report.overallComplete).toBe(false);
    });
  });

  describe('CORNER', () => {
    it('four-eyes violated — same person initiated and reviewed', () => {
      const state = makeState('COMPLETE', {
        ...makeProgressedState('COMPLETE'),
        policySnapshot: {
          ...makeProgressedState('COMPLETE').policySnapshot!,
          allowSelfApproval: false,
        },
        initiatedBy: 'alice',
        initiatedByIdentity: {
          actorId: 'alice',
          actorEmail: null,
          actorSource: 'claim',
          actorAssurance: 'claim_validated',
        },
        reviewDecision: {
          verdict: 'approve',
          rationale: 'LGTM',
          decidedAt: FIXED_TIME,
          decidedBy: 'alice',
          decisionIdentity: {
            actorId: 'alice',
            actorEmail: null,
            actorSource: 'claim',
            actorAssurance: 'claim_validated',
          },
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

    it('four-eyes violated when structured identities match despite different legacy strings', () => {
      const state = makeState('COMPLETE', {
        ...makeProgressedState('COMPLETE'),
        policySnapshot: {
          ...makeProgressedState('COMPLETE').policySnapshot!,
          allowSelfApproval: false,
        },
        initiatedBy: 'legacy-initiator',
        initiatedByIdentity: {
          actorId: 'alice',
          actorEmail: null,
          actorSource: 'claim',
          actorAssurance: 'claim_validated',
        },
        reviewDecision: {
          verdict: 'approve',
          rationale: 'LGTM',
          decidedAt: FIXED_TIME,
          decidedBy: 'legacy-reviewer',
          decisionIdentity: {
            actorId: 'ALICE',
            actorEmail: null,
            actorSource: 'claim',
            actorAssurance: 'claim_validated',
          },
        },
      });
      const report = evaluateCompleteness(state);
      expect(report.fourEyes.required).toBe(true);
      expect(report.fourEyes.satisfied).toBe(false);
      expect(report.fourEyes.detail).toContain('VIOLATED');
    });

    it('four-eyes is not satisfied when structured identities are uncomparable', () => {
      const state = makeState('COMPLETE', {
        ...makeProgressedState('COMPLETE'),
        policySnapshot: {
          ...makeProgressedState('COMPLETE').policySnapshot!,
          allowSelfApproval: false,
        },
        initiatedByIdentity: {
          actorId: '   ',
          actorEmail: null,
          actorSource: 'claim',
          actorAssurance: 'claim_validated',
        },
        reviewDecision: {
          verdict: 'approve',
          rationale: 'LGTM',
          decidedAt: FIXED_TIME,
          decidedBy: 'bob',
          decisionIdentity: {
            actorId: 'bob',
            actorEmail: null,
            actorSource: 'claim',
            actorAssurance: 'claim_validated',
          },
        },
      });
      const report = evaluateCompleteness(state);
      expect(report.fourEyes.required).toBe(true);
      expect(report.fourEyes.satisfied).toBe(false);
      expect(report.fourEyes.detail).toContain('not comparable');
    });

    it('four-eyes uses legacy actor strings when structured identities are absent', () => {
      const state = makeState('COMPLETE', {
        ...makeProgressedState('COMPLETE'),
        policySnapshot: {
          ...makeProgressedState('COMPLETE').policySnapshot!,
          allowSelfApproval: false,
        },
        initiatedBy: 'alice',
        initiatedByIdentity: undefined,
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
      expect(report.fourEyes.satisfied).toBe(false);
      expect(report.fourEyes.detail).toContain('pending');
    });

    it('planReviewDecision slot uses topology invariant (phase >= VALIDATION)', () => {
      const state = makeProgressedState('PLAN_REVIEW');
      const report = evaluateCompleteness(state);
      const slot = report.slots.find((s) => s.slot === 'planReviewDecision');
      expect(slot?.required).toBe(false);
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

  describe('EDGE', () => {
    it('slot detail generation for each evidence type', () => {
      const state = makeProgressedState('COMPLETE');
      const report = evaluateCompleteness(state);
      const ticketSlot = report.slots.find((s) => s.slot === 'ticket');
      expect(ticketSlot?.detail).toContain('source:');
      expect(ticketSlot?.detail).toContain('digest:');
      const planSlot = report.slots.find((s) => s.slot === 'plan');
      expect(planSlot?.detail).toContain('v1');
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
      expect(report.summary.total).toBe(9);
    });

    it('architecture flow evaluates arch-specific slots', () => {
      const state = makeState('ARCHITECTURE', { architecture: null });
      const report = evaluateCompleteness(state);
      expect(report.phase).toBe('ARCHITECTURE');
      expect(report.summary.total).toBe(report.slots.length);
      const archSlot = report.slots.find((s) => s.slot === 'architecture');
      expect(archSlot?.required).toBe(true);
      expect(archSlot?.status).toBe('missing');
    });

    it('review flow is incomplete until REVIEW_COMPLETE', () => {
      const inProgress = evaluateCompleteness(makeState('REVIEW'));
      expect(inProgress.slots).toHaveLength(0);
      expect(inProgress.overallComplete).toBe(false);
      expect(inProgress.summary.total).toBe(0);

      const completed = evaluateCompleteness(makeState('REVIEW_COMPLETE'));
      expect(completed.slots).toHaveLength(0);
      expect(completed.overallComplete).toBe(true);
      expect(completed.summary.total).toBe(0);
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
      const phases: Array<{
        phase: import('../state/schema.js').Phase;
        expectedRequired: number;
        expectedTotal: number;
      }> = [
        { phase: 'READY', expectedRequired: 0, expectedTotal: 9 },
        { phase: 'TICKET', expectedRequired: 1, expectedTotal: 9 },
        { phase: 'PLAN', expectedRequired: 2, expectedTotal: 9 },
        { phase: 'PLAN_REVIEW', expectedRequired: 3, expectedTotal: 9 },
        { phase: 'VALIDATION', expectedRequired: 4, expectedTotal: 9 },
        { phase: 'IMPLEMENTATION', expectedRequired: 5, expectedTotal: 9 },
        { phase: 'IMPL_VALIDATION', expectedRequired: 6, expectedTotal: 9 },
        { phase: 'IMPL_REVIEW', expectedRequired: 7, expectedTotal: 9 },
        { phase: 'EVIDENCE_REVIEW', expectedRequired: 8, expectedTotal: 9 },
        { phase: 'COMPLETE', expectedRequired: 9, expectedTotal: 9 },
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
          validationResult('test_quality', false, 'Missing tests'),
          validationResult('rollback_safety', true, 'ok'),
        ],
      });
      const report = evaluateCompleteness(state);
      const valSlot = report.slots.find((s) => s.slot === 'validation');
      expect(valSlot?.detail).toContain('failed: test_quality');
    });

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
          verdict: 'changes_requested',
        },
      });
      const report = evaluateCompleteness(state);
      const slot = report.slots.find((s) => s.slot === 'archReviewDecision');
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
      expect(slot?.detail).toBeUndefined();
    });

    it('validation detail shows passed/total and failed check IDs', () => {
      const state = makeState('IMPLEMENTATION', {
        ...makeProgressedState('IMPLEMENTATION'),
        validation: [validationResult('sec_scan', false, 'vuln'), validationResult('test_quality', true, 'ok')],
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
      const state = makeState('ARCHITECTURE', { architecture: null });
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
      const state = makeState('IMPLEMENTATION', {
        ...makeProgressedState('IMPLEMENTATION'),
        validation: [
          validationResult('chk_alpha', false, 'fail'),
          validationResult('chk_beta', false, 'fail'),
          validationResult('chk_gamma', true, 'ok'),
        ],
      });
      const report = evaluateCompleteness(state);
      const valSlot = report.slots.find((s) => s.slot === 'validation');
      expect(valSlot?.detail).toContain('chk_alpha, chk_beta');
    });

    it('archReviewDecision detail is undefined at ARCHITECTURE phase', () => {
      const state = makeState('ARCHITECTURE', { architecture: null });
      const report = evaluateCompleteness(state);
      const slot = report.slots.find((s) => s.slot === 'archReviewDecision');
      if (slot) expect(slot.detail).toBeUndefined();
    });
  });

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

    it('validation: blocked zero-check policy remains NOT present even with validation results', () => {
      const progressed = makeProgressedState('IMPLEMENTATION');
      const state = makeState('IMPLEMENTATION', {
        ...progressed,
        validation: [validationResult('test_quality', true, 'ok')],
        activeChecks: [],
        policySnapshot: {
          ...progressed.policySnapshot,
          validationEvidence: {
            ...progressed.policySnapshot.validationEvidence,
            enforcement: 'required',
            allowNoCommands: false,
          },
        },
      });
      const report = evaluateCompleteness(state);
      const slot = report.slots.find((s) => s.slot === 'validation');
      expect(slot?.present).toBe(false);
    });

    it('validation: matching checkId but passed=false → NOT present', () => {
      const state = makeState('IMPLEMENTATION', {
        ...makeProgressedState('IMPLEMENTATION'),
        validation: [
          validationResult('test_quality', false, 'fail'),
          validationResult('rollback_safety', true, 'ok'),
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
        validation: [validationResult('other_check', true, 'ok')],
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
          validationResult('test_quality', true, 'ok'),
          validationResult('rollback_safety', true, 'ok'),
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
        validation: [validationResult('test_quality', false, 'fail')],
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
          current: {
            body: 'plan',
            digest: longDigest,
            sections: [],
            createdAt: FIXED_TIME,
            recordDigest: computeRecordDigest({
              contentDigest: longDigest,
              planVersion: 1,
              supersedesRecordDigest: null,
              originatingReviewObligationId: null,
              revisionReason: null,
            }),
            planVersion: 1,
            supersedesRecordDigest: null,
            originatingReviewObligationId: null,
            revisionReason: null,
            lineageStatus: 'verified' as const,
          },
          history: [],
          reviewCompletion: 'pending',
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
          domainFiles: ['a.ts', 'b.ts'],
          digest: longDigest,
          executedAt: FIXED_TIME,
        },
      });
      const report = evaluateCompleteness(state);
      const slot = report.slots.find((s) => s.slot === 'implementation');
      expect(slot?.detail).toContain('fedcba987654...');
      expect(slot?.detail).not.toContain(longDigest);
    });

    it('arch flow: at ARCHITECTURE only architecture slot required', () => {
      const state = makeState('ARCHITECTURE', { architecture: null });
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
          validationResult('test_quality', false, 'Missing tests'),
          validationResult('rollback_safety', true, 'OK'),
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

  describe('Zero-check completeness (allowNoCommands)', () => {
    it('vacuous pass: explicit allowNoCommands completes both validation slots', () => {
      const state = zeroCheckCompleteState();
      const report = evaluateCompleteness({
        ...state,
        policySnapshot: {
          ...state.policySnapshot,
          validationEvidence: {
            ...state.policySnapshot.validationEvidence,
            enforcement: 'required',
            allowNoCommands: true,
          },
        },
      });
      expect(report.overallComplete).toBe(true);
      expect(report.slots.find((s) => s.slot === 'validation')?.status).toBe('complete');
      expect(report.slots.find((s) => s.slot === 'implValidation')?.status).toBe('complete');
    });

    it('vacuous pass: lenient policy with no detected stack completes both validation slots', () => {
      const report = evaluateCompleteness(zeroCheckCompleteState());
      expect(report.overallComplete).toBe(true);
      expect(report.slots.find((s) => s.slot === 'validation')?.status).toBe('complete');
      expect(report.slots.find((s) => s.slot === 'implValidation')?.status).toBe('complete');
    });

    it('missing: validation incomplete when activeChecks exist but no results', () => {
      const state = makeProgressedState('IMPLEMENTATION');
      const report = evaluateCompleteness({ ...state, activeChecks: ['test'], validation: [] });
      expect(report.slots.find((s) => s.slot === 'validation')?.status).toBe('missing');
    });

    it('missing: implValidation incomplete when activeChecks exist but no results', () => {
      const state = makeProgressedState('IMPL_REVIEW');
      const report = evaluateCompleteness({
        ...state,
        activeChecks: ['test'],
        validation: [validationResult('test', true, 'passed')],
        implValidation: [],
      });
      expect(report.slots.find((s) => s.slot === 'implValidation')?.status).toBe('missing');
    });

    it('missing: detected stack with no commands and no opt-out blocks both validation slots', () => {
      const state = zeroCheckCompleteState({
        discoverySummary: {
          primaryLanguages: ['typescript'],
          frameworks: [],
          topologyKind: 'single-project',
          moduleCount: 1,
          hasApiSurface: false,
          hasPersistenceSurface: false,
          hasCiCd: false,
          hasSecuritySurface: false,
        },
      });
      const report = evaluateCompleteness(state);
      expect(report.overallComplete).toBe(false);
      expect(report.slots.find((s) => s.slot === 'validation')?.status).toBe('missing');
      expect(report.slots.find((s) => s.slot === 'implValidation')?.status).toBe('missing');
    });
  });

  describe('PERF', () => {
    it('evaluateCompleteness < 2ms (p99 over 200 iterations)', () => {
      const state = makeProgressedState('COMPLETE');
      const { p99Ms } = benchmarkSync(() => evaluateCompleteness(state), 200, 50);
      expect(p99Ms).toBeLessThan(PERF_BUDGETS.completenessEvalMs);
    });
  });
});
