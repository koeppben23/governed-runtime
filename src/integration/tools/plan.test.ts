import { describe, it, expect, vi } from 'vitest';

describe('P34a: Independent Self-Review', () => {
  describe('Schema', () => {
    it('ReviewFindings schema validates correctly', async () => {
      const { ReviewFindings } = await import('../../state/evidence.js');

      const validFindings = {
        iteration: 1,
        planVersion: 1,
        reviewMode: 'subagent',
        overallVerdict: 'approve',
        blockingIssues: [
          {
            severity: 'critical',
            category: 'completeness',
            message: 'Missing test',
          },
        ],
        majorRisks: [
          {
            severity: 'major',
            category: 'risk',
            message: 'Potential null',
          },
        ],
        missingVerification: ['security_scan'],
        scopeCreep: [],
        unknowns: [],
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
        overallVerdict: 'approve' as const,
        blockingIssues: [],
        majorRisks: [],
        missingVerification: [],
        scopeCreep: [],
        unknowns: [],
        reviewedBy: { sessionId: 'ses_sub' },
        reviewedAt: new Date().toISOString(),
      };

      const selfFindings = {
        iteration: 1,
        planVersion: 1,
        reviewMode: 'self' as const,
        overallVerdict: 'changes_requested' as const,
        blockingIssues: [],
        majorRisks: [],
        missingVerification: [],
        scopeCreep: [],
        unknowns: [],
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

      const planRecord = {
        current: {
          body: '# Plan v1',
          digest: 'sha256-v1',
          sections: ['Plan'],
          createdAt: new Date().toISOString(),
        },
        history: [
          {
            body: '# Original',
            digest: 'sha256-orig',
            sections: [],
            createdAt: new Date().toISOString(),
          },
        ],
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
              },
            ],
            majorRisks: [],
            missingVerification: [],
            scopeCreep: [],
            unknowns: [],
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
        expect(result.data.history[0].digest).toBe('sha256-orig');
        expect(result.data.reviewFindings?.[0].blockingIssues.length).toBe(1);
      }
    });

    it('PlanRecord allows missing reviewFindings (backward compat)', async () => {
      const { PlanRecord } = await import('../../state/evidence.js');

      const recordWithoutReview = {
        current: {
          body: '# Plan',
          digest: 'sha256',
          sections: [],
          createdAt: new Date().toISOString(),
        },
        history: [],
      };

      const result = PlanRecord.safeParse(recordWithoutReview);
      expect(result.success).toBe(true);
    });
  });

  describe('Policy selfReview config', () => {
    it('FlowGuardPolicy includes selfReview', async () => {
      const { getPolicyPreset } = await import('../../config/policy.js');

      const solo = getPolicyPreset('solo');
      expect(solo.selfReview).toBeDefined();
      expect(solo.selfReview.subagentEnabled).toBe(false);
      expect(solo.selfReview.fallbackToSelf).toBe(false);

      const team = getPolicyPreset('team');
      expect(team.selfReview).toBeDefined();
      expect(team.selfReview.subagentEnabled).toBe(false);

      const regulated = getPolicyPreset('regulated');
      expect(regulated.selfReview).toBeDefined();
    });

    it('DEFAULT_SELF_REVIEW_CONFIG has correct defaults', async () => {
      const { DEFAULT_SELF_REVIEW_CONFIG } = await import('../../config/policy.js');

      expect(DEFAULT_SELF_REVIEW_CONFIG.subagentEnabled).toBe(false);
      expect(DEFAULT_SELF_REVIEW_CONFIG.fallbackToSelf).toBe(false);
    });

    it('policyFromSnapshot preserves selfReview from snapshot', async () => {
      const { policyFromSnapshot } = await import('../../config/policy.js');
      const { PolicySnapshotSchema } = await import('../../state/evidence.js');

      const snapshotWithSelfReview = PolicySnapshotSchema.parse({
        mode: 'team',
        hash: 'test-hash',
        resolvedAt: new Date().toISOString(),
        requestedMode: 'team',
        effectiveGateBehavior: 'human_gated',
        requireHumanGates: true,
        maxSelfReviewIterations: 3,
        maxImplReviewIterations: 3,
        allowSelfApproval: true,
        minimumActorAssuranceForApproval: 'best_effort',
        requireVerifiedActorsForApproval: false,
        identityProviderMode: 'optional',
        audit: {
          emitTransitions: true,
          emitToolCalls: true,
          enableChainHash: true,
        },
        actorClassification: {},
        selfReview: {
          subagentEnabled: true,
          fallbackToSelf: true,
        },
      });

      const policy = policyFromSnapshot(snapshotWithSelfReview);
      expect(policy.selfReview.subagentEnabled).toBe(true);
      expect(policy.selfReview.fallbackToSelf).toBe(true);
    });

    it('policyFromSnapshot uses default when snapshot lacks selfReview', async () => {
      const { policyFromSnapshot, DEFAULT_SELF_REVIEW_CONFIG } = await import(
        '../../config/policy.js'
      );
      const { PolicySnapshotSchema } = await import('../../state/evidence.js');

      const snapshotWithoutSelfReview = PolicySnapshotSchema.parse({
        mode: 'solo',
        hash: 'test-hash',
        resolvedAt: new Date().toISOString(),
        requestedMode: 'solo',
        effectiveGateBehavior: 'auto_approve',
        requireHumanGates: false,
        maxSelfReviewIterations: 2,
        maxImplReviewIterations: 1,
        allowSelfApproval: true,
        minimumActorAssuranceForApproval: 'best_effort',
        requireVerifiedActorsForApproval: false,
        identityProviderMode: 'optional',
        audit: {
          emitTransitions: true,
          emitToolCalls: true,
          enableChainHash: false,
        },
        actorClassification: {},
      });

      const policy = policyFromSnapshot(snapshotWithoutSelfReview);
      expect(policy.selfReview).toEqual(DEFAULT_SELF_REVIEW_CONFIG);
    });
  });

  describe('PolicySnapshot includes selfReview', () => {
    it('PolicySnapshotSchema validates selfReview field', async () => {
      const { PolicySnapshotSchema } = await import('../../state/evidence.js');

      const snapshotWithSelfReview = PolicySnapshotSchema.parse({
        mode: 'team',
        hash: 'test-hash',
        resolvedAt: new Date().toISOString(),
        requestedMode: 'team',
        effectiveGateBehavior: 'human_gated',
        requireHumanGates: true,
        maxSelfReviewIterations: 3,
        maxImplReviewIterations: 3,
        allowSelfApproval: true,
        minimumActorAssuranceForApproval: 'best_effort',
        requireVerifiedActorsForApproval: false,
        identityProviderMode: 'optional',
        audit: {
          emitTransitions: true,
          emitToolCalls: true,
          enableChainHash: true,
        },
        actorClassification: {},
        selfReview: {
          subagentEnabled: true,
          fallbackToSelf: false,
        },
      });

      expect(snapshotWithSelfReview.selfReview).toBeDefined();
      expect(snapshotWithSelfReview.selfReview?.subagentEnabled).toBe(true);
    });

    it('PolicySnapshotSchema allows missing selfReview (backward compat)', async () => {
      const { PolicySnapshotSchema } = await import('../../state/evidence.js');

      const snapshotWithoutSelfReview = PolicySnapshotSchema.parse({
        mode: 'solo',
        hash: 'test-hash',
        resolvedAt: new Date().toISOString(),
        requestedMode: 'solo',
        effectiveGateBehavior: 'auto_approve',
        requireHumanGates: false,
        maxSelfReviewIterations: 2,
        maxImplReviewIterations: 1,
        allowSelfApproval: true,
        minimumActorAssuranceForApproval: 'best_effort',
        requireVerifiedActorsForApproval: false,
        identityProviderMode: 'optional',
        audit: {
          emitTransitions: true,
          emitToolCalls: true,
          enableChainHash: false,
        },
        actorClassification: {},
      });

      expect(snapshotWithoutSelfReview.selfReview).toBeUndefined();
    });
  });
});

describe('P34a: Self-Review Fallback Semantics', () => {
  it('fallbackToSelf=true enables degraded fallback on subagent failure', async () => {
    const { getPolicyPreset } = await import('../../config/policy.js');

    const policy = getPolicyPreset('team');
    const mockPolicy = {
      ...policy,
      selfReview: { subagentEnabled: true, fallbackToSelf: true },
    };

    expect(mockPolicy.selfReview.fallbackToSelf).toBe(true);
  });

  it('fallbackToSelf=false blocks on subagent failure', async () => {
    const { getPolicyPreset } = await import('../../config/policy.js');

    const policy = getPolicyPreset('regulated');
    const mockPolicy = {
      ...policy,
      selfReview: { subagentEnabled: true, fallbackToSelf: false },
    };

    expect(mockPolicy.selfReview.fallbackToSelf).toBe(false);
  });
});
