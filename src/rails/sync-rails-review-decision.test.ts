import { describe, it, expect } from 'vitest';
import { executeReviewDecision } from '../rails/review-decision.js';
import { createTestContext } from '../testing.js';
import {
  makeState,
  makeProgressedState,
  REGULATED_POLICY_SNAPSHOT,
  DECISION_IDENTITY_REVIEWER,
  DECISION_IDENTITY_VERIFIED_REVIEWER,
} from '../fixtures.js';
import { REGULATED_POLICY, TEAM_POLICY } from '../config/policy.js';
import type { ProofGraphProjection } from '../state/proofgraph.js';
import { canonicalJsonStringify } from '../shared/canonical-json.js';
import { hashText } from '../shared/hashing.js';

const ctx = createTestContext();

/** Human-approval binding; only a certificate-authorized claim is gate-eligible. */
const APPROVAL = {
  certificateId: '00000000-0000-4000-8000-0000000000ce',
  claimDeclarationsDigest: 'a'.repeat(64),
  decisionAttestationDigest: 'b'.repeat(64),
  declarationId: '00000000-0000-4000-8000-0000000000de',
} as const;

function proofGraph(
  signalClass: 'fact' | 'hypothesis' = 'fact',
  verificationState: 'PROVEN' | 'UNPROVEN' = 'UNPROVEN',
  certified = true,
): ProofGraphProjection {
  return {
    version: 'proofgraph.v1',
    evaluatedAt: '2026-01-01T00:00:00.000Z',
    claims: [
      {
        claimId: '00000000-0000-4000-8000-000000000762',
        statement: 'The protected behavior holds.',
        signalClass,
        critical: true,
        provenance: {
          kind: 'canonical_authority',
          authorityId: 'plan',
          digest: 'digest',
          ...(certified ? { approval: APPROVAL } : {}),
        },
        evidenceRefs: [],
        counterexampleRefs: [],
        verificationState,
      },
    ],
  };
}

