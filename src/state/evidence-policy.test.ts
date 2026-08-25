/**
 * @module evidence-policy.test
 * @description Tests for evidence-policy module.
 * Extracted from evidence-split.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { PolicySnapshotSchema } from './evidence-policy.js';
import { FIXED_TIME } from './evidence-test-constants.js';
import { POLICY_DIGEST_VERSION } from '../shared/policy-digest.js';

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
      expect(parsed.hashVersion).toBeUndefined();
      expect(parsed.minimumActorAssuranceForApproval).toBe('best_effort');
      expect(parsed.requireVerifiedActorsForApproval).toBe(false);
      expect(parsed.identityProviderMode).toBe('optional');
    });

    it('distinguishes a v2 policy digest from legacy snapshots', () => {
      const parsed = PolicySnapshotSchema.parse({
        mode: 'team',
        hash: 'sha256-policy',
        hashVersion: POLICY_DIGEST_VERSION,
        resolvedAt: FIXED_TIME,
        requestedMode: 'team',
        effectiveGateBehavior: 'human_gated',
        requireHumanGates: true,
        maxSelfReviewIterations: 3,
        maxImplReviewIterations: 3,
        allowSelfApproval: true,
        audit: { emitTransitions: true, emitToolCalls: true, enableChainHash: true },
        actorClassification: { flowguard_decision: 'human' },
      });

      expect(parsed.hashVersion).toBe(POLICY_DIGEST_VERSION);
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
    it('rejects unknown policy digest versions', () => {
      expect(() =>
        PolicySnapshotSchema.parse({
          mode: 'team',
          hash: 'abc',
          hashVersion: 'policy-digest.v3',
          resolvedAt: FIXED_TIME,
          requestedMode: 'team',
          effectiveGateBehavior: 'human_gated',
          requireHumanGates: true,
          maxSelfReviewIterations: 3,
          maxImplReviewIterations: 3,
          allowSelfApproval: true,
          audit: { emitTransitions: true, emitToolCalls: true, enableChainHash: true },
          actorClassification: { flowguard_decision: 'human' },
        }),
      ).toThrow();
    });

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

    it('applies a fail-closed off default for legacy non-regulated snapshots (#399)', () => {
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
        // discoveryHealth intentionally absent (legacy snapshot)
      };
      expect(PolicySnapshotSchema.parse(snapshot).discoveryHealth).toEqual({
        enforcement: 'off',
        onDegraded: 'allow',
        onDrift: 'allow',
      });
    });

    it('applies a required default for legacy regulated snapshots (#399)', () => {
      const snapshot = {
        mode: 'regulated',
        hash: 'abc',
        resolvedAt: FIXED_TIME,
        requestedMode: 'regulated',
        effectiveGateBehavior: 'human_gated' as const,
        requireHumanGates: true,
        maxSelfReviewIterations: 3,
        maxImplReviewIterations: 3,
        allowSelfApproval: false,
        audit: { emitTransitions: true, emitToolCalls: true, enableChainHash: true },
        actorClassification: { flowguard_decision: 'human' },
        // discoveryHealth intentionally absent (legacy snapshot)
      };
      expect(PolicySnapshotSchema.parse(snapshot).discoveryHealth).toEqual({
        enforcement: 'required',
        onDegraded: 'warn',
        onDrift: 'block',
      });
    });

    it('preserves an explicit discoveryHealth block when present (#399)', () => {
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
        discoveryHealth: {
          enforcement: 'required' as const,
          onDegraded: 'block' as const,
          onDrift: 'block' as const,
        },
      };
      expect(PolicySnapshotSchema.parse(snapshot).discoveryHealth).toEqual({
        enforcement: 'required',
        onDegraded: 'block',
        onDrift: 'block',
      });
    });
  });

  describe('validationEvidence backward compatibility (#400)', () => {
    const legacyBase = {
      hash: 'abc',
      resolvedAt: FIXED_TIME,
      effectiveGateBehavior: 'human_gated' as const,
      requireHumanGates: true,
      maxSelfReviewIterations: 3,
      maxImplReviewIterations: 3,
      allowSelfApproval: true,
      audit: { emitTransitions: true, emitToolCalls: true, enableChainHash: true },
      actorClassification: { flowguard_decision: 'human' },
    };

    it('applies an off default for legacy non-regulated snapshots', () => {
      const snapshot = { ...legacyBase, mode: 'team', requestedMode: 'team' };
      expect(PolicySnapshotSchema.parse(snapshot).validationEvidence).toEqual({
        enforcement: 'off',
        allowNoCommands: false,
      });
    });

    it('applies a required default for legacy regulated snapshots', () => {
      const snapshot = {
        ...legacyBase,
        mode: 'regulated',
        requestedMode: 'regulated',
        allowSelfApproval: false,
      };
      expect(PolicySnapshotSchema.parse(snapshot).validationEvidence).toEqual({
        enforcement: 'required',
        allowNoCommands: false,
      });
    });

    it('applies a required default for legacy team-ci snapshots', () => {
      const snapshot = { ...legacyBase, mode: 'team-ci', requestedMode: 'team-ci' };
      expect(PolicySnapshotSchema.parse(snapshot).validationEvidence).toEqual({
        enforcement: 'required',
        allowNoCommands: false,
      });
    });

    it('preserves an explicit validationEvidence block when present', () => {
      const snapshot = {
        ...legacyBase,
        mode: 'team',
        requestedMode: 'team',
        validationEvidence: { enforcement: 'required' as const, allowNoCommands: true },
      };
      expect(PolicySnapshotSchema.parse(snapshot).validationEvidence).toEqual({
        enforcement: 'required',
        allowNoCommands: true,
      });
    });
  });

  // #418: mode/requestedMode are a closed enum; near-miss strings MUST fail closed
  // instead of silently selecting the permissive enforcement default.
  describe('FAIL-CLOSED mode enum (#418)', () => {
    const validBase = {
      hash: 'sha256-policy',
      resolvedAt: FIXED_TIME,
      effectiveGateBehavior: 'human_gated' as const,
      requireHumanGates: true,
      maxSelfReviewIterations: 3,
      maxImplReviewIterations: 3,
      allowSelfApproval: true,
      audit: { emitTransitions: true, emitToolCalls: true, enableChainHash: true },
      actorClassification: { flowguard_decision: 'human' },
    };

    it.each(['regulatd', 'Regulated', 'regulated ', '', 'team_ci', 'admin'])(
      'rejects invalid mode %p at parse (no permissive fallthrough)',
      (badMode) => {
        const snapshot = { ...validBase, mode: badMode, requestedMode: badMode };
        expect(() => PolicySnapshotSchema.parse(snapshot)).toThrow();
      },
    );

    it('rejects a valid mode paired with an invalid requestedMode', () => {
      const snapshot = { ...validBase, mode: 'regulated', requestedMode: 'regulatd' };
      expect(() => PolicySnapshotSchema.parse(snapshot)).toThrow();
    });

    it.each(['solo', 'team', 'team-ci', 'regulated'] as const)(
      'accepts the canonical mode %p',
      (mode) => {
        const snapshot = { ...validBase, mode, requestedMode: mode };
        expect(PolicySnapshotSchema.parse(snapshot).mode).toBe(mode);
      },
    );

    it('does not silently disable enforcement for a near-miss regulated typo', () => {
      // Pre-fix defect: "regulatd" parsed as a free string and the regulated
      // enforcement default (enforceRiskClassification) was silently skipped.
      const snapshot = { ...validBase, mode: 'regulatd', requestedMode: 'regulatd' };
      const result = PolicySnapshotSchema.safeParse(snapshot);
      expect(result.success).toBe(false);
    });
  });
});
