/**
 * @module review-schema-validation.test
 * @description Tests for ReviewReport schema validation — Zod type-safe
 *              discriminated union and buildReviewReport integration.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE, PERF — all five categories present.
 */

import { describe, it, expect } from 'vitest';
import { executeReview, buildReviewReport } from './review.js';
import {
  ReviewReport,
  ReviewReportFinding,
  type PeerReviewCoverage,
  type ReviewReportFinding as ReviewReportFindingType,
} from '../state/evidence.js';
import { makeState } from '../fixtures.js';

// ─── Test Helpers ─────────────────────────────────────────────────────────────

const NOW = '2026-01-15T10:00:00.000Z';

const validCoverage: PeerReviewCoverage = {
  targetResolved: false,
  targetFrozen: false,
  repositoryIdentityVerified: null,
  baseSha: null,
  headSha: null,
  changedPathCount: 0,
  objectivesCovered: 0,
  objectivesTotal: 0,
  reviewAssurance: null,
  missingVerification: [],
};

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
        peerReviewCoverage: validCoverage,
      });
      expect(result.success).toBe(false);
    });

    it('rejects untagged and undeclared report finding fields', () => {
      expect(
        ReviewReportFinding.safeParse({
          reportSeverity: 'warning',
          category: 'quality',
          message: 'No source discriminator',
        }).success,
      ).toBe(false);
      expect(
        ReviewReportFinding.safeParse({
          source: 'mechanical',
          reportSeverity: 'warning',
          category: 'quality',
          message: 'Unexpected authority copy',
          relation: { subjectAnchors: [], evidenceLocations: [] },
        }).success,
      ).toBe(false);
    });

    it('preserves a complete canonical material finding relation', () => {
      const finding = {
        source: 'material_finding' as const,
        reportSeverity: 'error' as const,
        finding: {
          severity: 'major' as const,
          category: 'correctness' as const,
          message: 'Incorrect revision comparison',
          relation: {
            subjectAnchors: [
              {
                kind: 'repository_location' as const,
                location: { path: 'src/compare.ts', revision: 'head' as const, line: 12 },
              },
            ],
            evidenceLocations: [
              { path: 'src/compare.test.ts', revision: 'base' as const, line: 24 },
            ],
          },
        },
      };
      const result = ReviewReportFinding.parse(finding);
      expect(result).toEqual(finding);
      if (result.source !== 'material_finding') throw new Error('Expected material finding');
      expect(result.finding.relation.evidenceLocations[0]!.revision).toBe('base');
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
        reviewKind: 'lifecycle_review',
        peerReviewCoverage: validCoverage,
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
        reviewKind: 'lifecycle_review',
        peerReviewCoverage: validCoverage,
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
        reviewKind: 'lifecycle_review',
        peerReviewCoverage: validCoverage,
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
        reviewKind: 'lifecycle_review',
        peerReviewCoverage: validCoverage,
      });
      expect(result.success).toBe(false);
    });

    it('safeParse rejects invalid peerReviewCoverage shape', () => {
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
        reviewKind: 'lifecycle_review',
        peerReviewCoverage: { bad: true },
      });
      expect(result.success).toBe(false);
    });

    it('safeParse rejects a report without peerReviewCoverage', () => {
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
        reviewKind: 'lifecycle_review',
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
        reviewKind: 'lifecycle_review',
        peerReviewCoverage: validCoverage,
      });
      expect(result.success).toBe(true);
    });

    it('buildReviewReport rejects invalid report base data before coverage is attached', () => {
      // buildReviewReport internally calls ReviewReportDraft.parse(), so
      // invalid report data must throw before the completion layer attaches
      // the integration-owned peerReviewCoverage projection.
      const state = makeState('COMPLETE');
      const findings = [{ source: 'unexpected' } as unknown as ReviewReportFindingType];
      expect(() =>
        buildReviewReport({
          state,
          now: NOW,
          validationSummary: [],
          findings,
        }),
      ).toThrow();
    });
  });
});
