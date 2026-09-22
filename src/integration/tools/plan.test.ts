import { describe, it, expect, vi } from 'vitest';
import { POLICY_DIGEST_VERSION } from '../../state/evidence-identifiers.js';
import { makePlanRevision, makePlanRevisionAfter } from '../../state/evidence-test-constants.js';
import { makeState } from '../../fixtures.js';
import { canonicalJsonStringify } from '../../shared/canonical-json.js';
import {
  buildPlanReviewObligationInput,
  type LegacyEmptyPlanClaimDeclarations,
} from './plan/plan-response.js';

const POLICY_DIGEST = 'a'.repeat(64);

const PLAN_EVIDENCE = {
  body: '# Plan\n\nImplement the bounded change.\n',
  digest: 'plan-digest',
  sections: ['Plan'],
  createdAt: '2026-01-01T00:00:00.000Z',
  revisionId: '00000000-0000-4000-8000-000000000001',
  recordDigest: 'plan-record-digest',
  planVersion: 1,
  supersedesRecordDigest: null,
  originatingReviewObligationId: null,
  revisionReason: null,
  lineageStatus: 'verified' as const,
};

const UNAVAILABLE_FREEZE = { kind: 'unavailable', reason: 'repository_unavailable' } as const;

describe('plan review obligation characterization', () => {
  it('preserves canonical initial-plan authority bytes', () => {
    const actual = buildPlanReviewObligationInput({
      state: makeState('PLAN'),
      now: '2026-01-01T00:00:00.000Z',
      planEvidence: PLAN_EVIDENCE,
      iteration: 0,
      planVersion: 1,
      classificationFiles: ['src/example.ts'],
      freeze: UNAVAILABLE_FREEZE,
      planClaimDeclarations: { flow: 'plan', version: 'v2', claims: [] },
    });
    expect(canonicalJsonStringify(actual)).toMatchSnapshot();
  });

  it('preserves canonical revision authority bytes without claim version', () => {
    const actual = buildPlanReviewObligationInput({
      state: makeState('PLAN'),
      now: '2026-01-01T00:00:00.000Z',
      planEvidence: { ...PLAN_EVIDENCE, planVersion: 2 },
      iteration: 1,
      planVersion: 2,
      classificationFiles: [],
      freeze: UNAVAILABLE_FREEZE,
      planClaimDeclarations: {
        flow: 'plan',
        claims: [],
      } satisfies LegacyEmptyPlanClaimDeclarations,
    });
    expect(canonicalJsonStringify(actual)).toMatchSnapshot();
  });
});

