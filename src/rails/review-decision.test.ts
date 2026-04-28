import { describe, expect, it } from 'vitest';
import { executeReviewDecision } from './review-decision.js';
import { makeState, ARCHITECTURE_DECISION, IMPL_EVIDENCE, PLAN_RECORD } from '../__fixtures__.js';

const baseCtx = {
  now: () => '2026-01-01T00:00:00.000Z',
  policy: {},
};

const initiatorIdentity = {
  actorId: 'initiator-1',
  actorEmail: 'init@example.com',
  actorDisplayName: 'Initiator',
  actorSource: 'claim' as const,
  actorAssurance: 'claim_validated' as const,
};

const reviewerIdentity = {
  actorId: 'reviewer-1',
  actorEmail: 'review@example.com',
  actorDisplayName: 'Reviewer',
  actorSource: 'claim' as const,
  actorAssurance: 'claim_validated' as const,
};

describe('review-decision rail', () => {
  it('reject at ARCH_REVIEW clears architecture and selfReview', () => {
    const state = makeState('ARCH_REVIEW', {
      architecture: ARCHITECTURE_DECISION,
      selfReview: {
        iteration: 1,
        maxIterations: 3,
        prevDigest: null,
        currDigest: ARCHITECTURE_DECISION.digest,
        revisionDelta: 'none',
        verdict: 'approve',
      },
    });

    const result = executeReviewDecision(
      state,
      {
        verdict: 'reject',
        rationale: 'start over',
        decidedBy: 'reviewer-1',
      },
      baseCtx,
    );

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.state.architecture).toBeNull();
      expect(result.state.selfReview).toBeNull();
    }
  });

  it('changes_requested at EVIDENCE_REVIEW clears implementation and implReview', () => {
    const state = makeState('EVIDENCE_REVIEW', {
      ticket: { text: 't', digest: 'd', source: 'user', createdAt: '2026-01-01T00:00:00.000Z' },
      plan: PLAN_RECORD,
      implementation: IMPL_EVIDENCE,
      implReview: {
        iteration: 1,
        maxIterations: 3,
        prevDigest: null,
        currDigest: IMPL_EVIDENCE.digest,
        revisionDelta: 'none',
        verdict: 'approve',
        executedAt: '2026-01-01T00:00:00.000Z',
      },
    });

    const result = executeReviewDecision(
      state,
      {
        verdict: 'changes_requested',
        rationale: 'rework implementation',
        decidedBy: 'reviewer-1',
      },
      baseCtx,
    );

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.state.implementation).toBeNull();
      expect(result.state.implReview).toBeNull();
    }
  });

  it('approve at ARCH_REVIEW marks architecture as accepted', () => {
    const state = makeState('ARCH_REVIEW', {
      architecture: ARCHITECTURE_DECISION,
      selfReview: {
        iteration: 1,
        maxIterations: 3,
        prevDigest: null,
        currDigest: ARCHITECTURE_DECISION.digest,
        revisionDelta: 'none',
        verdict: 'approve',
      },
    });

    const result = executeReviewDecision(
      state,
      {
        verdict: 'approve',
        rationale: 'accepted',
        decidedBy: 'reviewer-1',
      },
      baseCtx,
    );

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.state.architecture?.status).toBe('accepted');
    }
  });

  it('regulated approve requires structured identities', () => {
    const state = makeState('PLAN_REVIEW', {
      initiatedByIdentity: null,
    });

    const result = executeReviewDecision(
      state,
      {
        verdict: 'approve',
        rationale: 'ok',
        decidedBy: 'reviewer-1',
      },
      {
        ...baseCtx,
        policy: { allowSelfApproval: false },
      },
    );

    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.code).toBe('DECISION_IDENTITY_REQUIRED');
      expect(result.reason).toBeDefined();
      expect(result.reason).not.toBe('');
    }
  });

  it('regulated approve blocks unknown reviewer actor source', () => {
    const state = makeState('PLAN_REVIEW', {
      initiatedByIdentity: initiatorIdentity,
    });

    const result = executeReviewDecision(
      state,
      {
        verdict: 'approve',
        rationale: 'ok',
        decidedBy: 'reviewer-1',
        decisionIdentity: {
          ...reviewerIdentity,
          actorSource: 'unknown',
        },
      },
      {
        ...baseCtx,
        policy: { allowSelfApproval: false },
      },
    );

    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.code).toBe('REGULATED_ACTOR_UNKNOWN');
      expect(result.reason).toBeDefined();
      expect(result.reason).not.toBe('');
    }
  });

  it('requireVerifiedActorsForApproval blocks best_effort reviewer', () => {
    const state = makeState('PLAN_REVIEW', {
      initiatedByIdentity: initiatorIdentity,
    });

    const result = executeReviewDecision(
      state,
      {
        verdict: 'approve',
        rationale: 'ok',
        decidedBy: 'reviewer-1',
        decisionIdentity: {
          ...reviewerIdentity,
          actorAssurance: 'best_effort',
        },
      },
      {
        ...baseCtx,
        policy: { requireVerifiedActorsForApproval: true },
      },
    );

    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.code).toBe('ACTOR_ASSURANCE_INSUFFICIENT');
      expect(result.reason).toBeDefined();
    }
  });

  it('minimum idp_verified blocks claim_validated reviewer', () => {
    const state = makeState('PLAN_REVIEW', {
      initiatedByIdentity: initiatorIdentity,
    });

    const result = executeReviewDecision(
      state,
      {
        verdict: 'approve',
        rationale: 'ok',
        decidedBy: 'reviewer-1',
        decisionIdentity: {
          ...reviewerIdentity,
          actorAssurance: 'claim_validated',
        },
      },
      {
        ...baseCtx,
        policy: { minimumActorAssuranceForApproval: 'idp_verified' },
      },
    );

    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.code).toBe('ACTOR_ASSURANCE_INSUFFICIENT');
      expect(result.reason).toBeDefined();
    }
  });
});
