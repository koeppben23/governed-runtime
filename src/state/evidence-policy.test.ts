/**
 * @module evidence-policy.test
 * @description Tests for evidence-policy module — Hard Assurance Epoch contract:
 *              the current-epoch snapshot requires every authority field the
 *              hydrate writer persists; incomplete snapshots are rejected.
 */
import { describe, it, expect } from 'vitest';
import { PolicySnapshotSchema } from './evidence-policy.js';
import { FIXED_TIME } from './evidence-test-constants.js';
import { POLICY_DIGEST_VERSION } from './evidence-identifiers.js';

const VALID_POLICY_DIGEST = 'a'.repeat(64);

/** A COMPLETE current-epoch snapshot: exactly what the hydrate writer persists. */
const CURRENT_SNAPSHOT = {
  mode: 'team',
  hash: VALID_POLICY_DIGEST,
  hashVersion: POLICY_DIGEST_VERSION,
  resolvedAt: FIXED_TIME,
  requestedMode: 'team',
  effectiveGateBehavior: 'human_gated' as const,
  requireHumanGates: true,
  maxSelfReviewIterations: 3,
  maxImplReviewIterations: 3,
  maxIncoherentReviewerCaptureRetries: 1,
  maxReviewerOutputRepairAttempts: 1,
  allowSelfApproval: true,
  minimumActorAssuranceForApproval: 'best_effort' as const,
  requireVerifiedActorsForApproval: false,
  identityProviderMode: 'optional' as const,
  reviewOutputPolicy: 'text_compat_allowed' as const,
  reviewInvocationPolicy: 'sdk_allowed' as const,
  reviewProfile: 'core' as const,
  selfReview: {
    subagentEnabled: true,
    fallbackToSelf: false,
    strictEnforcement: true,
  },
  challengePolicy: {
    version: 'challenge-policy.v1' as const,
    counts: { TRIVIAL: 0 as const, STANDARD: 1 as const, 'HIGH-RISK': 2 as const },
  },
  enforceRiskClassification: false,
  allowRiskDowngradeOverride: false,
  allowReducedCeremony: false,
  discoveryHealth: {
    enforcement: 'off' as const,
    onDegraded: 'allow' as const,
    onDrift: 'allow' as const,
  },
  validationEvidence: { enforcement: 'off' as const, allowNoCommands: false },
  audit: {
    emitTransitions: true,
    emitToolCalls: true,
    enableChainHash: true,
    timestampAssurance: {
      enabled: false,
      mode: 'local_only' as const,
      strict: false,
      criticalEvents: ['decision', 'lifecycle'],
      ntpServers: ['pool.ntp.org'],
      ntpDriftThresholdMs: 30000,
      tsaTimeoutMs: 10000,
    },
  },
  actorClassification: { flowguard_decision: 'human' },
};

