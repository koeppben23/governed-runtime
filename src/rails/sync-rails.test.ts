import { describe, it, expect } from 'vitest';
import { executeHydrate } from '../rails/hydrate.js';
import { executeTicket } from '../rails/ticket.js';
import { executeReviewDecision } from '../rails/review-decision.js';
import { executeAbort } from '../rails/abort.js';
import { createTestContext } from '../testing.js';
import {
  makeState,
  makeProgressedState,
  TICKET,
  PLAN_RECORD,
  SELF_REVIEW_CONVERGED,
  VALIDATION_PASSED,
  IMPL_EVIDENCE,
  IMPL_REVIEW_CONVERGED,
  REVIEW_APPROVE,
  ARCHITECTURE_DECISION,
  FIXED_SESSION_UUID,
  FIXED_FINGERPRINT,
  REGULATED_POLICY_SNAPSHOT,
  DECISION_IDENTITY_INITIATOR,
  DECISION_IDENTITY_REVIEWER,
  DECISION_IDENTITY_VERIFIED_REVIEWER,
} from '../__fixtures__.js';
import { REGULATED_POLICY, TEAM_POLICY } from '../config/policy.js';
import type { HydratePolicyResolution } from '../config/policy.js';

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
        expect(result.state.activeChecks.length).toBeGreaterThan(0);
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

