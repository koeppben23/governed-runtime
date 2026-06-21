import { describe, it, expect } from 'vitest';
import { executeHydrate } from '../rails/hydrate.js';
import { createTestContext } from '../testing.js';
import { makeState, FIXED_SESSION_UUID, FIXED_FINGERPRINT } from '../__fixtures__.js';
import type { HydratePolicyResolution } from '../config/policy.js';
import { TEAM_POLICY } from '../config/policy.js';

const ctx = createTestContext();

/** Default hydrate input with all required fields. */
const HYDRATE_INPUT = {
  session: {
    sessionId: FIXED_SESSION_UUID,
    worktree: '/tmp/test',
    fingerprint: FIXED_FINGERPRINT,
  },
  policy: {},
  profile: {},
} as const;

describe('hydrate rail', () => {
  // ─── HAPPY ─────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('creates new session when existingState is null', () => {
      const result = executeHydrate(null, HYDRATE_INPUT, ctx);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.phase).toBe('READY');
        expect(result.state.binding.sessionId).toBe(FIXED_SESSION_UUID);
        expect(result.state.binding.worktree).toBe('/tmp/test');
        expect(result.state.schemaVersion).toBe('v1');
        expect(result.transitions.length).toBe(0);
        // Discovery fields initialize as null in new sessions
        expect(result.state.discoveryDigest).toBeNull();
        expect(result.state.discoverySummary).toBeNull();
      }
    });

    it('returns existing state unchanged (idempotent)', () => {
      const existing = makeState('PLAN');
      const result = executeHydrate(existing, HYDRATE_INPUT, ctx);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state).toBe(existing);
      }
    });

    it('accepts OpenCode-style non-UUID session IDs', () => {
      const result = executeHydrate(
        null,
        {
          ...HYDRATE_INPUT,
          session: { ...HYDRATE_INPUT.session, sessionId: 'ses_260740c65ffe77OjxRP7z40yH8' },
        },
        ctx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.binding.sessionId).toBe('ses_260740c65ffe77OjxRP7z40yH8');
      }
    });

    it('resolves policy mode', () => {
      const result = executeHydrate(
        null,
        {
          ...HYDRATE_INPUT,
          policy: { ...HYDRATE_INPUT.policy, policyMode: 'regulated' },
        },
        ctx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.policySnapshot.mode).toBe('regulated');
      }
    });

    it('sets initiatedBy from input', () => {
      const result = executeHydrate(
        null,
        {
          ...HYDRATE_INPUT,
          profile: { ...HYDRATE_INPUT.profile, initiatedBy: 'alice' },
        },
        ctx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.initiatedBy).toBe('alice');
      }
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe('BAD', () => {
    it('blocks on empty sessionId', () => {
      const result = executeHydrate(
        null,
        { ...HYDRATE_INPUT, session: { ...HYDRATE_INPUT.session, sessionId: '' } },
        ctx,
      );
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') {
        expect(result.code).toBe('MISSING_SESSION_ID');
      }
    });

    it('blocks on empty worktree', () => {
      const result = executeHydrate(
        null,
        { ...HYDRATE_INPUT, session: { ...HYDRATE_INPUT.session, worktree: '' } },
        ctx,
      );
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') {
        expect(result.code).toBe('MISSING_WORKTREE');
      }
    });

    it('blocks on whitespace-only sessionId', () => {
      const result = executeHydrate(
        null,
        { ...HYDRATE_INPUT, session: { ...HYDRATE_INPUT.session, sessionId: '   ' } },
        ctx,
      );
      expect(result.kind).toBe('blocked');
    });

    it('blocks on invalid fingerprint', () => {
      const result = executeHydrate(
        null,
        { ...HYDRATE_INPUT, session: { ...HYDRATE_INPUT.session, fingerprint: 'not-valid-hex!' } },
        ctx,
      );
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') {
        expect(result.code).toBe('INVALID_FINGERPRINT');
      }
    });

    it('blocks on empty fingerprint', () => {
      const result = executeHydrate(
        null,
        { ...HYDRATE_INPUT, session: { ...HYDRATE_INPUT.session, fingerprint: '' } },
        ctx,
      );
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') {
        expect(result.code).toBe('INVALID_FINGERPRINT');
      }
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe('CORNER', () => {
    it('defaults policyMode to solo', () => {
      const result = executeHydrate(null, HYDRATE_INPUT, ctx);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.policySnapshot.mode).toBe('solo');
      }
    });

    it('defaults initiatedBy to sessionId', () => {
      const result = executeHydrate(null, HYDRATE_INPUT, ctx);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.initiatedBy).toBe(FIXED_SESSION_UUID);
      }
    });

    it('resolves profile from repoSignals', () => {
      const result = executeHydrate(
        null,
        {
          ...HYDRATE_INPUT,
          profile: {
            ...HYDRATE_INPUT.profile,
            repoSignals: { files: [], packageFiles: ['pom.xml'], configFiles: [] },
          },
        },
        ctx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.activeProfile?.id).toBe('backend-java');
      }
    });
  });

  // ─── EDGE ──────────────────────────────────────────────────
  describe('EDGE', () => {
    it('explicit profileId takes precedence over repoSignals', () => {
      const result = executeHydrate(
        null,
        {
          ...HYDRATE_INPUT,
          profile: {
            ...HYDRATE_INPUT.profile,
            profileId: 'typescript',
            repoSignals: { files: [], packageFiles: ['pom.xml'], configFiles: [] },
          },
        },
        ctx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.activeProfile?.id).toBe('typescript');
      }
    });

    it('custom activeChecks override profile defaults', () => {
      const result = executeHydrate(
        null,
        { ...HYDRATE_INPUT, profile: { ...HYDRATE_INPUT.profile, activeChecks: ['custom_check'] } },
        ctx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.activeChecks).toEqual(['custom_check']);
      }
    });

    it('falls back to baseline profile when explicit profileId is unknown', () => {
      const result = executeHydrate(
        null,
        {
          ...HYDRATE_INPUT,
          profile: {
            ...HYDRATE_INPUT.profile,
            profileId: 'unknown-profile-id',
          },
        },
        ctx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.activeProfile?.id).toBe('baseline');
        // activeChecks is derived from verificationCandidates (empty in unit test)
        expect(result.state.activeChecks).toEqual([]);
      }
    });

    it('freezes snapshot from policyResolution when provided', () => {
      const policyResolution: HydratePolicyResolution = {
        requestedMode: 'team-ci',
        effectiveMode: 'team',
        effectiveGateBehavior: 'human_gated',
        degradedReason: 'ci_context_missing',
        effectiveSource: 'default',
        policy: TEAM_POLICY,
        resolutionReason: 'default_weaker_than_central',
        centralEvidence: {
          minimumMode: 'team',
          digest: 'abc123',
          pathHint: '/etc/flowguard/policy.json',
        },
      };

      const result = executeHydrate(
        null,
        {
          ...HYDRATE_INPUT,
          policy: {
            ...HYDRATE_INPUT.policy,
            policyMode: 'solo',
            policyResolution,
          },
        },
        ctx,
      );

      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.policySnapshot.mode).toBe('team');
        expect(result.state.policySnapshot.requestedMode).toBe('team-ci');
        expect(result.state.policySnapshot.degradedReason).toBe('ci_context_missing');
        expect(result.state.policySnapshot.source).toBe('default');
        expect(result.state.policySnapshot.centralMinimumMode).toBe('team');
      }
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe('PERF', () => {
    it('hydrate is fast (smoke test)', () => {
      const start = performance.now();
      executeHydrate(null, HYDRATE_INPUT, ctx);
      expect(performance.now() - start).toBeLessThan(50);
    });
  });
});