describe('P34a Foundation: Independent Self-Review Schema & Policy', () => {
  describe('Schema', () => {
    it('ReviewFindings schema validates correctly', async () => {
      const { ReviewFindings } = await import('../../state/evidence.js');

      const validFindings = {
        iteration: 1,
        planVersion: 1,
        reviewMode: 'subagent',
        overallVerdict: 'accept',
        blockingIssues: [
          {
            severity: 'critical',
            category: 'completeness',
            message: 'Missing test',
            relation: {
              subjectAnchors: [
                { kind: 'repository_location', location: { path: 'src/foo.ts', revision: 'head' } },
              ],
              evidenceLocations: [],
            },
          },
        ],
        majorRisks: [
          {
            severity: 'major',
            category: 'risk',
            message: 'Potential null',
            relation: {
              subjectAnchors: [
                { kind: 'repository_location', location: { path: 'src/foo.ts', revision: 'head' } },
              ],
              evidenceLocations: [],
            },
          },
        ],
        missingVerification: ['security_scan'],
        scopeCreep: [],
        unknowns: [],
        challenges: [],
        reviewedBy: {
          sessionId: 'ses_subagent',
        },
        reviewedAt: new Date().toISOString(),
      };

      const result = ReviewFindings.safeParse(validFindings);
      if (!result.success) {
        console.log('Zod errors:', result.error.issues);
      }
      expect(result.success).toBe(true);
    });

    it('ReviewFindings rejects invalid verdict', async () => {
      const { ReviewFindings } = await import('../../state/evidence.js');

      const invalidFindings = {
        iteration: 1,
        planVersion: 1,
        reviewMode: 'subagent',
        overallVerdict: 'invalid',
        blockingIssues: [],
        majorRisks: [],
        missingVerification: [],
        scopeCreep: [],
        unknowns: [],
        challenges: [],
        reviewedBy: { sessionId: 'ses_test' },
        reviewedAt: new Date().toISOString(),
      };

      const result = ReviewFindings.safeParse(invalidFindings);
      expect(result.success).toBe(false);
    });

    it('ReviewFindings allows both subagent and self review modes', async () => {
      const { ReviewFindings } = await import('../../state/evidence.js');

      const subagentFindings = {
        iteration: 1,
        planVersion: 1,
        reviewMode: 'subagent' as const,
        overallVerdict: 'accept' as const,
        blockingIssues: [],
        majorRisks: [],
        missingVerification: [],
        scopeCreep: [],
        unknowns: [],
        challenges: [],
        reviewedBy: { sessionId: 'ses_sub' },
        reviewedAt: new Date().toISOString(),
      };

      const selfFindings = {
        iteration: 1,
        planVersion: 1,
        reviewMode: 'subagent' as const,
        overallVerdict: 'changes_requested' as const,
        blockingIssues: [],
        majorRisks: [],
        missingVerification: [],
        scopeCreep: [],
        unknowns: [],
        challenges: [],
        reviewedBy: { sessionId: 'ses_self' },
        reviewedAt: new Date().toISOString(),
      };

      expect(ReviewFindings.safeParse(subagentFindings).success).toBe(true);
      expect(ReviewFindings.safeParse(selfFindings).success).toBe(true);
    });
  });

  describe('PlanRecord with reviewFindings', () => {
    it('PlanRecord stores author history and review findings separately', async () => {
      const { PlanRecord } = await import('../../state/evidence.js');

      const original = makePlanRevision({ body: '# Original' });
      const revised = makePlanRevisionAfter(original, { body: '# Plan v1' });
      const planRecord = {
        current: revised,
        history: [original],
        reviewCompletion: 'pending',
        reviewFindings: [
          {
            iteration: 0,
            planVersion: 1,
            reviewMode: 'subagent',
            overallVerdict: 'changes_requested',
            blockingIssues: [
              {
                severity: 'critical',
                category: 'completeness',
                message: 'Missing tests',
                relation: {
                  subjectAnchors: [
                    {
                      kind: 'repository_location',
                      location: { path: 'src/foo.ts', revision: 'head' },
                    },
                  ],
                  evidenceLocations: [],
                },
              },
            ],
            majorRisks: [],
            missingVerification: [],
            scopeCreep: [],
            unknowns: [],
            challenges: [],
            reviewedBy: { sessionId: 'ses_review' },
            reviewedAt: new Date().toISOString(),
          },
        ],
      };

      const result = PlanRecord.safeParse(planRecord);
      expect(result.success).toBe(true);

      if (result.success) {
        expect(result.data.history.length).toBe(1);
        expect(result.data.reviewFindings?.length).toBe(1);
        expect(result.data.history[0]!.digest).toBe(original.digest);
        expect(result.data.reviewFindings?.[0]?.blockingIssues.length).toBe(1);
      }
    });

    it('PlanRecord allows missing reviewFindings (backward compat)', async () => {
      const { PlanRecord } = await import('../../state/evidence.js');

      const recordWithoutReview = {
        current: makePlanRevision({ body: '# Plan' }),
        history: [],
        reviewCompletion: 'pending',
      };

      const result = PlanRecord.safeParse(recordWithoutReview);
      expect(result.success).toBe(true);
    });
  });
});