describe('ticket rail', () => {
  // ─── HAPPY ─────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('records ticket evidence in TICKET phase', () => {
      const state = makeState('TICKET');
      const result = executeTicket(state, { text: 'Fix auth bug', source: 'user' }, ctx);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.ticket).not.toBeNull();
        expect(result.state.ticket!.text).toBe('Fix auth bug');
        expect(result.state.ticket!.source).toBe('user');
        expect(result.state.ticket!.digest).toBeDefined();
      }
    });

    it('clears downstream evidence on re-ticketing', () => {
      const state = makeState('TICKET', { plan: PLAN_RECORD, selfReview: SELF_REVIEW_CONVERGED });
      const result = executeTicket(state, { text: 'New task', source: 'user' }, ctx);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.plan).toBeNull();
        expect(result.state.selfReview).toBeNull();
      }
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe('BAD', () => {
    it('blocks on empty text', () => {
      const result = executeTicket(makeState('TICKET'), { text: '', source: 'user' }, ctx);
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') expect(result.code).toBe('EMPTY_TICKET');
    });

    it('blocks on whitespace-only text', () => {
      const result = executeTicket(makeState('TICKET'), { text: '   ', source: 'user' }, ctx);
      expect(result.kind).toBe('blocked');
    });

    it('blocks in wrong phase', () => {
      const result = executeTicket(makeState('PLAN'), { text: 'task', source: 'user' }, ctx);
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') expect(result.code).toBe('COMMAND_NOT_ALLOWED');
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe('CORNER', () => {
    it('blocks at COMPLETE', () => {
      const result = executeTicket(
        makeProgressedState('COMPLETE'),
        { text: 'task', source: 'user' },
        ctx,
      );
      expect(result.kind).toBe('blocked');
    });
  });

  // ─── EDGE ──────────────────────────────────────────────────
  describe('EDGE', () => {
    it('source can be external', () => {
      const result = executeTicket(makeState('TICKET'), { text: 'task', source: 'external' }, ctx);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') expect(result.state.ticket!.source).toBe('external');
    });

    it('stores inputOrigin when provided', () => {
      const result = executeTicket(
        makeState('TICKET'),
        { text: 'Fix login redirect', source: 'external', inputOrigin: 'external_reference' },
        ctx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.ticket!.inputOrigin).toBe('external_reference');
      }
    });

    it('stores references array with Jira URL', () => {
      const ref = {
        ref: 'https://jira.example.com/browse/PROJ-123',
        type: 'ticket' as const,
        title: 'PROJ-123: Fix login redirect',
        source: 'jira',
        extractedAt: '2026-01-15T10:00:00.000Z',
      };
      const result = executeTicket(
        makeState('TICKET'),
        {
          text: 'Fix login redirect after token expiry',
          source: 'external',
          inputOrigin: 'external_reference',
          references: [ref],
        },
        ctx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.ticket!.references).toHaveLength(1);
        expect(result.state.ticket!.references![0]!.ref).toBe(ref.ref);
        expect(result.state.ticket!.references![0]!.type).toBe('ticket');
        expect(result.state.ticket!.references![0]!.title).toBe(ref.title);
        expect(result.state.ticket!.references![0]!.source).toBe('jira');
        expect(result.state.ticket!.references![0]!.extractedAt).toBe(ref.extractedAt);
      }
    });

    it('stores multiple references (Jira + Confluence + GitHub)', () => {
      const refs = [
        {
          ref: 'https://jira.example.com/PROJ-42',
          type: 'ticket' as const,
          source: 'jira',
          title: 'PROJ-42',
        },
        {
          ref: 'https://confluence.example.com/SPEC-1',
          type: 'doc' as const,
          source: 'confluence',
          title: 'Spec v2',
        },
        {
          ref: 'https://github.com/org/repo/issues/7',
          type: 'issue' as const,
          source: 'github',
          title: 'Issue #7',
        },
      ];
      const result = executeTicket(
        makeState('TICKET'),
        { text: 'Implement feature X', source: 'external', inputOrigin: 'mixed', references: refs },
        ctx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.ticket!.references).toHaveLength(3);
        expect(result.state.ticket!.inputOrigin).toBe('mixed');
      }
    });

    it('sets inputOrigin to manual_text for manually typed tickets', () => {
      const result = executeTicket(
        makeState('TICKET'),
        { text: 'Just a text description', source: 'user', inputOrigin: 'manual_text' },
        ctx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.ticket!.inputOrigin).toBe('manual_text');
        expect(result.state.ticket!.references).toBeUndefined();
      }
    });

    it('normalizes away empty references array', () => {
      const result = executeTicket(
        makeState('TICKET'),
        { text: 'Task', source: 'user', references: [] },
        ctx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.ticket!.references).toBeUndefined();
      }
    });

    it('digest only covers text, not references or inputOrigin', () => {
      const text = 'Fix the auth bug';
      const result1 = executeTicket(makeState('TICKET'), { text, source: 'user' }, ctx);
      const result2 = executeTicket(
        makeState('TICKET'),
        {
          text,
          source: 'external',
          inputOrigin: 'external_reference',
          references: [
            { ref: 'https://jira.example.com/PROJ-123', type: 'ticket' as const, source: 'jira' },
          ],
        },
        ctx,
      );
      expect(result1.kind).toBe('ok');
      expect(result2.kind).toBe('ok');
      if (result1.kind === 'ok' && result2.kind === 'ok') {
        expect(result1.state.ticket!.digest).toBe(result2.state.ticket!.digest);
      }
    });

    it('reference without type defaults to undefined (not other)', () => {
      const result = executeTicket(
        makeState('TICKET'),
        {
          text: 'Task',
          source: 'external',
          references: [{ ref: 'https://example.com/ticket/1' }],
        },
        ctx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.ticket!.references![0]!.type).toBeUndefined();
      }
    });

    it('reference without extractedAt is stored as-is (content not fetched)', () => {
      const result = executeTicket(
        makeState('TICKET'),
        {
          text: 'Content could not be extracted from: https://jira.example.com/PROJ-999',
          source: 'external',
          inputOrigin: 'external_reference',
          references: [
            { ref: 'https://jira.example.com/PROJ-999', type: 'ticket' as const, source: 'jira' },
          ],
        },
        ctx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.ticket!.references![0]!.extractedAt).toBeUndefined();
      }
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe('PERF', () => {
    it('ticket execution is fast (smoke test)', () => {
      const start = performance.now();
      executeTicket(makeState('TICKET'), { text: 'task', source: 'user' }, ctx);
      expect(performance.now() - start).toBeLessThan(50);
    });

    it('ticket with references is fast (smoke test)', () => {
      const start = performance.now();
      executeTicket(
        makeState('TICKET'),
        {
          text: 'task',
          source: 'external',
          inputOrigin: 'external_reference',
          references: [
            { ref: 'https://jira.example.com/PROJ-1', type: 'ticket' as const },
            { ref: 'https://github.com/org/repo/issues/2', type: 'issue' as const },
            { ref: 'https://confluence.example.com/pages/3', type: 'doc' as const },
          ],
        },
        ctx,
      );
      expect(performance.now() - start).toBeLessThan(50);
    });
  });
});