describe('evidence-policy', () => {
  describe('HAPPY', () => {
    it('PolicySnapshotSchema parses the complete current-epoch snapshot', () => {
      const parsed = PolicySnapshotSchema.parse(CURRENT_SNAPSHOT);
      expect(parsed.mode).toBe('team');
      expect(parsed.hash).toBe(VALID_POLICY_DIGEST);
      expect(parsed.hashVersion).toBe(POLICY_DIGEST_VERSION);
      expect(parsed.minimumActorAssuranceForApproval).toBe('best_effort');
      expect(parsed.requireVerifiedActorsForApproval).toBe(false);
      expect(parsed.identityProviderMode).toBe('optional');
      expect(parsed.discoveryHealth).toEqual(CURRENT_SNAPSHOT.discoveryHealth);
      expect(parsed.validationEvidence).toEqual(CURRENT_SNAPSHOT.validationEvidence);
      expect(parsed.audit.timestampAssurance).toEqual(CURRENT_SNAPSHOT.audit.timestampAssurance);
    });

    it('rejects a missing policy digest version', () => {
      const { hashVersion: _hv, ...snapshot } = CURRENT_SNAPSHOT;
      expect(() => PolicySnapshotSchema.parse(snapshot)).toThrow();
    });

    it('PolicySnapshotSchema accepts regulated snapshot', () => {
      const parsed = PolicySnapshotSchema.parse({
        ...CURRENT_SNAPSHOT,
        mode: 'regulated',
        requestedMode: 'regulated',
        allowSelfApproval: false,
        minimumActorAssuranceForApproval: 'claim_validated',
        enforceRiskClassification: true,
      });
      expect(parsed.mode).toBe('regulated');
      expect(parsed.minimumActorAssuranceForApproval).toBe('claim_validated');
    });
  });

  describe('BAD', () => {
    it.each(['', 'abc', 'UNKNOWN_LEGACY', 'A'.repeat(64)])(
      'rejects invalid v2 policy digest %p',
      (hash) => {
        expect(PolicySnapshotSchema.safeParse({ ...CURRENT_SNAPSHOT, hash }).success).toBe(false);
      },
    );

    it('rejects a missing v2 policy digest', () => {
      const { hash: _hash, ...snapshot } = CURRENT_SNAPSHOT;
      expect(PolicySnapshotSchema.safeParse(snapshot).success).toBe(false);
    });

    it('rejects unknown policy digest versions', () => {
      expect(() =>
        PolicySnapshotSchema.parse({
          ...CURRENT_SNAPSHOT,
          hashVersion: 'policy-digest.v3',
        }),
      ).toThrow();
    });

    it('PolicySnapshotSchema rejects missing actorClassification', () => {
      const { actorClassification: _ac, ...snapshot } = CURRENT_SNAPSHOT;
      expect(() => PolicySnapshotSchema.parse(snapshot)).toThrow();
    });

    it('PolicySnapshotSchema rejects missing requestedMode', () => {
      const { requestedMode: _rm, ...snapshot } = CURRENT_SNAPSHOT;
      expect(() => PolicySnapshotSchema.parse(snapshot)).toThrow();
    });
  });

  describe('CORNER — Hard Assurance Epoch: no read-time defaulting', () => {
    it('rejects a snapshot missing minimumActorAssuranceForApproval', () => {
      const { minimumActorAssuranceForApproval: _m, ...snapshot } = CURRENT_SNAPSHOT;
      expect(() => PolicySnapshotSchema.parse(snapshot)).toThrow();
    });

    it('rejects a snapshot missing requireVerifiedActorsForApproval', () => {
      const { requireVerifiedActorsForApproval: _r, ...snapshot } = CURRENT_SNAPSHOT;
      expect(() => PolicySnapshotSchema.parse(snapshot)).toThrow();
    });

    it('rejects a snapshot missing identityProviderMode', () => {
      const { identityProviderMode: _i, ...snapshot } = CURRENT_SNAPSHOT;
      expect(() => PolicySnapshotSchema.parse(snapshot)).toThrow();
    });

    it('rejects a snapshot missing discoveryHealth (no legacy synthesis)', () => {
      const { discoveryHealth: _d, ...snapshot } = CURRENT_SNAPSHOT;
      expect(() => PolicySnapshotSchema.parse(snapshot)).toThrow();
    });

    it('rejects a snapshot missing validationEvidence (no legacy synthesis)', () => {
      const { validationEvidence: _v, ...snapshot } = CURRENT_SNAPSHOT;
      expect(() => PolicySnapshotSchema.parse(snapshot)).toThrow();
    });

    it('rejects a snapshot missing allowReducedCeremony', () => {
      const { allowReducedCeremony: _a, ...snapshot } = CURRENT_SNAPSHOT;
      expect(() => PolicySnapshotSchema.parse(snapshot)).toThrow();
    });

    it('rejects a snapshot missing reviewOutputPolicy / reviewInvocationPolicy / reviewProfile', () => {
      const { reviewOutputPolicy: _o, ...withoutOutput } = CURRENT_SNAPSHOT;
      const { reviewInvocationPolicy: _i, ...withoutInvocation } = withoutOutput;
      const { reviewProfile: _p, ...snapshot } = withoutInvocation;
      expect(() => PolicySnapshotSchema.parse(snapshot)).toThrow();
    });

    it('rejects a snapshot missing audit.timestampAssurance', () => {
      const snapshot = {
        ...CURRENT_SNAPSHOT,
        audit: {
          emitTransitions: true,
          emitToolCalls: true,
          enableChainHash: true,
        },
      };
      expect(() => PolicySnapshotSchema.parse(snapshot)).toThrow();
    });

    it('rejects a snapshot missing challengePolicy (no silent challenge-coverage disable)', () => {
      const { challengePolicy: _c, ...snapshot } = CURRENT_SNAPSHOT;
      expect(() => PolicySnapshotSchema.parse(snapshot)).toThrow();
    });

    it('rejects a snapshot missing selfReview (no read-time reconstruction)', () => {
      const { selfReview: _s, ...snapshot } = CURRENT_SNAPSHOT;
      expect(() => PolicySnapshotSchema.parse(snapshot)).toThrow();
    });

    it('preserves explicit authority values verbatim (no reinterpretation)', () => {
      const parsed = PolicySnapshotSchema.parse({
        ...CURRENT_SNAPSHOT,
        discoveryHealth: { enforcement: 'required', onDegraded: 'block', onDrift: 'block' },
        validationEvidence: { enforcement: 'required', allowNoCommands: true },
      });
      expect(parsed.discoveryHealth).toEqual({
        enforcement: 'required',
        onDegraded: 'block',
        onDrift: 'block',
      });
      expect(parsed.validationEvidence).toEqual({
        enforcement: 'required',
        allowNoCommands: true,
      });
    });
  });

  // #418: mode/requestedMode are a closed enum; near-miss strings MUST fail closed
  // instead of silently selecting the permissive enforcement default.
  describe('FAIL-CLOSED mode enum (#418)', () => {
    it.each(['regulatd', 'Regulated', 'regulated ', '', 'team_ci', 'admin'])(
      'rejects invalid mode %p at parse (no permissive fallthrough)',
      (badMode) => {
        const snapshot = { ...CURRENT_SNAPSHOT, mode: badMode, requestedMode: badMode };
        expect(() => PolicySnapshotSchema.parse(snapshot)).toThrow();
      },
    );

    it('rejects a valid mode paired with an invalid requestedMode', () => {
      const snapshot = { ...CURRENT_SNAPSHOT, mode: 'regulated', requestedMode: 'regulatd' };
      expect(() => PolicySnapshotSchema.parse(snapshot)).toThrow();
    });

    it.each(['solo', 'team', 'team-ci', 'regulated'] as const)(
      'accepts the canonical mode %p',
      (mode) => {
        const snapshot = { ...CURRENT_SNAPSHOT, mode, requestedMode: mode };
        expect(PolicySnapshotSchema.parse(snapshot).mode).toBe(mode);
      },
    );

    it('does not silently disable enforcement for a near-miss regulated typo', () => {
      // Pre-fix defect: "regulatd" parsed as a free string and the regulated
      // enforcement default (enforceRiskClassification) was silently skipped.
      const snapshot = { ...CURRENT_SNAPSHOT, mode: 'regulatd', requestedMode: 'regulatd' };
      const result = PolicySnapshotSchema.safeParse(snapshot);
      expect(result.success).toBe(false);
    });
  });
});