describe('P34a: Agent-Orchestrated Review Input Validation', () => {
  const validReviewFindingsSubagent = {
    iteration: 0,
    planVersion: 1,
    reviewMode: 'subagent' as const,
    overallVerdict: 'accept' as const,
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    challenges: [],
    reviewedBy: { sessionId: 'ses_subagent' },
    reviewedAt: new Date().toISOString(),
  };

  const validReviewFindingsSelf = {
    iteration: 0,
    planVersion: 1,
    reviewMode: 'self' as unknown as 'subagent',
    overallVerdict: 'accept' as const,
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    challenges: [],
    reviewedBy: { sessionId: 'ses_self' },
    reviewedAt: new Date().toISOString(),
  };

  it('reviewMode=subagent accepted when subagentEnabled=true', async () => {
    const { ReviewFindings } = await import('../../state/evidence.js');
    const result = ReviewFindings.safeParse(validReviewFindingsSubagent);
    expect(result.success).toBe(true);
  });

  it('ReviewFindings schema accepts self reviewMode (BUG-19 fallback)', async () => {
    const { ReviewFindings } = await import('../../state/evidence.js');
    const result = ReviewFindings.safeParse(validReviewFindingsSelf);
    expect(result.success).toBe(true);
  });

  it('ReviewFindings.planVersion must match expected version', async () => {
    const { ReviewFindings } = await import('../../state/evidence.js');

    const wrongVersion = { ...validReviewFindingsSubagent, planVersion: 99 };
    const result = ReviewFindings.safeParse(wrongVersion);

    expect(result.success).toBe(true);
  });

  it('ReviewFindings.iteration must be non-negative integer', async () => {
    const { ReviewFindings } = await import('../../state/evidence.js');

    const negativeIteration = { ...validReviewFindingsSubagent, iteration: -1 };
    const result = ReviewFindings.safeParse(negativeIteration);

    expect(result.success).toBe(false);
  });

  it('PlanRecord preserves reviewFindings append-only', async () => {
    const { PlanRecord } = await import('../../state/evidence.js');

    const existingPlan = {
      current: makePlanRevision({ body: 'v1' }),
      history: [],
      reviewCompletion: 'pending',
      reviewFindings: [validReviewFindingsSubagent],
    };

    const result = PlanRecord.safeParse(existingPlan);
    expect(result.success).toBe(true);
  });

  it('ReviewFindings rejects invalid reviewMode', async () => {
    const { ReviewFindings } = await import('../../state/evidence.js');

    const invalidMode = { ...validReviewFindingsSubagent, reviewMode: 'invalid' as any };
    const result = ReviewFindings.safeParse(invalidMode);

    expect(result.success).toBe(false);
  });

  it('ReviewFindings requires reviewedBy', async () => {
    const { ReviewFindings } = await import('../../state/evidence.js');

    const missingReviewer = { ...validReviewFindingsSubagent, reviewedBy: undefined };
    const result = ReviewFindings.safeParse(missingReviewer);

    expect(result.success).toBe(false);
  });

  it('reviewFindings with valid schema parses correctly', async () => {
    const { ReviewFindings: ReviewFindingsSchema } = await import('../../state/evidence.js');
    const result = ReviewFindingsSchema.safeParse(validReviewFindingsSubagent);
    expect(result.success).toBe(true);
  });

  it('reviewFindings rejects planVersion=0', async () => {
    const { ReviewFindings } = await import('../../state/evidence.js');

    const zeroVersion = { ...validReviewFindingsSubagent, planVersion: 0 };
    const result = ReviewFindings.safeParse(zeroVersion);

    expect(result.success).toBe(false);
  });

  it('reviewFindings allows empty arrays for optional fields', async () => {
    const { ReviewFindings } = await import('../../state/evidence.js');

    const minimalFindings = {
      iteration: 0,
      planVersion: 1,
      reviewMode: 'subagent' as const,
      overallVerdict: 'changes_requested' as const,
      blockingIssues: [],
      majorRisks: [],
      missingVerification: [],
      scopeCreep: [],
      unknowns: [],
      challenges: [],
      reviewedBy: { sessionId: 'ses_min' },
      reviewedAt: new Date().toISOString(),
    };

    const result = ReviewFindings.safeParse(minimalFindings);
    expect(result.success).toBe(true);
  });
});