describe('review-decision rail', () => {
  // ─── HAPPY ─────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('approve at PLAN_REVIEW → VALIDATION', () => {
      const state = makeProgressedState('PLAN_REVIEW');
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve',
          rationale: 'LGTM',
          decidedBy: 'reviewer-1',
        },
        ctx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.phase).toBe('VALIDATION');
        expect(result.state.reviewDecision?.verdict).toBe('approve');
      }
    });

    it('approve at EVIDENCE_REVIEW → COMPLETE', () => {
      const state = makeProgressedState('EVIDENCE_REVIEW');
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve',
          rationale: 'Ship it',
          decidedBy: 'reviewer-1',
        },
        ctx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.phase).toBe('COMPLETE');
      }
    });

    it('changes_requested at PLAN_REVIEW → PLAN', () => {
      const state = makeProgressedState('PLAN_REVIEW');
      const result = executeReviewDecision(
        state,
        {
          verdict: 'changes_requested',
          rationale: 'Needs more detail',
          decidedBy: 'reviewer-1',
        },
        ctx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.phase).toBe('PLAN');
        expect(result.state.selfReview).toBeNull(); // cleared for fresh loop
      }
    });

    it('reject at PLAN_REVIEW → TICKET', () => {
      const state = makeProgressedState('PLAN_REVIEW');
      const result = executeReviewDecision(
        state,
        {
          verdict: 'reject',
          rationale: 'Wrong approach',
          decidedBy: 'reviewer-1',
        },
        ctx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.phase).toBe('TICKET');
        expect(result.state.plan).toBeNull();
        expect(result.state.selfReview).toBeNull();
      }
    });

    it('changes_requested at EVIDENCE_REVIEW → IMPLEMENTATION', () => {
      const state = makeProgressedState('EVIDENCE_REVIEW');
      const result = executeReviewDecision(
        state,
        {
          verdict: 'changes_requested',
          rationale: 'Missing edge case',
          decidedBy: 'reviewer-1',
        },
        ctx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.phase).toBe('IMPLEMENTATION');
        expect(result.state.implementation).toBeNull();
        expect(result.state.implReview).toBeNull();
      }
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe('BAD', () => {
    it('blocks in wrong phase', () => {
      const result = executeReviewDecision(
        makeState('TICKET'),
        {
          verdict: 'approve',
          rationale: 'ok',
          decidedBy: 'r',
        },
        ctx,
      );
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') {
        expect(result.code).toBe('COMMAND_NOT_ALLOWED');
        expect(result.reason).toBeDefined();
      }
    });

    it('blocks on invalid verdict', () => {
      const state = makeProgressedState('PLAN_REVIEW');
      const result = executeReviewDecision(
        state,
        {
          verdict: 'maybe' as any,
          rationale: 'ok',
          decidedBy: 'r',
        },
        ctx,
      );
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') {
        expect(result.code).toBe('INVALID_VERDICT');
        expect(result.reason).toBeDefined();
      }
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe('CORNER', () => {
    it('four-eyes blocks when decidedBy === initiatedBy in regulated mode (P30)', () => {
      const state = {
        ...makeProgressedState('PLAN_REVIEW'),
        policySnapshot: { ...REGULATED_POLICY_SNAPSHOT },
      };
      const regulatedCtx = { ...ctx, policy: REGULATED_POLICY };
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve',
          rationale: 'LGTM',
          decidedBy: state.initiatedByIdentity!.actorId,
          decisionIdentity: state.initiatedByIdentity,
        },
        regulatedCtx,
      );
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') expect(result.code).toBe('FOUR_EYES_ACTOR_MATCH');
    });

    it('four-eyes allows when decidedBy !== initiatedBy in regulated mode (P30)', () => {
      const state = {
        ...makeProgressedState('PLAN_REVIEW'),
        policySnapshot: { ...REGULATED_POLICY_SNAPSHOT },
      };
      const regulatedCtx = { ...ctx, policy: REGULATED_POLICY };
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve',
          rationale: 'LGTM',
          decidedBy: DECISION_IDENTITY_REVIEWER.actorId,
          decisionIdentity: DECISION_IDENTITY_REVIEWER,
        },
        regulatedCtx,
      );
      expect(result.kind).toBe('ok');
    });

    it('P30: legacy regulated state without initiatedByIdentity blocks approve', () => {
      const state = {
        ...makeProgressedState('PLAN_REVIEW'),
        initiatedByIdentity: undefined,
        policySnapshot: { ...REGULATED_POLICY_SNAPSHOT },
      };
      const regulatedCtx = { ...ctx, policy: REGULATED_POLICY };
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve',
          rationale: 'LGTM',
          decidedBy: DECISION_IDENTITY_REVIEWER.actorId,
          decisionIdentity: DECISION_IDENTITY_REVIEWER,
        },
        regulatedCtx,
      );
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') expect(result.code).toBe('DECISION_IDENTITY_REQUIRED');
    });

    // P33: Verified Actor Requirement
    it('P33: blocks approve when requireVerifiedActorsForApproval=true but best_effort actor', () => {
      const state = {
        ...makeProgressedState('PLAN_REVIEW'),
        policySnapshot: { ...REGULATED_POLICY_SNAPSHOT, requireVerifiedActorsForApproval: true },
      };
      const regulatedCtx = {
        ...ctx,
        policy: { ...REGULATED_POLICY, requireVerifiedActorsForApproval: true },
      };
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve',
          rationale: 'LGTM',
          decidedBy: DECISION_IDENTITY_REVIEWER.actorId,
          decisionIdentity: DECISION_IDENTITY_REVIEWER, // best_effort
        },
        regulatedCtx,
      );
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') expect(result.code).toBe('ACTOR_ASSURANCE_INSUFFICIENT');
    });

    it('P33: allows approve when requireVerifiedActorsForApproval=true and verified actor', () => {
      const state = {
        ...makeProgressedState('PLAN_REVIEW'),
        policySnapshot: { ...REGULATED_POLICY_SNAPSHOT, requireVerifiedActorsForApproval: true },
      };
      const regulatedCtx = {
        ...ctx,
        policy: { ...REGULATED_POLICY, requireVerifiedActorsForApproval: true },
      };
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve',
          rationale: 'LGTM',
          decidedBy: DECISION_IDENTITY_VERIFIED_REVIEWER.actorId,
          decisionIdentity: DECISION_IDENTITY_VERIFIED_REVIEWER, // verified
        },
        regulatedCtx,
      );
      expect(result.kind).toBe('ok');
    });

    it('P33: different reviewer + verified passes both four-eyes and verified actor check', () => {
      const state = {
        ...makeProgressedState('PLAN_REVIEW'),
        policySnapshot: { ...REGULATED_POLICY_SNAPSHOT, requireVerifiedActorsForApproval: true },
      };
      const regulatedCtx = {
        ...ctx,
        policy: { ...REGULATED_POLICY, requireVerifiedActorsForApproval: true },
      };
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve',
          rationale: 'LGTM',
          decidedBy: DECISION_IDENTITY_VERIFIED_REVIEWER.actorId,
          decisionIdentity: DECISION_IDENTITY_VERIFIED_REVIEWER,
        },
        regulatedCtx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.phase).toBe('VALIDATION');
      }
    });

    it('P33: same actor + verified blocks FOUR_EYES_ACTOR_MATCH', () => {
      const state = {
        ...makeProgressedState('PLAN_REVIEW'),
        policySnapshot: { ...REGULATED_POLICY_SNAPSHOT, requireVerifiedActorsForApproval: true },
        initiatedByIdentity: DECISION_IDENTITY_VERIFIED_REVIEWER,
      };
      const regulatedCtx = {
        ...ctx,
        policy: { ...REGULATED_POLICY, requireVerifiedActorsForApproval: true },
      };
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve',
          rationale: 'LGTM',
          decidedBy: DECISION_IDENTITY_VERIFIED_REVIEWER.actorId,
          decisionIdentity: DECISION_IDENTITY_VERIFIED_REVIEWER,
        },
        regulatedCtx,
      );
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') expect(result.code).toBe('FOUR_EYES_ACTOR_MATCH');
    });

    it('P33: allow approve when requireVerifiedActorsForApproval=false (P30 behavior)', () => {
      const state = {
        ...makeProgressedState('PLAN_REVIEW'),
        policySnapshot: { ...REGULATED_POLICY_SNAPSHOT, requireVerifiedActorsForApproval: false },
      };
      const regulatedCtx = {
        ...ctx,
        policy: { ...REGULATED_POLICY, requireVerifiedActorsForApproval: false },
      };
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve',
          rationale: 'LGTM',
          decidedBy: DECISION_IDENTITY_REVIEWER.actorId,
          decisionIdentity: DECISION_IDENTITY_REVIEWER, // best_effort
        },
        regulatedCtx,
      );
      expect(result.kind).toBe('ok');
    });

    it('P33: verified actor requirement applies even when self-approval is allowed', () => {
      const state = {
        ...makeProgressedState('PLAN_REVIEW'),
        policySnapshot: {
          ...REGULATED_POLICY_SNAPSHOT,
          allowSelfApproval: true,
          requireVerifiedActorsForApproval: true,
        },
      };
      const regulatedCtx = {
        ...ctx,
        policy: {
          ...REGULATED_POLICY,
          allowSelfApproval: true,
          requireVerifiedActorsForApproval: true,
        },
      };
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve',
          rationale: 'LGTM',
          decidedBy: DECISION_IDENTITY_REVIEWER.actorId,
          decisionIdentity: DECISION_IDENTITY_REVIEWER,
        },
        regulatedCtx,
      );
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') expect(result.code).toBe('ACTOR_ASSURANCE_INSUFFICIENT');
    });

    it('P30: regulate approve without input.decisionIdentity blocks', () => {
      const state = {
        ...makeProgressedState('PLAN_REVIEW'),
        policySnapshot: { ...REGULATED_POLICY_SNAPSHOT },
      };
      const regulatedCtx = { ...ctx, policy: REGULATED_POLICY };
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve',
          rationale: 'LGTM',
          decidedBy: DECISION_IDENTITY_REVIEWER.actorId,
        },
        regulatedCtx,
      );
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') expect(result.code).toBe('DECISION_IDENTITY_REQUIRED');
    });

    it('P30: reviewDecision persists decisionIdentity', () => {
      const state = makeProgressedState('PLAN_REVIEW');
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve',
          rationale: 'OK',
          decidedBy: DECISION_IDENTITY_REVIEWER.actorId,
          decisionIdentity: DECISION_IDENTITY_REVIEWER,
        },
        ctx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.reviewDecision?.decisionIdentity).toEqual(DECISION_IDENTITY_REVIEWER);
        expect(result.state.reviewDecision?.decidedBy).toBe(DECISION_IDENTITY_REVIEWER.actorId);
      }
    });

    it('rejects at EVIDENCE_REVIEW clears everything back to TICKET', () => {
      const state = makeProgressedState('EVIDENCE_REVIEW');
      const result = executeReviewDecision(
        state,
        {
          verdict: 'reject',
          rationale: 'Start over',
          decidedBy: 'r',
        },
        ctx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.phase).toBe('TICKET');
        expect(result.state.plan).toBeNull();
        expect(result.state.implementation).toBeNull();
      }
    });
  });

  // ─── EDGE ──────────────────────────────────────────────────
  describe('EDGE', () => {
    it('team policy allows self-approval', () => {
      const state = makeProgressedState('PLAN_REVIEW');
      const teamCtx = { ...ctx, policy: TEAM_POLICY };
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve',
          rationale: 'ok',
          decidedBy: state.initiatedBy,
        },
        teamCtx,
      );
      expect(result.kind).toBe('ok');
    });

    it('records transition in result', () => {
      const state = makeProgressedState('PLAN_REVIEW');
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve',
          rationale: 'ok',
          decidedBy: 'r',
        },
        ctx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.transitions.length).toBe(1);
        expect(result.transitions[0]!.from).toBe('PLAN_REVIEW');
        expect(result.transitions[0]!.to).toBe('VALIDATION');
      }
    });

    it('approve at ARCH_REVIEW → ARCH_COMPLETE', () => {
      const state = makeProgressedState('ARCH_REVIEW');
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve',
          rationale: 'ADR looks good',
          decidedBy: 'reviewer-1',
        },
        ctx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.phase).toBe('ARCH_COMPLETE');
        expect(result.state.reviewDecision?.verdict).toBe('approve');
        expect(result.state.architecture).not.toBeNull();
        expect(result.state.selfReview).not.toBeNull();
      }
    });

    it('changes_requested at ARCH_REVIEW → ARCHITECTURE with cleared selfReview', () => {
      const state = makeProgressedState('ARCH_REVIEW');
      const result = executeReviewDecision(
        state,
        {
          verdict: 'changes_requested',
          rationale: 'Missing consequences detail',
          decidedBy: 'reviewer-1',
        },
        ctx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.phase).toBe('ARCHITECTURE');
        expect(result.state.selfReview).toBeNull();
        expect(result.state.architecture).not.toBeNull(); // kept
      }
    });

    it('reject at ARCH_REVIEW → READY with cleared architecture', () => {
      const state = makeProgressedState('ARCH_REVIEW');
      const result = executeReviewDecision(
        state,
        {
          verdict: 'reject',
          rationale: 'Wrong approach entirely',
          decidedBy: 'reviewer-1',
        },
        ctx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.phase).toBe('READY');
        expect(result.state.architecture).toBeNull();
        expect(result.state.selfReview).toBeNull();
      }
    });

    it('four-eyes blocks at ARCH_REVIEW when same actor (P30)', () => {
      const state = {
        ...makeProgressedState('ARCH_REVIEW'),
        policySnapshot: { ...REGULATED_POLICY_SNAPSHOT },
      };
      const regulatedCtx = { ...ctx, policy: REGULATED_POLICY };
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve',
          rationale: 'LGTM',
          decidedBy: state.initiatedByIdentity!.actorId,
          decisionIdentity: state.initiatedByIdentity,
        },
        regulatedCtx,
      );
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') expect(result.code).toBe('FOUR_EYES_ACTOR_MATCH');
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe('PERF', () => {
    it('review-decision execution is fast (smoke test)', () => {
      const start = performance.now();
      executeReviewDecision(
        makeProgressedState('PLAN_REVIEW'),
        {
          verdict: 'approve',
          rationale: 'ok',
          decidedBy: 'r',
        },
        ctx,
      );
      expect(performance.now() - start).toBeLessThan(50);
    });
  });
});

