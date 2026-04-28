/**
 * @module review.test
 * @description Tests for the /review rail — standalone compliance report generator.
 *
 * /review is always available, read-only, does NOT mutate state.
 * Produces an ExtendedReviewReport with completeness matrix and findings.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE, PERF — all five categories present.
 */

import { describe, it, expect } from 'vitest';
import { executeReview, type ReviewExecutors, type ReviewReferenceInput } from './review.js';
import {
  makeState,
  makeProgressedState,
  FIXED_TIME,
  FIXED_UUID,
  VALIDATION_FAILED,
} from '../__fixtures__.js';
import { benchmarkSync, PERF_BUDGETS, measureAsync } from '../test-policy.js';

// ─── Test Helpers ─────────────────────────────────────────────────────────────

const NOW = '2026-01-15T10:00:00.000Z';

const noopExecutors: ReviewExecutors = {};

// =============================================================================
// /review rail
// =============================================================================

describe('review rail', () => {
  // ─── HAPPY ──────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('produces a clean report at COMPLETE with all evidence', async () => {
      const state = makeProgressedState('COMPLETE');
      const report = await executeReview(state, NOW, noopExecutors);

      expect(report.schemaVersion).toBe('flowguard-review-report.v1');
      expect(report.sessionId).toBe(FIXED_UUID);
      expect(report.generatedAt).toBe(NOW);
      expect(report.phase).toBe('COMPLETE');
      expect(report.planDigest).toBe(state.plan!.current.digest);
      expect(report.implDigest).toBe(state.implementation!.digest);
      expect(report.overallStatus).toBe('clean');
      expect(report.findings.filter((f) => f.severity === 'error')).toHaveLength(0);
    });

    it('includes validation summary from state', async () => {
      const state = makeProgressedState('COMPLETE');
      const report = await executeReview(state, NOW);
      expect(report.validationSummary).toHaveLength(2);
      expect(report.validationSummary[0]!.checkId).toBe('test_quality');
      expect(report.validationSummary[0]!.passed).toBe(true);
    });

    it('includes evidence completeness matrix', async () => {
      const state = makeProgressedState('COMPLETE');
      const report = await executeReview(state, NOW);
      expect(report.completeness).toBeDefined();
      expect(report.completeness.overallComplete).toBe(true);
      expect(report.completeness.slots).toHaveLength(8);
    });

    it('is available at any phase (always allowed)', async () => {
      // Test at TICKET, PLAN_REVIEW, IMPLEMENTATION — should all work
      for (const phase of ['TICKET', 'PLAN_REVIEW', 'IMPLEMENTATION'] as const) {
        const state = makeProgressedState(phase);
        const report = await executeReview(state, NOW);
        expect(report.phase).toBe(phase);
      }
    });
  });

  // ─── BAD ────────────────────────────────────────────────────
  describe('BAD', () => {
    it('flags missing ticket as warning', async () => {
      const state = makeState('TICKET', { ticket: null });
      const report = await executeReview(state, NOW);
      const ticketFinding = report.findings.find(
        (f) => f.category === 'completeness' && f.message.includes('ticket'),
      );
      expect(ticketFinding).toBeDefined();
      expect(ticketFinding!.severity).toBe('warning');
    });

    it('flags missing plan as warning', async () => {
      const state = makeState('PLAN', { plan: null });
      const report = await executeReview(state, NOW);
      const planFinding = report.findings.find(
        (f) => f.category === 'completeness' && f.message.includes('plan'),
      );
      expect(planFinding).toBeDefined();
      expect(planFinding!.severity).toBe('warning');
    });

    it('flags active error as error-severity finding', async () => {
      const state = makeState('PLAN', {
        error: {
          code: 'TOOL_ERROR',
          message: 'Something broke',
          recoveryHint: 'retry',
          occurredAt: FIXED_TIME,
        },
      });
      const report = await executeReview(state, NOW);
      const errorFinding = report.findings.find((f) => f.category === 'error');
      expect(errorFinding).toBeDefined();
      expect(errorFinding!.severity).toBe('error');
      expect(errorFinding!.message).toContain('TOOL_ERROR');
      expect(report.overallStatus).toBe('issues');
    });

    it('flags failed validation checks as error', async () => {
      const state = makeState('IMPLEMENTATION', {
        ...makeProgressedState('IMPLEMENTATION'),
        validation: VALIDATION_FAILED,
      });
      const report = await executeReview(state, NOW);
      const valFinding = report.findings.find((f) => f.category === 'validation');
      expect(valFinding).toBeDefined();
      expect(valFinding!.severity).toBe('error');
      expect(valFinding!.message).toContain('test_quality');
      expect(report.overallStatus).toBe('issues');
    });
  });

  // ─── CORNER ─────────────────────────────────────────────────
  describe('CORNER', () => {
    it('report at TICKET with no evidence → warnings status', async () => {
      const state = makeState('TICKET');
      const report = await executeReview(state, NOW);
      // ticket: null → warning finding
      expect(report.overallStatus).toBe('warnings');
      expect(report.planDigest).toBeNull();
      expect(report.implDigest).toBeNull();
      expect(report.validationSummary).toHaveLength(0);
    });

    it('four-eyes violation produces error finding', async () => {
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
          decidedBy: 'alice',
        },
      });
      const report = await executeReview(state, NOW);
      const fourEyesFinding = report.findings.find((f) => f.category === 'four-eyes');
      expect(fourEyesFinding).toBeDefined();
      expect(fourEyesFinding!.severity).toBe('error');
      expect(fourEyesFinding!.message).toContain('VIOLATED');
      expect(report.overallStatus).toBe('issues');
    });

    it('four-eyes pending (no decision) produces warning', async () => {
      const state = makeState('PLAN_REVIEW', {
        ...makeProgressedState('PLAN_REVIEW'),
        policySnapshot: {
          ...makeProgressedState('PLAN_REVIEW').policySnapshot!,
          allowSelfApproval: false,
        },
        reviewDecision: null,
      });
      const report = await executeReview(state, NOW);
      const fourEyesFinding = report.findings.find((f) => f.category === 'four-eyes');
      expect(fourEyesFinding).toBeDefined();
      expect(fourEyesFinding!.severity).toBe('warning');
    });

    it('completeness missing slot adds finding', async () => {
      // At PLAN with ticket but no plan → plan slot is missing
      const state = makeState('PLAN', {
        ticket: makeProgressedState('PLAN').ticket,
        plan: null,
      });
      const report = await executeReview(state, NOW);
      const completenessFindings = report.findings.filter(
        (f) => f.category === 'completeness' && f.message.includes('missing'),
      );
      // Should find "Plan Evidence is missing" from completeness slots
      expect(completenessFindings.length).toBeGreaterThan(0);
    });

    it('no executors parameter → works (all params optional)', async () => {
      const state = makeProgressedState('COMPLETE');
      const report = await executeReview(state, NOW);
      expect(report.overallStatus).toBe('clean');
    });

    it('report includes references when provided via refInput', async () => {
      const state = makeProgressedState('COMPLETE');
      const refInput: ReviewReferenceInput = {
        inputOrigin: 'pr',
        references: [
          { ref: 'https://github.com/org/repo/pull/42', type: 'pr', title: 'PR #42: Add auth', source: 'github', extractedAt: '2026-01-15T10:00:00.000Z' },
          { ref: 'https://jira.example.com/PROJ-123', type: 'ticket', title: 'PROJ-123', source: 'jira' },
        ],
      };
      const report = await executeReview(state, NOW, undefined, refInput);
      expect(report.inputOrigin).toBe('pr');
      expect(report.references).toHaveLength(2);
      expect(report.references![0]!.type).toBe('pr');
      expect(report.references![1]!.type).toBe('ticket');
    });

    it('report normalizes away empty references array', async () => {
      const state = makeProgressedState('COMPLETE');
      const refInput: ReviewReferenceInput = { references: [] };
      const report = await executeReview(state, NOW, undefined, refInput);
      expect(report.references).toBeUndefined();
    });
  });

  // ─── EDGE ───────────────────────────────────────────────────
  describe('EDGE', () => {
    it('LLM executor findings are appended to mechanical findings', async () => {
      const state = makeState('TICKET'); // Will have mechanical findings (no ticket)
      const llmExecutors: ReviewExecutors = {
        analyze: async () => [
          { severity: 'info', category: 'style', message: 'Code looks clean' },
          { severity: 'warning', category: 'security', message: 'Missing CSRF protection' },
        ],
      };
      const report = await executeReview(state, NOW, llmExecutors);
      const styleFinding = report.findings.find((f) => f.category === 'style');
      const securityFinding = report.findings.find((f) => f.category === 'security');
      expect(styleFinding).toBeDefined();
      expect(styleFinding!.message).toBe('Code looks clean');
      expect(securityFinding).toBeDefined();
      // Both mechanical and LLM findings present
      expect(report.findings.length).toBeGreaterThan(2);
    });

    it("overallStatus is 'issues' if any error finding, regardless of warnings", async () => {
      const state = makeState('IMPLEMENTATION', {
        ...makeProgressedState('IMPLEMENTATION'),
        validation: VALIDATION_FAILED,
        error: { code: 'CRITICAL', message: 'fail', recoveryHint: 'fix', occurredAt: FIXED_TIME },
      });
      const report = await executeReview(state, NOW);
      expect(report.overallStatus).toBe('issues');
    });

    it("overallStatus is 'warnings' with only warning-level findings", async () => {
      const state = makeState('TICKET'); // No ticket → warning
      const report = await executeReview(state, NOW);
      expect(report.overallStatus).toBe('warnings');
    });

    it('validation summary includes failed check details', async () => {
      const state = makeState('IMPLEMENTATION', {
        ...makeProgressedState('IMPLEMENTATION'),
        validation: VALIDATION_FAILED,
      });
      const report = await executeReview(state, NOW);
      const failedCheck = report.validationSummary.find((v) => !v.passed);
      expect(failedCheck).toBeDefined();
      expect(failedCheck!.checkId).toBe('test_quality');
      expect(failedCheck!.detail).toBe('Missing tests');
    });

    it('report does NOT mutate the input state', async () => {
      const state = makeProgressedState('COMPLETE');
      const original = JSON.stringify(state);
      await executeReview(state, NOW);
      expect(JSON.stringify(state)).toBe(original);
    });

    it('report without refInput has no inputOrigin or references', async () => {
      const state = makeProgressedState('COMPLETE');
      const report = await executeReview(state, NOW);
      expect(report.inputOrigin).toBeUndefined();
      expect(report.references).toBeUndefined();
    });

    it('report with branch reference stores type=branch', async () => {
      const state = makeProgressedState('COMPLETE');
      const refInput: ReviewReferenceInput = {
        inputOrigin: 'branch',
        references: [{ ref: 'feature/login-fix', type: 'branch', source: 'local' }],
      };
      const report = await executeReview(state, NOW, undefined, refInput);
      expect(report.inputOrigin).toBe('branch');
      expect(report.references![0]!.type).toBe('branch');
    });

    it('report with commit reference stores type=commit', async () => {
      const state = makeProgressedState('COMPLETE');
      const refInput: ReviewReferenceInput = {
        references: [{ ref: 'abc123def456', type: 'commit', source: 'local' }],
      };
      const report = await executeReview(state, NOW, undefined, refInput);
      expect(report.references![0]!.type).toBe('commit');
      expect(report.inputOrigin).toBeUndefined();
    });

    it('report with mixed inputOrigin and manual+external refs', async () => {
      const state = makeProgressedState('COMPLETE');
      const refInput: ReviewReferenceInput = {
        inputOrigin: 'mixed',
        references: [
          { ref: 'https://github.com/org/repo/pull/1', type: 'pr', source: 'github', title: 'PR #1' },
          { ref: 'https://jira.example.com/PROJ-2', type: 'ticket', source: 'jira', title: 'PROJ-2' },
        ],
      };
      const report = await executeReview(state, NOW, undefined, refInput);
      expect(report.inputOrigin).toBe('mixed');
      expect(report.references).toHaveLength(2);
    });
  });

  // ─── PERF ───────────────────────────────────────────────────
  describe('PERF', () => {
    it('executeReview < 5ms without LLM executor (p99 over 50 iterations)', async () => {
      const state = makeProgressedState('COMPLETE');
      // Measure async, but since there's no LLM call, it's effectively sync
      const times: number[] = [];
      // Warmup
      for (let i = 0; i < 10; i++) {
        await executeReview(state, NOW);
      }
      // Measure
      for (let i = 0; i < 50; i++) {
        const { elapsedMs } = await measureAsync(() => executeReview(state, NOW));
        times.push(elapsedMs);
      }
      times.sort((a, b) => a - b);
      const p99 = times[Math.floor(times.length * 0.99)] ?? times[times.length - 1] ?? 0;
      expect(p99).toBeLessThan(5);
    });
  });
});
