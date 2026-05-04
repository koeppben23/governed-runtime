import { describe, expect, it } from 'vitest';
import { executeReviewDecision } from './review-decision.js';
import {
  makeState,
  ARCHITECTURE_DECISION,
  IMPL_EVIDENCE,
  PLAN_RECORD,
  FIXED_TIME,
} from '../__fixtures__.js';

const baseCtx = {
  now: () => FIXED_TIME,
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

/** Minimal converged self-review for tests requiring a completed review loop. */
const CONVERGED_SELF_REVIEW = {
  iteration: 1,
  maxIterations: 3,
  verdict: 'converged' as const,
  decidedAt: FIXED_TIME,
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
      ticket: { text: 't', digest: 'd', source: 'user', createdAt: FIXED_TIME },
      plan: PLAN_RECORD,
      implementation: IMPL_EVIDENCE,
      implReview: {
        iteration: 1,
        maxIterations: 3,
        prevDigest: null,
        currDigest: IMPL_EVIDENCE.digest,
        revisionDelta: 'none',
        verdict: 'approve',
        executedAt: FIXED_TIME,
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

  // ─── MUTATION KILL: blocked detail interpolation ───────────
  it('COMMAND_NOT_ALLOWED reason includes command and phase', () => {
    const state = makeState('TICKET');
    const result = executeReviewDecision(
      state,
      { verdict: 'approve', rationale: 'ok', decidedBy: 'r1' },
      baseCtx,
    );
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.code).toBe('COMMAND_NOT_ALLOWED');
      expect(result.reason).toContain('/review-decision');
      expect(result.reason).toContain('TICKET');
    }
  });

  it('REGULATED_ACTOR_UNKNOWN reason includes role for initiator', () => {
    const state = makeState('PLAN_REVIEW', {
      initiatedByIdentity: { ...initiatorIdentity, actorSource: 'unknown' as const },
    });
    const result = executeReviewDecision(
      state,
      {
        verdict: 'approve',
        rationale: 'ok',
        decidedBy: 'reviewer-1',
        decisionIdentity: reviewerIdentity,
      },
      { ...baseCtx, policy: { allowSelfApproval: false } },
    );
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.code).toBe('REGULATED_ACTOR_UNKNOWN');
      expect(result.reason).toContain('initiator');
    }
  });

  it('REGULATED_ACTOR_UNKNOWN reason includes role for reviewer', () => {
    const state = makeState('PLAN_REVIEW', {
      initiatedByIdentity: initiatorIdentity,
    });
    const result = executeReviewDecision(
      state,
      {
        verdict: 'approve',
        rationale: 'ok',
        decidedBy: 'reviewer-1',
        decisionIdentity: { ...reviewerIdentity, actorSource: 'unknown' as const },
      },
      { ...baseCtx, policy: { allowSelfApproval: false } },
    );
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.code).toBe('REGULATED_ACTOR_UNKNOWN');
      expect(result.reason).toContain('reviewer');
    }
  });

  it('FOUR_EYES_ACTOR_MATCH reason includes initiator ID', () => {
    const state = makeState('PLAN_REVIEW', {
      initiatedByIdentity: initiatorIdentity,
    });
    const result = executeReviewDecision(
      state,
      {
        verdict: 'approve',
        rationale: 'ok',
        decidedBy: 'initiator-1',
        decisionIdentity: { ...reviewerIdentity, actorId: 'initiator-1' },
      },
      { ...baseCtx, policy: { allowSelfApproval: false } },
    );
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.code).toBe('FOUR_EYES_ACTOR_MATCH');
      expect(result.reason).toContain('initiator-1');
    }
  });

  it('ACTOR_ASSURANCE_INSUFFICIENT reason includes minimum and current levels', () => {
    const state = makeState('PLAN_REVIEW', {
      initiatedByIdentity: initiatorIdentity,
    });
    const result = executeReviewDecision(
      state,
      {
        verdict: 'approve',
        rationale: 'ok',
        decidedBy: 'reviewer-1',
        decisionIdentity: { ...reviewerIdentity, actorAssurance: 'best_effort' as const },
      },
      { ...baseCtx, policy: { requireVerifiedActorsForApproval: true } },
    );
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.code).toBe('ACTOR_ASSURANCE_INSUFFICIENT');
      expect(result.reason).toContain('claim_validated');
      expect(result.reason).toContain('best_effort');
    }
  });

  it('ACTOR_ASSURANCE_INSUFFICIENT via minimumActorAssurance includes levels', () => {
    const state = makeState('PLAN_REVIEW', {
      initiatedByIdentity: initiatorIdentity,
    });
    const result = executeReviewDecision(
      state,
      {
        verdict: 'approve',
        rationale: 'ok',
        decidedBy: 'reviewer-1',
        decisionIdentity: { ...reviewerIdentity, actorAssurance: 'best_effort' as const },
      },
      { ...baseCtx, policy: { minimumActorAssuranceForApproval: 'idp_verified' } },
    );
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.code).toBe('ACTOR_ASSURANCE_INSUFFICIENT');
      expect(result.reason).toContain('idp_verified');
      expect(result.reason).toContain('best_effort');
    }
  });

  it('changes_requested at ARCH_REVIEW clears selfReview (not architecture)', () => {
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
      { verdict: 'changes_requested', rationale: 'rework', decidedBy: 'r1' },
      baseCtx,
    );
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.state.selfReview).toBeNull();
    }
  });

  it('INVALID_VERDICT includes the invalid verdict string', () => {
    const state = makeState('PLAN_REVIEW');
    const result = executeReviewDecision(
      state,
      { verdict: 'maybe' as never, rationale: 'idk', decidedBy: 'r1' },
      baseCtx,
    );
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.code).toBe('INVALID_VERDICT');
      expect(result.reason).toContain('maybe');
    }
  });

  // ─── MUTATION KILL round 2 ───────────────────────────────────
  it('idp_verified passes requireVerifiedActorsForApproval (assurance threshold)', () => {
    // Kill: actorAssurance !== 'idp_verified' → true (blocks idp_verified)
    const state = makeState('PLAN_REVIEW', {
      initiatedByIdentity: initiatorIdentity,
    });
    const result = executeReviewDecision(
      state,
      {
        verdict: 'approve',
        rationale: 'ok',
        decidedBy: 'reviewer-1',
        decisionIdentity: { ...reviewerIdentity, actorAssurance: 'idp_verified' as const },
      },
      { ...baseCtx, policy: { requireVerifiedActorsForApproval: true } },
    );
    // idp_verified meets the threshold — should NOT be blocked
    expect(result.kind).toBe('ok');
  });

  // ─── MUTATION KILL ────────────────────────────────────────────────────

  describe('MUTATION_KILL', () => {
    it('approve at ARCH_REVIEW sets architecture.status to "accepted"', () => {
      const state = makeState('ARCH_REVIEW', {
        architecture: ARCHITECTURE_DECISION,
        selfReview: CONVERGED_SELF_REVIEW,
      });
      const result = executeReviewDecision(
        state,
        { verdict: 'approve', rationale: 'LGTM', decidedBy: 'reviewer' },
        baseCtx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.architecture?.status).toBe('accepted');
      }
    });

    it('approve at ARCH_REVIEW without architecture leaves state unchanged (arch guard)', () => {
      const state = makeState('ARCH_REVIEW', {
        architecture: null,
        selfReview: CONVERGED_SELF_REVIEW,
      });
      const result = executeReviewDecision(
        state,
        { verdict: 'approve', rationale: 'LGTM', decidedBy: 'reviewer' },
        baseCtx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.architecture).toBeNull();
      }
    });

    it('changes_requested at ARCH_REVIEW clears selfReview', () => {
      const state = makeState('ARCH_REVIEW', {
        architecture: ARCHITECTURE_DECISION,
        selfReview: CONVERGED_SELF_REVIEW,
      });
      const result = executeReviewDecision(
        state,
        { verdict: 'changes_requested', rationale: 'Needs work', decidedBy: 'reviewer' },
        baseCtx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.selfReview).toBeNull();
        // architecture should still be present
        expect(result.state.architecture).not.toBeNull();
      }
    });

    it('changes_requested does NOT trigger four-eyes check (verdict gate)', () => {
      // Use regulated policy with allowSelfApproval=false
      // changes_requested by same person as initiator should NOT be blocked
      const state = makeState('PLAN_REVIEW', {
        plan: PLAN_RECORD,
        selfReview: CONVERGED_SELF_REVIEW,
        initiatedBy: 'same-person',
        initiatedByIdentity: { ...initiatorIdentity, actorId: 'same-person' },
      });
      const result = executeReviewDecision(
        state,
        {
          verdict: 'changes_requested',
          rationale: 'Needs changes',
          decidedBy: 'same-person',
          decisionIdentity: { ...reviewerIdentity, actorId: 'same-person' },
        },
        { ...baseCtx, policy: { allowSelfApproval: false } },
      );
      // Should NOT be blocked (four-eyes only applies to approve)
      expect(result.kind).toBe('ok');
    });

    it('P34: minimumActorAssuranceForApproval=claim_validated blocks best_effort actor', () => {
      const state = makeState('EVIDENCE_REVIEW', {
        implementation: IMPL_EVIDENCE,
        plan: PLAN_RECORD,
        initiatedBy: 'initiator',
        initiatedByIdentity: initiatorIdentity,
      });
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve',
          rationale: 'ok',
          decidedBy: 'reviewer-1',
          decisionIdentity: { ...reviewerIdentity, actorAssurance: 'best_effort' as const },
        },
        {
          ...baseCtx,
          policy: {
            minimumActorAssuranceForApproval: 'claim_validated',
            // NOT using legacy requireVerifiedActorsForApproval
          },
        },
      );
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') {
        expect(result.code).toBe('ACTOR_ASSURANCE_INSUFFICIENT');
      }
    });

    it('P34: minimumActorAssuranceForApproval=idp_verified blocks claim_validated actor', () => {
      const state = makeState('EVIDENCE_REVIEW', {
        implementation: IMPL_EVIDENCE,
        plan: PLAN_RECORD,
        initiatedBy: 'initiator',
        initiatedByIdentity: initiatorIdentity,
      });
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve',
          rationale: 'ok',
          decidedBy: 'reviewer-1',
          decisionIdentity: { ...reviewerIdentity, actorAssurance: 'claim_validated' as const },
        },
        {
          ...baseCtx,
          policy: {
            minimumActorAssuranceForApproval: 'idp_verified',
          },
        },
      );
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') {
        expect(result.code).toBe('ACTOR_ASSURANCE_INSUFFICIENT');
      }
    });

    it('P34: minimumActorAssuranceForApproval=claim_validated allows claim_validated actor (>= threshold)', () => {
      const state = makeState('EVIDENCE_REVIEW', {
        implementation: IMPL_EVIDENCE,
        plan: PLAN_RECORD,
        initiatedBy: 'initiator',
        initiatedByIdentity: initiatorIdentity,
      });
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve',
          rationale: 'ok',
          decidedBy: 'reviewer-1',
          decisionIdentity: { ...reviewerIdentity, actorAssurance: 'claim_validated' as const },
        },
        {
          ...baseCtx,
          policy: {
            minimumActorAssuranceForApproval: 'claim_validated',
          },
        },
      );
      expect(result.kind).toBe('ok');
    });

    it('P34: minimumActorAssuranceForApproval=idp_verified allows idp_verified actor', () => {
      const state = makeState('EVIDENCE_REVIEW', {
        implementation: IMPL_EVIDENCE,
        plan: PLAN_RECORD,
        initiatedBy: 'initiator',
        initiatedByIdentity: initiatorIdentity,
      });
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve',
          rationale: 'ok',
          decidedBy: 'reviewer-1',
          decisionIdentity: { ...reviewerIdentity, actorAssurance: 'idp_verified' as const },
        },
        {
          ...baseCtx,
          policy: {
            minimumActorAssuranceForApproval: 'idp_verified',
          },
        },
      );
      expect(result.kind).toBe('ok');
    });

    it('P34: minimumActorAssuranceForApproval absent → no assurance check (else-if gate)', () => {
      const state = makeState('EVIDENCE_REVIEW', {
        implementation: IMPL_EVIDENCE,
        plan: PLAN_RECORD,
        initiatedBy: 'initiator',
        initiatedByIdentity: initiatorIdentity,
      });
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve',
          rationale: 'ok',
          decidedBy: 'reviewer-1',
          decisionIdentity: { ...reviewerIdentity, actorAssurance: 'best_effort' as const },
        },
        {
          ...baseCtx,
          policy: {
            // Neither requireVerifiedActorsForApproval nor minimumActorAssuranceForApproval set
          },
        },
      );
      expect(result.kind).toBe('ok');
    });

    it('approve at PLAN_REVIEW does NOT modify architecture (phase guard)', () => {
      const state = makeState('PLAN_REVIEW', {
        plan: PLAN_RECORD,
        selfReview: CONVERGED_SELF_REVIEW,
      });
      const result = executeReviewDecision(
        state,
        { verdict: 'approve', rationale: 'ok', decidedBy: 'reviewer-1' },
        baseCtx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        // architecture should remain null — not set to {status:'accepted'}
        expect(result.state.architecture).toBeNull();
      }
    });

    // ── Kill mutants in applyStateClearingPattern ────────────────────

    it('changes_requested at PLAN_REVIEW clears selfReview (survivor kill)', () => {
      const state = makeState('PLAN_REVIEW', {
        plan: PLAN_RECORD,
        selfReview: CONVERGED_SELF_REVIEW,
      });
      const result = executeReviewDecision(
        state,
        { verdict: 'changes_requested', rationale: 'rework', decidedBy: 'reviewer-1' },
        baseCtx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.selfReview).toBeNull();
      }
    });

    it('changes_requested at EVIDENCE_REVIEW clears implementation and implReview (survivor kill)', () => {
      const state = makeState('EVIDENCE_REVIEW', {
        implementation: IMPL_EVIDENCE,
        implReview: {
          iteration: 1,
          maxIterations: 3,
          prevDigest: IMPL_EVIDENCE.digest,
          currDigest: IMPL_EVIDENCE.digest,
          revisionDelta: 'none',
          verdict: 'approve',
          executedAt: FIXED_TIME,
        },
      });
      const result = executeReviewDecision(
        state,
        { verdict: 'changes_requested', rationale: 'rework', decidedBy: 'reviewer-1' },
        baseCtx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.implementation).toBeNull();
        expect(result.state.implReview).toBeNull();
      }
    });

    it('changes_requested at ARCH_REVIEW clears selfReview (survivor kill)', () => {
      const state = makeState('ARCH_REVIEW', {
        architecture: ARCHITECTURE_DECISION,
        selfReview: CONVERGED_SELF_REVIEW,
      });
      const result = executeReviewDecision(
        state,
        { verdict: 'changes_requested', rationale: 'rework', decidedBy: 'reviewer-1' },
        baseCtx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.selfReview).toBeNull();
      }
    });

    it('reject at PLAN_REVIEW clears all downstream evidence (survivor kill)', () => {
      const state = makeState('PLAN_REVIEW', {
        ticket: { text: 't', digest: 'd', source: 'user', createdAt: FIXED_TIME },
        plan: PLAN_RECORD,
        selfReview: CONVERGED_SELF_REVIEW,
      });
      const result = executeReviewDecision(
        state,
        { verdict: 'reject', rationale: 'rejected', decidedBy: 'reviewer-1' },
        baseCtx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.ticket).toBeNull();
        expect(result.state.plan).toBeNull();
        expect(result.state.selfReview).toBeNull();
      }
    });

    it('reject at ARCH_REVIEW clears architecture and selfReview (survivor kill)', () => {
      const state = makeState('ARCH_REVIEW', {
        architecture: ARCHITECTURE_DECISION,
        selfReview: CONVERGED_SELF_REVIEW,
      });
      const result = executeReviewDecision(
        state,
        { verdict: 'reject', rationale: 'rejected', decidedBy: 'reviewer-1' },
        baseCtx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.architecture).toBeNull();
        expect(result.state.selfReview).toBeNull();
      }
    });

    it('actorAssurance fallback to best_effort when undefined (survivor kill)', () => {
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
            actorId: 'reviewer-1',
            actorEmail: 'r@e.com',
            actorSource: 'claim',
            actorAssurance: undefined as unknown as 'claim_validated', // Test fallback
          },
        },
        {
          ...baseCtx,
          policy: { requireVerifiedActorsForApproval: true },
        },
      );
      // Should still work since undefined falls back to 'best_effort' which fails requirement
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') {
        expect(result.code).toBe('ACTOR_ASSURANCE_INSUFFICIENT');
        // Pin the explicit string fallback so a literal mutation cannot survive:
        // the rendered message must contain "best_effort" as the current assurance.
        expect(result.reason).toContain('best_effort');
        expect(result.reason).toContain('claim_validated');
      }
    });

    it('actorAssurance fallback to best_effort under explicit minimumAssurance (P34 path)', () => {
      // Triggers the second fallback site at line 221.
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
            actorId: 'reviewer-1',
            actorEmail: 'r@e.com',
            actorSource: 'claim',
            actorAssurance: undefined as unknown as 'claim_validated',
          },
        },
        {
          ...baseCtx,
          policy: { minimumActorAssuranceForApproval: 'claim_validated' },
        },
      );
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') {
        expect(result.code).toBe('ACTOR_ASSURANCE_INSUFFICIENT');
        expect(result.reason).toContain('best_effort');
        expect(result.reason).toContain('claim_validated');
      }
    });

    it('approve at non-ARCH_REVIEW phase does NOT mutate architecture status', () => {
      // Kills L122 mutant `if (true && state.architecture)`:
      // approve at PLAN_REVIEW with architecture present must leave it untouched.
      const state = makeState('PLAN_REVIEW', {
        initiatedByIdentity: initiatorIdentity,
        architecture: ARCHITECTURE_DECISION,
        plan: PLAN_RECORD,
        selfReview: CONVERGED_SELF_REVIEW,
      });
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve',
          rationale: 'ok',
          decidedBy: 'reviewer-1',
        },
        baseCtx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        // Architecture must be preserved as-is, NOT promoted to 'accepted'
        // (which would happen only at ARCH_REVIEW).
        expect(result.state.architecture).toBe(state.architecture);
        expect(result.state.architecture?.status).toBe(ARCHITECTURE_DECISION.status);
      }
    });
  });
});