describe('abort rail', () => {
  // ─── HAPPY ─────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('aborts from any phase to COMPLETE with ABORTED error', () => {
      const phases = [
        'TICKET',
        'PLAN',
        'PLAN_REVIEW',
        'VALIDATION',
        'IMPLEMENTATION',
        'IMPL_REVIEW',
        'EVIDENCE_REVIEW',
      ] as const;
      for (const phase of phases) {
        const state = makeState(phase);
        const result = executeAbort(state, { reason: 'cancelled', actor: 'user' }, ctx);
        expect(result.kind).toBe('ok');
        if (result.kind === 'ok') {
          expect(result.state.phase).toBe('COMPLETE');
          expect(result.state.error?.code).toBe('ABORTED');
        }
      }
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe('BAD', () => {
    // Abort doesn't really have "bad" input — it always works
    it('uses default message when reason is empty', () => {
      const result = executeAbort(makeState('TICKET'), { reason: '', actor: 'user' }, ctx);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.error?.message).toBe('Session aborted');
      }
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe('CORNER', () => {
    it('idempotent at COMPLETE — returns terminal with no transitions', () => {
      const state = makeProgressedState('COMPLETE');
      const result = executeAbort(state, { reason: 'again', actor: 'user' }, ctx);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.phase).toBe('COMPLETE');
        expect(result.transitions.length).toBe(0);
        expect(result.evalResult.kind).toBe('terminal');
      }
    });
  });

  // ─── EDGE ──────────────────────────────────────────────────
  describe('EDGE', () => {
    it('records ABORT transition bypassing topology', () => {
      const result = executeAbort(makeState('PLAN'), { reason: 'stop', actor: 'ci' }, ctx);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.transitions.length).toBe(1);
        expect(result.transitions[0]!.event).toBe('ABORT');
        expect(result.transitions[0]!.from).toBe('PLAN');
        expect(result.transitions[0]!.to).toBe('COMPLETE');
      }
    });

    it('preserves existing evidence after abort', () => {
      const state = makeState('IMPLEMENTATION', { ticket: TICKET, plan: PLAN_RECORD });
      const result = executeAbort(state, { reason: 'stop', actor: 'user' }, ctx);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.ticket).not.toBeNull();
        expect(result.state.plan).not.toBeNull();
      }
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe('PERF', () => {
    it('abort execution is fast (smoke test)', () => {
      const start = performance.now();
      executeAbort(makeState('PLAN'), { reason: 'stop', actor: 'user' }, ctx);
      expect(performance.now() - start).toBeLessThan(50);
    });
  });
});

