/**
 * @module evidence-policy.test
 * @description Tests for evidence-policy module.
 * Extracted from evidence-split.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { PolicySnapshotSchema } from './evidence-policy.js';
import { FIXED_TIME } from './evidence-test-constants.js';
import { POLICY_DIGEST_VERSION } from './evidence-identifiers.js';

const VALID_POLICY_DIGEST = 'a'.repeat(64);
const MINIMAL_POLICY_SNAPSHOT = {
  mode: 'team',
  hash: VALID_POLICY_DIGEST,
  hashVersion: POLICY_DIGEST_VERSION,
  resolvedAt: FIXED_TIME,
  requestedMode: 'team',
  effectiveGateBehavior: 'human_gated' as const,
  requireHumanGates: true,
  maxSelfReviewIterations: 3,
  maxImplReviewIterations: 3,
  allowSelfApproval: true,
  enforceRiskClassification: false,
  allowRiskDowngradeOverride: false,
  audit: { emitTransitions: true, emitToolCalls: true, enableChainHash: true },
  actorClassification: { flowguard_decision: 'human' },
};

describe('evidence-policy', () => {
  describe('HAPPY', () => {
    it('PolicySnapshotSchema parses minimal valid snapshot', () => {
      const snapshot = {
        mode: 'team',
        hash: VALID_POLICY_DIGEST,
        hashVersion: POLICY_DIGEST_VERSION,
        resolvedAt: FIXED_TIME,
        requestedMode: 'team',
        effectiveGateBehavior: 'human_gated' as const,
        requireHumanGates: true,
        maxSelfReviewIterations: 3,
        maxImplReviewIterations: 3,
        allowSelfApproval: true,
        enforceRiskClassification: false,
        allowRiskDowngradeOverride: false,
        audit: { emitTransitions: true, emitToolCalls: true, enableChainHash: true },
        actorClassification: { flowguard_decision: 'human' },
      };
      const parsed = PolicySnapshotSchema.parse(snapshot);
      expect(parsed.mode).toBe('team');
      expect(parsed.hash).toBe(VALID_POLICY_DIGEST);
      expect(parsed.hashVersion).toBe(POLICY_DIGEST_VERSION);
      expect(parsed.minimumActorAssuranceForApproval).toBe('best_effort');
      expect(parsed.requireVerifiedActorsForApproval).toBe(false);
      expect(parsed.identityProviderMode).toBe('optional');
    });

    it('rejects a missing policy digest version', () => {
      const snapshot = {
        mode: 'team',
        hash: VALID_POLICY_DIGEST,
        resolvedAt: FIXED_TIME,
        requestedMode: 'team',
        effectiveGateBehavior: 'human_gated',
        requireHumanGates: true,
        maxSelfReviewIterations: 3,
        maxImplReviewIterations: 3,
        allowSelfApproval: true,
        enforceRiskClassification: false,
        allowRiskDowngradeOverride: false,
        audit: { emitTransitions: true, emitToolCalls: true, enableChainHash: true },
        actorClassification: { flowguard_decision: 'human' },
      };

      expect(() => PolicySnapshotSchema.parse(snapshot)).toThrow();
    });

    it('PolicySnapshotSchema accepts regulated snapshot', () => {
      const snapshot = {
        mode: 'regulated',
        hash: VALID_POLICY_DIGEST,
        hashVersion: POLICY_DIGEST_VERSION,
        resolvedAt: FIXED_TIME,
        requestedMode: 'regulated',
        effectiveGateBehavior: 'human_gated' as const,
        requireHumanGates: true,
        maxSelfReviewIterations: 3,
        maxImplReviewIterations: 3,
        allowSelfApproval: false,
        minimumActorAssuranceForApproval: 'claim_validated' as const,
        enforceRiskClassification: true,
        allowRiskDowngradeOverride: false,
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
    it.each(['', 'abc', 'UNKNOWN_LEGACY', 'A'.repeat(64)])(
      'rejects invalid v2 policy digest %p',
      (hash) => {
        expect(PolicySnapshotSchema.safeParse({ ...MINIMAL_POLICY_SNAPSHOT, hash }).success).toBe(
          false,
        );
      },
    );

    it('rejects a missing v2 policy digest', () => {
      const { hash: _hash, ...snapshot } = MINIMAL_POLICY_SNAPSHOT;
      expect(PolicySnapshotSchema.safeParse(snapshot).success).toBe(false);
    });

    it('rejects unknown policy digest versions', () => {
      expect(() =>
        PolicySnapshotSchema.parse({
          mode: 'team',
          hash: VALID_POLICY_DIGEST,
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
        hash: VALID_POLICY_DIGEST,
        hashVersion: POLICY_DIGEST_VERSION,
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
        hash: VALID_POLICY_DIGEST,
        hashVersion: POLICY_DIGEST_VERSION,
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
        hash: VALID_POLICY_DIGEST,
        hashVersion: POLICY_DIGEST_VERSION,
        resolvedAt: FIXED_TIME,
        requestedMode: 'team',
        effectiveGateBehavior: 'human_gated' as const,
        requireHumanGates: true,
        maxSelfReviewIterations: 3,
        maxImplReviewIterations: 3,
        allowSelfApproval: true,
        enforceRiskClassification: false,
        allowRiskDowngradeOverride: false,
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
        hash: VALID_POLICY_DIGEST,
        hashVersion: POLICY_DIGEST_VERSION,
        resolvedAt: FIXED_TIME,
        requestedMode: 'team',
        effectiveGateBehavior: 'human_gated' as const,
        requireHumanGates: true,
        maxSelfReviewIterations: 3,
        maxImplReviewIterations: 3,
        allowSelfApproval: true,
        enforceRiskClassification: false,
        allowRiskDowngradeOverride: false,
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
        hash: VALID_POLICY_DIGEST,
        hashVersion: POLICY_DIGEST_VERSION,
        resolvedAt: FIXED_TIME,
        requestedMode: 'regulated',
        effectiveGateBehavior: 'human_gated' as const,
        requireHumanGates: true,
        maxSelfReviewIterations: 3,
        maxImplReviewIterations: 3,
        allowSelfApproval: false,
        enforceRiskClassification: true,
        allowRiskDowngradeOverride: false,
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
        hash: VALID_POLICY_DIGEST,
        hashVersion: POLICY_DIGEST_VERSION,
        resolvedAt: FIXED_TIME,
        requestedMode: 'team',
        effectiveGateBehavior: 'human_gated' as const,
        requireHumanGates: true,
        maxSelfReviewIterations: 3,
        maxImplReviewIterations: 3,
        allowSelfApproval: true,
        enforceRiskClassification: false,
        allowRiskDowngradeOverride: false,
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
      hash: VALID_POLICY_DIGEST,
      hashVersion: POLICY_DIGEST_VERSION,
      resolvedAt: FIXED_TIME,
      effectiveGateBehavior: 'human_gated' as const,
      requireHumanGates: true,
      maxSelfReviewIterations: 3,
      maxImplReviewIterations: 3,
      allowSelfApproval: true,
      enforceRiskClassification: false,
      allowRiskDowngradeOverride: false,
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
      hash: VALID_POLICY_DIGEST,
      hashVersion: POLICY_DIGEST_VERSION,
      resolvedAt: FIXED_TIME,
      effectiveGateBehavior: 'human_gated' as const,
      requireHumanGates: true,
      maxSelfReviewIterations: 3,
      maxImplReviewIterations: 3,
      allowSelfApproval: true,
      enforceRiskClassification: false,
      allowRiskDowngradeOverride: false,
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
