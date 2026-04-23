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

const ctx = createTestContext();

/** Default hydrate input with all required fields. */
const HYDRATE_INPUT = {
  sessionId: FIXED_SESSION_UUID,
  worktree: '/tmp/test',
  fingerprint: FIXED_FINGERPRINT,
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
          sessionId: 'ses_260740c65ffe77OjxRP7z40yH8',
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
          policyMode: 'regulated',
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
          initiatedBy: 'alice',
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
      const result = executeHydrate(null, { ...HYDRATE_INPUT, sessionId: '' }, ctx);
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') {
        expect(result.code).toBe('MISSING_SESSION_ID');
      }
    });

    it('blocks on empty worktree', () => {
      const result = executeHydrate(null, { ...HYDRATE_INPUT, worktree: '' }, ctx);
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') {
        expect(result.code).toBe('MISSING_WORKTREE');
      }
    });

    it('blocks on whitespace-only sessionId', () => {
      const result = executeHydrate(null, { ...HYDRATE_INPUT, sessionId: '   ' }, ctx);
      expect(result.kind).toBe('blocked');
    });

    it('blocks on invalid fingerprint', () => {
      const result = executeHydrate(null, { ...HYDRATE_INPUT, fingerprint: 'not-valid-hex!' }, ctx);
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') {
        expect(result.code).toBe('INVALID_FINGERPRINT');
      }
    });

    it('blocks on empty fingerprint', () => {
      const result = executeHydrate(null, { ...HYDRATE_INPUT, fingerprint: '' }, ctx);
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
          repoSignals: { files: [], packageFiles: ['pom.xml'], configFiles: [] },
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
          profileId: 'typescript',
          repoSignals: { files: [], packageFiles: ['pom.xml'], configFiles: [] },
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
        {
          ...HYDRATE_INPUT,
          activeChecks: ['custom_check'],
        },
        ctx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.activeChecks).toEqual(['custom_check']);
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
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe('PERF', () => {
    it('ticket execution is fast (smoke test)', () => {
      const start = performance.now();
      executeTicket(makeState('TICKET'), { text: 'task', source: 'user' }, ctx);
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
      if (result.kind === 'blocked') expect(result.code).toBe('COMMAND_NOT_ALLOWED');
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
      if (result.kind === 'blocked') expect(result.code).toBe('INVALID_VERDICT');
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
      if (result.kind === 'blocked') expect(result.code).toBe('VERIFIED_ACTOR_REQUIRED');
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
      if (result.kind === 'blocked') expect(result.code).toBe('VERIFIED_ACTOR_REQUIRED');
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