// ─── MUTATION KILL: blocked detail interpolation ─────────────────────────────

describe('MUTATION: ticket blocked reason detail', () => {
  const mCtx = createTestContext();

  it('ticket COMMAND_NOT_ALLOWED reason contains /ticket and phase', () => {
    const result = executeTicket(makeState('PLAN'), { text: 'task', source: 'user' }, mCtx);
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.code).toBe('COMMAND_NOT_ALLOWED');
      expect(result.reason).toContain('/ticket');
      expect(result.reason).toContain('PLAN');
    }
  });

  it('ticket COMMAND_NOT_ALLOWED at COMPLETE includes phase', () => {
    const result = executeTicket(
      makeProgressedState('COMPLETE'),
      { text: 'task', source: 'user' },
      mCtx,
    );
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.reason).toContain('/ticket');
      expect(result.reason).toContain('COMPLETE');
    }
  });
});

describe('MUTATION: review-decision blocked reason detail', () => {
  const mCtx = createTestContext();

  it('review-decision COMMAND_NOT_ALLOWED contains /review-decision and phase', () => {
    const result = executeReviewDecision(
      makeState('TICKET'),
      { verdict: 'approve', rationale: 'ok', decidedBy: 'r' },
      mCtx,
    );
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.reason).toContain('/review-decision');
      expect(result.reason).toContain('TICKET');
    }
  });
});

