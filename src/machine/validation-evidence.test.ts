/**
 * @module machine/validation-evidence.test
 * @description Unit tests for the policy-gated validation-evidence authority (#400).
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 * @version v1
 */

import { describe, expect, it } from 'vitest';
import type { SessionState } from '../state/schema.js';
import type { DiscoverySummary } from '../state/discovery-schemas.js';
import {
  evaluateValidationEvidence,
  hasTrustworthyDiscoveryForVerification,
} from './validation-evidence.js';
import { makeState, POLICY_SNAPSHOT } from '../__fixtures__.js';

const SUMMARY: DiscoverySummary = {
  primaryLanguages: ['typescript'],
  frameworks: [],
  topologyKind: 'single-project',
  moduleCount: 1,
  hasApiSurface: false,
  hasPersistenceSurface: false,
  hasCiCd: false,
  hasSecuritySurface: false,
};

/** Build a VALIDATION-phase state with explicit validationEvidence policy + discovery signals. */
function makeValidationState(opts: {
  enforcement: 'off' | 'advisory' | 'required';
  allowNoCommands?: boolean;
  activeChecks?: string[];
  trustworthy?: boolean;
  // Fine-grained trust overrides (only applied when trustworthy is undefined).
  discoverySummary?: DiscoverySummary | null;
  discoveryDigest?: string | null;
  discoveryHealthEnforcement?: 'off' | 'advisory' | 'required';
  gate?: SessionState['discoveryHealthGate'];
}): SessionState {
  const trustworthyDefaults =
    opts.trustworthy === true
      ? {
          discoverySummary: SUMMARY,
          discoveryDigest: 'digest-abc',
          discoveryHealthEnforcement: 'required' as const,
          gate: {
            status: 'clear' as const,
            lastDriftAssessment: 'clean' as const,
          },
        }
      : opts.trustworthy === false
        ? {
            discoverySummary: null,
            discoveryDigest: null,
            discoveryHealthEnforcement: 'off' as const,
            gate: undefined,
          }
        : {
            discoverySummary: opts.discoverySummary ?? null,
            discoveryDigest: opts.discoveryDigest ?? null,
            discoveryHealthEnforcement: opts.discoveryHealthEnforcement ?? 'off',
            gate: opts.gate,
          };

  return makeState('VALIDATION', {
    activeChecks: opts.activeChecks ?? [],
    discoverySummary: trustworthyDefaults.discoverySummary,
    discoveryDigest: trustworthyDefaults.discoveryDigest,
    discoveryHealthGate: trustworthyDefaults.gate,
    policySnapshot: {
      ...POLICY_SNAPSHOT,
      discoveryHealth: {
        enforcement: trustworthyDefaults.discoveryHealthEnforcement,
        onDegraded: 'allow',
        onDrift: 'allow',
      },
      validationEvidence: {
        enforcement: opts.enforcement,
        allowNoCommands: opts.allowNoCommands ?? false,
      },
    },
  });
}