function withCertifiedCriticalPlan(state: ReturnType<typeof makeProgressedState>) {
  const declarations = {
    flow: 'plan' as const,
    claims: [
      {
        claimId: '00000000-0000-4000-8000-000000000763',
        statement: 'The protected behavior holds.',
        critical: true,
        authoritySectionId: 'proof',
        expectedCheckId: 'test',
        counterexampleCheckId: 'security',
      },
    ],
  };
  const plan = state.plan!;
  return {
    ...state,
    plan: {
      ...plan,
      claimDeclarations: declarations,
      approvalCertificate: {
        flow: 'plan' as const,
        authorityDigest: plan.current.digest,
        claimDeclarationsDigest: hashText(canonicalJsonStringify(declarations)),
        decisionAttestationDigest: 'decision-digest',
        approvedAt: '2026-01-01T00:00:00.000Z',
        approvedBy: 'reviewer-1',
        certificateId: '00000000-0000-4000-8000-000000000764',
        planVersion: 1,
        planRecordDigest: 'record-digest',
        reviewObligationId: null,
        reviewEvidenceDigest: null,
      },
    },
  };
}

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

    it('blocks when a certificate-authorized critical plan claim has no ProofGraph projection', () => {
      const state = withCertifiedCriticalPlan(makeProgressedState('EVIDENCE_REVIEW'));
      const result = executeReviewDecision(
        { ...state, proofGraph: undefined },
        { verdict: 'approve', rationale: 'Ship it', decidedBy: 'reviewer-1' },
        ctx,
      );
      expect(result).toMatchObject({
        kind: 'blocked',
        code: 'PROOFGRAPH_EVALUATION_UNAVAILABLE',
      });
      if (result.kind === 'blocked')
        expect(result.reason).toContain('00000000-0000-4000-8000-000000000763');
    });

    it('allows a missing ProofGraph projection when no critical plan claim is authorized', () => {
      const state = makeProgressedState('EVIDENCE_REVIEW');
      const result = executeReviewDecision(
        { ...state, proofGraph: undefined },
        { verdict: 'approve', rationale: 'Ship it', decidedBy: 'reviewer-1' },
        ctx,
      );
      expect(result).toMatchObject({ kind: 'ok' });
    });

    it('blocks EVIDENCE_REVIEW approval on an unproven critical fact without any policy', () => {
      // Enforcement is unconditional (#762): no policy configuration is involved.
      const state = makeProgressedState('EVIDENCE_REVIEW');
      const result = executeReviewDecision(
        { ...state, proofGraph: proofGraph() },
        { verdict: 'approve', rationale: 'Ship it', decidedBy: 'reviewer-1' },
        ctx,
      );
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') {
        expect(result.code).toBe('PROOFGRAPH_CRITICAL_FACTS_UNPROVEN');
        expect(result.reason).toContain('00000000-0000-4000-8000-000000000762');
      }
    });

    it('blocks a specific implementation trigger without a critical fact claim', () => {
      const state = makeProgressedState('EVIDENCE_REVIEW');
      const result = executeReviewDecision(
        {
          ...state,
          implementation: {
            changedFiles: ['src/state/schema.ts'],
            domainFiles: ['src/state/schema.ts'],
            digest: 'implementation-digest',
            executedAt: '2026-01-01T00:00:00.000Z',
          },
          implementationRiskAssessment: {
            computedMinimumTaskClass: 'HIGH-RISK',
            touchedSurfaces: ['src/state/schema.ts'],
            riskTriggers: ['state_integrity'],
            assessedFrom: 'implementation_changed_files',
            assessedFileCount: 1,
            implementationDigest: 'implementation-digest',
          },
        },
        { verdict: 'approve', rationale: 'Ship it', decidedBy: 'reviewer-1' },
        ctx,
      );
      expect(result).toMatchObject({ kind: 'blocked', code: 'PROOFGRAPH_CRITICAL_FACT_REQUIRED' });
    });

    it('does not impose a critical fact requirement for ceremony_only', () => {
      const state = makeProgressedState('EVIDENCE_REVIEW');
      const result = executeReviewDecision(
        {
          ...state,
          implementation: {
            changedFiles: ['src/archive/verify.ts'],
            domainFiles: ['src/archive/verify.ts'],
            digest: 'implementation-digest',
            executedAt: '2026-01-01T00:00:00.000Z',
          },
          implementationRiskAssessment: {
            computedMinimumTaskClass: 'HIGH-RISK',
            touchedSurfaces: ['src/archive/verify.ts'],
            riskTriggers: ['ceremony_only'],
            assessedFrom: 'implementation_changed_files',
            assessedFileCount: 1,
            implementationDigest: 'implementation-digest',
          },
        },
        { verdict: 'approve', rationale: 'Ship it', decidedBy: 'reviewer-1' },
        ctx,
      );
      expect(result).toMatchObject({ kind: 'ok' });
    });

    it('blocks an assessment that predates trigger classification', () => {
      const state = makeProgressedState('EVIDENCE_REVIEW');
      const result = executeReviewDecision(
        {
          ...state,
          implementation: {
            changedFiles: ['src/state/schema.ts'],
            domainFiles: ['src/state/schema.ts'],
            digest: 'implementation-digest',
            executedAt: '2026-01-01T00:00:00.000Z',
          },
          implementationRiskAssessment: {
            computedMinimumTaskClass: 'HIGH-RISK',
            touchedSurfaces: ['src/state/schema.ts'],
            assessedFrom: 'implementation_changed_files',
            assessedFileCount: 1,
            implementationDigest: 'implementation-digest',
          },
        },
        { verdict: 'approve', rationale: 'Ship it', decidedBy: 'reviewer-1' },
        ctx,
      );
      expect(result).toMatchObject({ kind: 'blocked', code: 'PROOFGRAPH_RISK_ASSESSMENT_STALE' });
    });

    it('does not apply the gate to hypothesis claims', () => {
      const state = makeProgressedState('EVIDENCE_REVIEW');
      const result = executeReviewDecision(
        { ...state, proofGraph: proofGraph('hypothesis') },
        { verdict: 'approve', rationale: 'Ship it', decidedBy: 'reviewer-1' },
        ctx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') expect(result.state.phase).toBe('COMPLETE');
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
        expect(result.state.reviewDecision).toBeNull();
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
        expect(result.state.reviewDecision).toBeNull();
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
        expect(result.state.reviewDecision).toBeNull();
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

    it('does not apply the gate to standalone review phases', () => {
      const result = executeReviewDecision(
        makeState('REVIEW_COMPLETE', { proofGraph: proofGraph() }),
        { verdict: 'approve', rationale: 'ok', decidedBy: 'r' },
        ctx,
      );
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') expect(result.code).toBe('COMMAND_NOT_ALLOWED');
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
          decidedBy: DECISION_IDENTITY_VERIFIED_REVIEWER.actorId,
          decisionIdentity: DECISION_IDENTITY_VERIFIED_REVIEWER,
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
        policySnapshot: {
          ...REGULATED_POLICY_SNAPSHOT,
          requireVerifiedActorsForApproval: false,
          minimumActorAssuranceForApproval: 'best_effort' as const,
        },
      };
      const regulatedCtx = {
        ...ctx,
        policy: {
          ...REGULATED_POLICY,
          requireVerifiedActorsForApproval: false,
          minimumActorAssuranceForApproval: 'best_effort' as const,
        },
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

    it('does not apply the gate to PLAN_REVIEW approval', () => {
      const state = makeProgressedState('PLAN_REVIEW');
      const result = executeReviewDecision(
        { ...state, proofGraph: proofGraph() },
        { verdict: 'approve', rationale: 'LGTM', decidedBy: 'reviewer-1' },
        ctx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') expect(result.state.phase).toBe('VALIDATION');
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