// ─── MUTATION KILL: ticket conditional spreads and phase transition ───────────

describe('MUTATION_KILL ticket', () => {
  it('inputOrigin NOT present when not provided (conditional spread)', () => {
    const state = makeState('TICKET');
    const result = executeTicket(state, { text: 'Fix auth', source: 'user' }, ctx);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      // Must NOT have inputOrigin key at all (not undefined value)
      expect('inputOrigin' in result.state.ticket!).toBe(false);
    }
  });

  it('references NOT present when not provided (conditional spread)', () => {
    const state = makeState('TICKET');
    const result = executeTicket(state, { text: 'Fix auth', source: 'user' }, ctx);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect('references' in result.state.ticket!).toBe(false);
    }
  });

  it('references NOT present when empty array provided (empty guard)', () => {
    const state = makeState('TICKET');
    const result = executeTicket(state, { text: 'Fix auth', source: 'user', references: [] }, ctx);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect('references' in result.state.ticket!).toBe(false);
    }
  });

  it('from READY phase: transitions to TICKET with TICKET_SELECTED', () => {
    const state = makeState('READY');
    const result = executeTicket(state, { text: 'Fix auth', source: 'user' }, ctx);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.state.phase).toBe('TICKET');
      expect(result.transitions.length).toBeGreaterThan(0);
      expect(result.transitions[0]!.event).toBe('TICKET_SELECTED');
      expect(result.transitions[0]!.from).toBe('READY');
      expect(result.transitions[0]!.to).toBe('TICKET');
    }
  });

  it('from TICKET phase: no TICKET_SELECTED transition (already in phase)', () => {
    const state = makeState('TICKET');
    const result = executeTicket(state, { text: 'Fix auth', source: 'user' }, ctx);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      // No pre-transition from READY → TICKET
      const ticketSelectedTransitions = result.transitions.filter(
        (t) => t.event === 'TICKET_SELECTED',
      );
      expect(ticketSelectedTransitions).toHaveLength(0);
    }
  });
});
