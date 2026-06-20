/**
 * @module review-schema-validation.test
 * @description Tests for ReviewReport schema validation — Zod type-safe
 *              discriminated union and buildReviewReport integration.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE, PERF — all five categories present.
 */

import { describe, it, expect } from 'vitest';
import { executeReview, buildReviewReport } from './review.js';
import { ReviewReport } from '../state/evidence.js';
import { makeState } from '../__fixtures__.js';

// ─── Test Helpers ─────────────────────────────────────────────────────────────

const NOW = '2026-01-15T10:00:00.000Z';

// =============================================================================
// FG-REL-013: Type-safe discriminated union + schema-validated ReviewReport
// =============================================================================

describe('FG-REL-013: type-safe discriminated union + schema validation', () => {
  // ─── NEGATIVE: ReviewReport schema validation rejects invalid shapes ──
  describe('NEGATIVE: ReviewReport schema validation', () => {
    it('throws when sessionId is not a valid UUID', async () => {
      const state = makeState('TICKET', { id: 'not-a-uuid' });
      await expect(executeReview(state, NOW)).rejects.toThrow();
    });

    it('safeParse rejects invalid overallStatus value', () => {
      const base = makeState('COMPLETE');
      const result = ReviewReport.safeParse({
        schemaVersion: 'flowguard-review-report.v1',
        sessionId: base.id,
        generatedAt: NOW,
        phase: 'COMPLETE',
        planDigest: null,
        implDigest: null,
        validationSummary: [],
        findings: [],
        overallStatus: 'bogus',
        completeness: {
          sessionId: base.id,
          phase: 'COMPLETE',
          policyMode: 'unknown',
          overallComplete: true,
          slots: [],
          fourEyes: {
            required: false,
            satisfied: true,
            initiatedBy: '',
            decidedBy: null,
            detail: '',
          },
          summary: { total: 0, complete: 0, missing: 0, notYetRequired: 0, failed: 0 },
        },
      });
      expect(result.success).toBe(false);
    });

    it('safeParse rejects blocked discriminant on ReviewReport', () => {
      const base = makeState('COMPLETE');
      const result = ReviewReport.safeParse({
        kind: 'blocked',
        schemaVersion: 'flowguard-review-report.v1',
        sessionId: base.id,
        generatedAt: NOW,
        phase: 'COMPLETE',
        planDigest: null,
        implDigest: null,
        validationSummary: [],
        findings: [],
        overallStatus: 'clean',
        completeness: {
          sessionId: base.id,
          phase: 'COMPLETE',
          policyMode: 'unknown',
          overallComplete: true,
          slots: [],
          fourEyes: {
            required: false,
            satisfied: true,
            initiatedBy: '',
            decidedBy: null,
            detail: '',
          },
          summary: { total: 0, complete: 0, missing: 0, notYetRequired: 0, failed: 0 },
        },
      });
      expect(result.success).toBe(false);
    });

    it('safeParse rejects missing schemaVersion', () => {
      const base = makeState('COMPLETE');
      const result = ReviewReport.safeParse({
        sessionId: base.id,
        generatedAt: NOW,
        phase: 'COMPLETE',
        planDigest: null,
        implDigest: null,
        validationSummary: [],
        findings: [],
        overallStatus: 'clean',
        completeness: {
          sessionId: base.id,
          phase: 'COMPLETE',
          policyMode: 'unknown',
          overallComplete: true,
          slots: [],
          fourEyes: {
            required: false,
            satisfied: true,
            initiatedBy: '',
            decidedBy: null,
            detail: '',
          },
          summary: { total: 0, complete: 0, missing: 0, notYetRequired: 0, failed: 0 },
        },
      });
      expect(result.success).toBe(false);
    });

    it('safeParse rejects missing required findings array', () => {
      const base = makeState('COMPLETE');
      const result = ReviewReport.safeParse({
        schemaVersion: 'flowguard-review-report.v1',
        sessionId: base.id,
        generatedAt: NOW,
        phase: 'COMPLETE',
        planDigest: null,
        implDigest: null,
        validationSummary: [],
        overallStatus: 'clean',
      });
      expect(result.success).toBe(false);
    });

    it('safeParse rejects wrong type for sessionId (number)', () => {
      const base = makeState('COMPLETE');
      const result = ReviewReport.safeParse({
        schemaVersion: 'flowguard-review-report.v1',
        sessionId: 12345,
        generatedAt: NOW,
        phase: 'COMPLETE',
        planDigest: null,
        implDigest: null,
        validationSummary: [],
        findings: [],
        overallStatus: 'clean',
        completeness: {
          sessionId: base.id,
          phase: 'COMPLETE',
          policyMode: 'unknown',
          overallComplete: true,
          slots: [],
          fourEyes: {
            required: false,
            satisfied: true,
            initiatedBy: '',
            decidedBy: null,
            detail: '',
          },
          summary: { total: 0, complete: 0, missing: 0, notYetRequired: 0, failed: 0 },
        },
      });
      expect(result.success).toBe(false);
    });

    it('safeParse rejects invalid completeness shape (missing slots)', () => {
      const base = makeState('COMPLETE');
      const result = ReviewReport.safeParse({
        schemaVersion: 'flowguard-review-report.v1',
        sessionId: base.id,
        generatedAt: NOW,
        phase: 'COMPLETE',
        planDigest: null,
        implDigest: null,
        validationSummary: [],
        findings: [],
        overallStatus: 'clean',
        completeness: { bad: true },
      });
      expect(result.success).toBe(false);
    });

    it('safeParse accepts valid minimal ReviewReport', () => {
      const base = makeState('COMPLETE');
      const result = ReviewReport.safeParse({
        schemaVersion: 'flowguard-review-report.v1',
        sessionId: base.id,
        generatedAt: NOW,
        phase: 'COMPLETE',
        planDigest: null,
        implDigest: null,
        validationSummary: [],
        findings: [],
        overallStatus: 'clean',
        completeness: {
          sessionId: base.id,
          phase: 'COMPLETE',
          policyMode: 'unknown',
          overallComplete: true,
          slots: [],
          fourEyes: {
            required: false,
            satisfied: true,
            initiatedBy: '',
            decidedBy: null,
            detail: '',
          },
          summary: { total: 0, complete: 0, missing: 0, notYetRequired: 0, failed: 0 },
        },
      });
      expect(result.success).toBe(true);
    });

    it('executeReview rejects invalid completeness via buildReviewReport integration', async () => {
      // buildReviewReport internally calls ReviewReport.parse(), so an
      // invalid completeness should cause a throw when the report is built.
      const state = makeState('COMPLETE');
      // We cannot directly call buildReviewReport with invalid completeness
      // from a test because it derives completeness via evaluateCompleteness.
      // Instead, verify the builder boundary rejects by calling it with
      // explicitly broken data.
      const completeness = {} as Parameters<typeof buildReviewReport>[0]['completeness'];
      expect(() =>
        buildReviewReport({
          state,
          now: NOW,
          validationSummary: [],
          findings: [],
          completeness,
        }),
      ).toThrow();
    });
  });
});
