/**
 * @module evidence-policy.test
 * @description Tests for evidence-policy module.
 * Extracted from evidence-split.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { PolicySnapshotSchema } from './evidence-policy.js';
import { FIXED_TIME } from './evidence-test-constants.js';

describe('evidence-policy', () => {
  describe('HAPPY', () => {
    it('PolicySnapshotSchema parses minimal valid snapshot', () => {
      const snapshot = {
        mode: 'team',
        hash: 'sha256-policy',
        resolvedAt: FIXED_TIME,
        requestedMode: 'team',
        effectiveGateBehavior: 'human_gated' as const,
        requireHumanGates: true,
        maxSelfReviewIterations: 3,
        maxImplReviewIterations: 3,
        allowSelfApproval: true,
        audit: { emitTransitions: true, emitToolCalls: true, enableChainHash: true },
        actorClassification: { flowguard_decision: 'human' },
      };
      const parsed = PolicySnapshotSchema.parse(snapshot);
      expect(parsed.mode).toBe('team');
      expect(parsed.hash).toBe('sha256-policy');
      expect(parsed.minimumActorAssuranceForApproval).toBe('best_effort');
      expect(parsed.requireVerifiedActorsForApproval).toBe(false);
      expect(parsed.identityProviderMode).toBe('optional');
    });

    it('PolicySnapshotSchema accepts regulated snapshot', () => {
      const snapshot = {
        mode: 'regulated',
        hash: 'sha256-reg',
        resolvedAt: FIXED_TIME,
        requestedMode: 'regulated',
        effectiveGateBehavior: 'human_gated' as const,
        requireHumanGates: true,
        maxSelfReviewIterations: 3,
        maxImplReviewIterations: 3,
        allowSelfApproval: false,
        minimumActorAssuranceForApproval: 'claim_validated' as const,
        audit: { emitTransitions: true, emitToolCalls: true, enableChainHash: true },
        actorClassification: { flowguard_decision: 'human' },
      };
      const parsed = PolicySnapshotSchema.parse(snapshot);
      expect(parsed.mode).toBe('regulated');
      expect(parsed.minimumActorAssuranceForApproval).toBe('claim_validated');
      expect(parsed.requireVerifiedActorsForApproval).toBe(false);
      expect(parsed.identityProviderMode).toBe('optional');
    });
  });

  describe('BAD', () => {
    it('PolicySnapshotSchema rejects missing actorClassification', () => {
      const snapshot = {
        mode: 'team',
        hash: 'abc',
        resolvedAt: FIXED_TIME,
        requestedMode: 'team',
        effectiveGateBehavior: 'human_gated',
        requireHumanGates: true,
        maxSelfReviewIterations: 3,
        maxImplReviewIterations: 3,
        allowSelfApproval: true,
        audit: { emitTransitions: true, emitToolCalls: true, enableChainHash: true },
      };
      expect(() => PolicySnapshotSchema.parse(snapshot)).toThrow();
    });

    it('PolicySnapshotSchema rejects missing requestedMode', () => {
      const snapshot = {
        mode: 'team',
        hash: 'abc',
        resolvedAt: FIXED_TIME,
        effectiveGateBehavior: 'human_gated',
        requireHumanGates: true,
        maxSelfReviewIterations: 3,
        maxImplReviewIterations: 3,
        allowSelfApproval: true,
        audit: { emitTransitions: true, emitToolCalls: true, enableChainHash: true },
        actorClassification: { flowguard_decision: 'human' },
      };
      expect(() => PolicySnapshotSchema.parse(snapshot)).toThrow();
    });
  });

  describe('CORNER', () => {
    it('PolicySnapshotSchema defaults minimumActorAssuranceForApproval', () => {
      const snapshot = {
        mode: 'team',
        hash: 'abc',
        resolvedAt: FIXED_TIME,
        requestedMode: 'team',
        effectiveGateBehavior: 'human_gated' as const,
        requireHumanGates: true,
        maxSelfReviewIterations: 3,
        maxImplReviewIterations: 3,
        allowSelfApproval: true,
        audit: { emitTransitions: true, emitToolCalls: true, enableChainHash: true },
        actorClassification: { flowguard_decision: 'human' },
      };
      expect(PolicySnapshotSchema.parse(snapshot).minimumActorAssuranceForApproval).toBe(
        'best_effort',
      );
    });
  });
});
