import { describe, it, expect } from 'vitest';
import {
  validateReviewFindings,
  requireFindingsForApprove,
  type ReviewFindingsValidationContext,
} from './review-validation.js';
import type { ReviewFindings } from '../../state/evidence.js';

// ─── Test Fixtures ────────────────────────────────────────────────────────────

function makeFindings(overrides: Partial<ReviewFindings> = {}): ReviewFindings {
  return {
    iteration: 0,
    planVersion: 1,
    reviewMode: 'self',
    overallVerdict: 'approve',
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    reviewedBy: { sessionId: 'ses_test' },
    reviewedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeCtx(
  overrides: Partial<ReviewFindingsValidationContext> = {},
): ReviewFindingsValidationContext {
  return {
    subagentEnabled: false,
    fallbackToSelf: false,
    expectedPlanVersion: 1,
    expectedIteration: 0,
    ...overrides,
  };
}

function parseBlocked(result: string): { code: string; error: boolean } {
  return JSON.parse(result) as { code: string; error: boolean };
}

// ═════════════════════════════════════════════════════════════════════════════
// validateReviewFindings
// ═════════════════════════════════════════════════════════════════════════════

describe('validateReviewFindings', () => {
  // ── Happy Path ──────────────────────────────────────────────────────────

  describe('happy path', () => {
    it('returns null for valid self-review findings (subagent disabled)', () => {
      const result = validateReviewFindings(makeFindings(), makeCtx());
      expect(result).toBeNull();
    });

    it('returns null for valid subagent findings (subagent enabled)', () => {
      const result = validateReviewFindings(
        makeFindings({ reviewMode: 'subagent' }),
        makeCtx({ subagentEnabled: true }),
      );
      expect(result).toBeNull();
    });

    it('returns null for self-review with fallback allowed', () => {
      const result = validateReviewFindings(
        makeFindings({ reviewMode: 'self' }),
        makeCtx({ subagentEnabled: true, fallbackToSelf: true }),
      );
      expect(result).toBeNull();
    });

    it('returns null for iteration > 0 when expected', () => {
      const result = validateReviewFindings(
        makeFindings({ iteration: 3 }),
        makeCtx({ expectedIteration: 3 }),
      );
      expect(result).toBeNull();
    });

    it('returns null for planVersion > 1 when expected', () => {
      const result = validateReviewFindings(
        makeFindings({ planVersion: 5 }),
        makeCtx({ expectedPlanVersion: 5 }),
      );
      expect(result).toBeNull();
    });
  });

  // ── Rule 1: subagent mode gating ───────────────────────────────────────

  describe('Rule 1: subagent mode requires subagentEnabled', () => {
    it('blocks subagent mode when subagentEnabled=false', () => {
      const result = validateReviewFindings(
        makeFindings({ reviewMode: 'subagent' }),
        makeCtx({ subagentEnabled: false }),
      );
      expect(result).not.toBeNull();
      expect(parseBlocked(result!).code).toBe('REVIEW_MODE_SUBAGENT_DISABLED');
    });

    it('accepts subagent mode when subagentEnabled=true', () => {
      const result = validateReviewFindings(
        makeFindings({ reviewMode: 'subagent' }),
        makeCtx({ subagentEnabled: true }),
      );
      expect(result).toBeNull();
    });
  });

  // ── Rule 2: self mode fallback gating ──────────────────────────────────

  describe('Rule 2: self mode requires fallback when subagent enabled', () => {
    it('blocks self mode when subagentEnabled=true and fallbackToSelf=false', () => {
      const result = validateReviewFindings(
        makeFindings({ reviewMode: 'self' }),
        makeCtx({ subagentEnabled: true, fallbackToSelf: false }),
      );
      expect(result).not.toBeNull();
      expect(parseBlocked(result!).code).toBe('REVIEW_MODE_SELF_NOT_ALLOWED');
    });

    it('accepts self mode when subagentEnabled=true and fallbackToSelf=true', () => {
      const result = validateReviewFindings(
        makeFindings({ reviewMode: 'self' }),
        makeCtx({ subagentEnabled: true, fallbackToSelf: true }),
      );
      expect(result).toBeNull();
    });

    it('accepts self mode when subagentEnabled=false (fallback irrelevant)', () => {
      const result = validateReviewFindings(
        makeFindings({ reviewMode: 'self' }),
        makeCtx({ subagentEnabled: false, fallbackToSelf: false }),
      );
      expect(result).toBeNull();
    });
  });

  // ── Rule 3: planVersion binding ────────────────────────────────────────

  describe('Rule 3: planVersion binding', () => {
    it('blocks when planVersion too high', () => {
      const result = validateReviewFindings(
        makeFindings({ planVersion: 99 }),
        makeCtx({ expectedPlanVersion: 1 }),
      );
      expect(result).not.toBeNull();
      const parsed = parseBlocked(result!);
      expect(parsed.code).toBe('REVIEW_PLAN_VERSION_MISMATCH');
    });

    it('blocks when planVersion too low', () => {
      const result = validateReviewFindings(
        makeFindings({ planVersion: 1 }),
        makeCtx({ expectedPlanVersion: 3 }),
      );
      expect(result).not.toBeNull();
      expect(parseBlocked(result!).code).toBe('REVIEW_PLAN_VERSION_MISMATCH');
    });

    it('accepts exact planVersion match', () => {
      const result = validateReviewFindings(
        makeFindings({ planVersion: 3 }),
        makeCtx({ expectedPlanVersion: 3 }),
      );
      expect(result).toBeNull();
    });
  });

  // ── Rule 4: iteration binding ──────────────────────────────────────────

  describe('Rule 4: iteration binding', () => {
    it('blocks when iteration too high', () => {
      const result = validateReviewFindings(
        makeFindings({ iteration: 5 }),
        makeCtx({ expectedIteration: 0 }),
      );
      expect(result).not.toBeNull();
      expect(parseBlocked(result!).code).toBe('REVIEW_ITERATION_MISMATCH');
    });

    it('blocks when iteration too low', () => {
      const result = validateReviewFindings(
        makeFindings({ iteration: 0 }),
        makeCtx({ expectedIteration: 2 }),
      );
      expect(result).not.toBeNull();
      expect(parseBlocked(result!).code).toBe('REVIEW_ITERATION_MISMATCH');
    });

    it('accepts exact iteration match', () => {
      const result = validateReviewFindings(
        makeFindings({ iteration: 2 }),
        makeCtx({ expectedIteration: 2 }),
      );
      expect(result).toBeNull();
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('blocks on first failing rule (subagent before planVersion)', () => {
      // Both subagent-disabled AND planVersion wrong — should hit Rule 1 first
      const result = validateReviewFindings(
        makeFindings({ reviewMode: 'subagent', planVersion: 99 }),
        makeCtx({ subagentEnabled: false, expectedPlanVersion: 1 }),
      );
      expect(result).not.toBeNull();
      expect(parseBlocked(result!).code).toBe('REVIEW_MODE_SUBAGENT_DISABLED');
    });

    it('checks planVersion before iteration (rule order)', () => {
      // planVersion wrong AND iteration wrong — should hit Rule 3 (planVersion) first
      const result = validateReviewFindings(
        makeFindings({ planVersion: 99, iteration: 99 }),
        makeCtx({ expectedPlanVersion: 1, expectedIteration: 0 }),
      );
      expect(result).not.toBeNull();
      expect(parseBlocked(result!).code).toBe('REVIEW_PLAN_VERSION_MISMATCH');
    });

    it('returns structured JSON with error=true on any block', () => {
      const result = validateReviewFindings(
        makeFindings({ reviewMode: 'subagent' }),
        makeCtx({ subagentEnabled: false }),
      );
      const parsed = JSON.parse(result!);
      expect(parsed.error).toBe(true);
      expect(parsed.code).toBeTruthy();
      expect(parsed.message).toBeTruthy();
    });

    it('planVersion=0 never matches (positive integer required by schema)', () => {
      // Even if expectedPlanVersion=0 (shouldn't happen), validation checks equality
      const result = validateReviewFindings(
        makeFindings({ planVersion: 1 }),
        makeCtx({ expectedPlanVersion: 0 }),
      );
      expect(result).not.toBeNull();
      expect(parseBlocked(result!).code).toBe('REVIEW_PLAN_VERSION_MISMATCH');
    });
  });

  // ── Corner: all policy combinations ────────────────────────────────────

  describe('policy matrix (all 4 combinations)', () => {
    const combinations = [
      { subagentEnabled: false, fallbackToSelf: false },
      { subagentEnabled: false, fallbackToSelf: true },
      { subagentEnabled: true, fallbackToSelf: false },
      { subagentEnabled: true, fallbackToSelf: true },
    ] as const;

    for (const combo of combinations) {
      it(`self mode + subagent=${combo.subagentEnabled} fallback=${combo.fallbackToSelf}`, () => {
        const result = validateReviewFindings(makeFindings({ reviewMode: 'self' }), makeCtx(combo));
        const shouldBlock = combo.subagentEnabled && !combo.fallbackToSelf;
        if (shouldBlock) {
          expect(result).not.toBeNull();
          expect(parseBlocked(result!).code).toBe('REVIEW_MODE_SELF_NOT_ALLOWED');
        } else {
          expect(result).toBeNull();
        }
      });

      it(`subagent mode + subagent=${combo.subagentEnabled} fallback=${combo.fallbackToSelf}`, () => {
        const result = validateReviewFindings(
          makeFindings({ reviewMode: 'subagent' }),
          makeCtx(combo),
        );
        const shouldBlock = !combo.subagentEnabled;
        if (shouldBlock) {
          expect(result).not.toBeNull();
          expect(parseBlocked(result!).code).toBe('REVIEW_MODE_SUBAGENT_DISABLED');
        } else {
          expect(result).toBeNull();
        }
      });
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// requireFindingsForApprove
// ═════════════════════════════════════════════════════════════════════════════

describe('requireFindingsForApprove', () => {
  it('returns null when subagentEnabled=false (findings not required)', () => {
    expect(requireFindingsForApprove(false, false)).toBeNull();
  });

  it('returns null when subagentEnabled=false even with findings', () => {
    expect(requireFindingsForApprove(false, true)).toBeNull();
  });

  it('returns null when subagentEnabled=true and findings present', () => {
    expect(requireFindingsForApprove(true, true)).toBeNull();
  });

  it('blocks when subagentEnabled=true and findings missing', () => {
    const result = requireFindingsForApprove(true, false);
    expect(result).not.toBeNull();
    expect(parseBlocked(result!).code).toBe('REVIEW_FINDINGS_REQUIRED_FOR_APPROVE');
  });

  it('returns structured JSON with error=true', () => {
    const result = requireFindingsForApprove(true, false);
    const parsed = JSON.parse(result!);
    expect(parsed.error).toBe(true);
    expect(parsed.recovery).toBeTruthy();
  });
});