describe('machine/validation-evidence', () => {
  // ─── HAPPY ──────────────────────────────────────────────────
  describe('HAPPY — evaluateValidationEvidence', () => {
    it('off enforcement with empty checks → not blocked (legacy vacuous pass preserved)', () => {
      const d = evaluateValidationEvidence(makeValidationState({ enforcement: 'off' }));
      expect(d.blocked).toBe(false);
      expect(d.required).toBe(false);
      expect(d.code).toBeNull();
    });

    it('advisory enforcement with empty checks → not blocked', () => {
      const d = evaluateValidationEvidence(makeValidationState({ enforcement: 'advisory' }));
      expect(d.blocked).toBe(false);
      expect(d.required).toBe(false);
      expect(d.code).toBeNull();
    });

    it('required + non-empty active checks → not blocked (ordinary check eval governs)', () => {
      const d = evaluateValidationEvidence(
        makeValidationState({ enforcement: 'required', activeChecks: ['test'] }),
      );
      expect(d.blocked).toBe(false);
      expect(d.required).toBe(true);
      expect(d.code).toBeNull();
    });

    it('required + empty checks + trustworthy discovery → blocked with REQUIRED', () => {
      const d = evaluateValidationEvidence(
        makeValidationState({ enforcement: 'required', trustworthy: true }),
      );
      expect(d.blocked).toBe(true);
      expect(d.required).toBe(true);
      expect(d.code).toBe('VALIDATION_EVIDENCE_REQUIRED');
    });

    it('required + empty checks + untrustworthy discovery → blocked with UNVERIFIED', () => {
      const d = evaluateValidationEvidence(
        makeValidationState({ enforcement: 'required', trustworthy: false }),
      );
      expect(d.blocked).toBe(true);
      expect(d.required).toBe(true);
      expect(d.code).toBe('VALIDATION_EVIDENCE_UNVERIFIED');
    });
  });

  // ─── BAD ────────────────────────────────────────────────────
  describe('BAD — explicit exception and fail-closed posture', () => {
    it('required + allowNoCommands=true → never blocks even with trustworthy discovery', () => {
      const d = evaluateValidationEvidence(
        makeValidationState({ enforcement: 'required', allowNoCommands: true, trustworthy: true }),
      );
      expect(d.blocked).toBe(false);
      // required is false because the explicit exception is the sanctioned opt-out.
      expect(d.required).toBe(false);
      expect(d.code).toBeNull();
    });

    it('required + allowNoCommands=true → never blocks even when discovery untrustworthy', () => {
      const d = evaluateValidationEvidence(
        makeValidationState({ enforcement: 'required', allowNoCommands: true, trustworthy: false }),
      );
      expect(d.blocked).toBe(false);
      expect(d.code).toBeNull();
    });
  });

  // ─── CORNER — trust-edge falsification ──────────────────────
  describe('CORNER — hasTrustworthyDiscoveryForVerification edges', () => {
    it('fully trustworthy → true', () => {
      expect(
        hasTrustworthyDiscoveryForVerification(
          makeValidationState({ enforcement: 'required', trustworthy: true }),
        ),
      ).toBe(true);
    });

    it('missing discoverySummary → false', () => {
      const s = makeValidationState({
        enforcement: 'required',
        discoverySummary: null,
        discoveryDigest: 'digest-abc',
        discoveryHealthEnforcement: 'required',
        gate: { status: 'clear', lastDriftAssessment: 'clean' },
      });
      expect(hasTrustworthyDiscoveryForVerification(s)).toBe(false);
    });

    it('missing discoveryDigest → false', () => {
      const s = makeValidationState({
        enforcement: 'required',
        discoverySummary: SUMMARY,
        discoveryDigest: null,
        discoveryHealthEnforcement: 'required',
        gate: { status: 'clear', lastDriftAssessment: 'clean' },
      });
      expect(hasTrustworthyDiscoveryForVerification(s)).toBe(false);
    });

    it('discoveryHealth enforcement not required → false', () => {
      const s = makeValidationState({
        enforcement: 'required',
        discoverySummary: SUMMARY,
        discoveryDigest: 'digest-abc',
        discoveryHealthEnforcement: 'advisory',
        gate: { status: 'clear', lastDriftAssessment: 'clean' },
      });
      expect(hasTrustworthyDiscoveryForVerification(s)).toBe(false);
    });

    it('missing health gate → false', () => {
      const s = makeValidationState({
        enforcement: 'required',
        discoverySummary: SUMMARY,
        discoveryDigest: 'digest-abc',
        discoveryHealthEnforcement: 'required',
        gate: undefined,
      });
      expect(hasTrustworthyDiscoveryForVerification(s)).toBe(false);
    });

    it('blocked health gate → false', () => {
      const s = makeValidationState({
        enforcement: 'required',
        discoverySummary: SUMMARY,
        discoveryDigest: 'digest-abc',
        discoveryHealthEnforcement: 'required',
        gate: {
          status: 'blocked',
          code: 'DISCOVERY_HEALTH_UNAVAILABLE',
          message: 'unavailable',
          blockedAt: '2026-01-01T00:00:00.000Z',
        },
      });
      expect(hasTrustworthyDiscoveryForVerification(s)).toBe(false);
    });

    it('clear gate but drift not clean → false', () => {
      const s = makeValidationState({
        enforcement: 'required',
        discoverySummary: SUMMARY,
        discoveryDigest: 'digest-abc',
        discoveryHealthEnforcement: 'required',
        gate: { status: 'clear', lastDriftAssessment: 'drifted' },
      });
      expect(hasTrustworthyDiscoveryForVerification(s)).toBe(false);
    });

    it('clear gate with no lastDriftAssessment → false (cannot assert clean)', () => {
      const s = makeValidationState({
        enforcement: 'required',
        discoverySummary: SUMMARY,
        discoveryDigest: 'digest-abc',
        discoveryHealthEnforcement: 'required',
        gate: { status: 'clear' },
      });
      expect(hasTrustworthyDiscoveryForVerification(s)).toBe(false);
    });
  });

  // ─── EDGE ───────────────────────────────────────────────────
  describe('EDGE — active checks dominate regardless of trust', () => {
    it('required + non-empty checks + untrustworthy discovery → not blocked', () => {
      const d = evaluateValidationEvidence(
        makeValidationState({
          enforcement: 'required',
          activeChecks: ['test'],
          trustworthy: false,
        }),
      );
      expect(d.blocked).toBe(false);
      expect(d.code).toBeNull();
    });
  });
});
