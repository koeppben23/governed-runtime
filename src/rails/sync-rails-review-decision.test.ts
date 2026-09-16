import { describe, it, expect } from 'vitest';
import { executeReviewDecision } from '../rails/review-decision.js';
import type { ReviewDecisionInput } from '../rails/review-decision.js';
import { createTestContext } from '../testing.js';
import {
  makeState,
  makeProgressedState,
  REGULATED_POLICY_SNAPSHOT,
  DECISION_IDENTITY_REVIEWER,
  DECISION_IDENTITY_VERIFIED_REVIEWER,
} from '../fixtures.js';
import { ReviewDecision } from '../state/evidence.js';
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
    version: 'proofgraph.v2',
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
    version: 'v2' as const,
    claims: [
      {
        claimId: '00000000-0000-4000-8000-000000000763',
        statement: 'The protected behavior holds.',
        critical: true,
        authoritySectionId: 'proof',
        claimScope: 'specific_behavior' as const,
        expectedCheckId: 'test',
        counterexampleRequirement: {
          kind: 'assertion' as const,
          checkId: 'security',
          assertion: { providerId: 'junit', localId: 'some-id' },
        },
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
        planVersion: plan.current.planVersion,
        planRecordDigest: plan.current.recordDigest,
        reviewBinding: {
          kind: 'current_review' as const,
          reviewObligationId: '00000000-0000-4000-8000-000000000765',
          reviewEvidenceDigest: 'review-evidence-digest',
          reviewedSubjectDigest: plan.current.digest,
        },
        reviewObligationId: '00000000-0000-4000-8000-000000000765',
        reviewEvidenceDigest: 'review-evidence-digest',
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
          decisionIdentity: DECISION_IDENTITY_REVIEWER,
        },
        ctx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.phase).toBe('VALIDATION');
        expect(result.state.reviewDecision?.verdict).toBe('approve');
      }
    });

    it('approve at EVIDENCE_REVIEW → EXPORT_READY', () => {
      const state = makeProgressedState('EVIDENCE_REVIEW');
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve',
          rationale: 'Ship it',
          decisionIdentity: DECISION_IDENTITY_REVIEWER,
        },
        ctx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.phase).toBe('EXPORT_READY');
      }
    });

    it('blocks when a certificate-authorized critical plan claim has no ProofGraph projection', () => {
      const state = withCertifiedCriticalPlan(makeProgressedState('EVIDENCE_REVIEW'));
      const result = executeReviewDecision(
        { ...state, proofGraph: undefined },
        { verdict: 'approve', rationale: 'Ship it', decisionIdentity: DECISION_IDENTITY_REVIEWER },
        ctx,
      );
      expect(result).toMatchObject({
        kind: 'blocked',
        code: 'PROOFGRAPH_EVALUATION_UNAVAILABLE',
      });
      if (result.kind === 'blocked')
        expect(result.reason).toContain('00000000-0000-4000-8000-000000000763');
    });

    it('blocks EVIDENCE_REVIEW approval when critical declarations lack a certificate', () => {
      const certified = withCertifiedCriticalPlan(makeProgressedState('EVIDENCE_REVIEW'));
      const result = executeReviewDecision(
        { ...certified, plan: { ...certified.plan!, approvalCertificate: undefined } },
        { verdict: 'approve', rationale: 'Ship it', decisionIdentity: DECISION_IDENTITY_REVIEWER },
        ctx,
      );
      expect(result).toMatchObject({ kind: 'blocked', code: 'PROOFGRAPH_CERTIFICATE_INVALID' });
    });

    it('allows a missing ProofGraph projection when no critical plan claim is authorized', () => {
      const state = makeProgressedState('EVIDENCE_REVIEW');
      const result = executeReviewDecision(
        { ...state, proofGraph: undefined },
        { verdict: 'approve', rationale: 'Ship it', decisionIdentity: DECISION_IDENTITY_REVIEWER },
        ctx,
      );
      expect(result).toMatchObject({ kind: 'ok' });
    });

    it('blocks EVIDENCE_REVIEW approval on an unproven critical fact without any policy', () => {
      // Enforcement is unconditional (#762): no policy configuration is involved.
      const state = makeProgressedState('EVIDENCE_REVIEW');
      const result = executeReviewDecision(
        { ...state, proofGraph: proofGraph() },
        { verdict: 'approve', rationale: 'Ship it', decisionIdentity: DECISION_IDENTITY_REVIEWER },
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
          // The recorded review must cover the same revision as the
          // implementation under decision; otherwise the subject guard would
          // preempt the ProofGraph trigger gate this test exercises.
          implReview: { ...state.implReview!, currDigest: 'implementation-digest' },
          implementationRiskAssessment: {
            computedMinimumTaskClass: 'HIGH-RISK',
            touchedSurfaces: ['src/state/schema.ts'],
            riskTriggers: ['state_integrity'],
            assessedFrom: 'implementation_changed_files',
            assessedFileCount: 1,
            implementationDigest: 'implementation-digest',
          },
        },
        { verdict: 'approve', rationale: 'Ship it', decisionIdentity: DECISION_IDENTITY_REVIEWER },
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
          implReview: { ...state.implReview!, currDigest: 'implementation-digest' },
          implementationRiskAssessment: {
            computedMinimumTaskClass: 'HIGH-RISK',
            touchedSurfaces: ['src/archive/verify.ts'],
            riskTriggers: ['ceremony_only'],
            assessedFrom: 'implementation_changed_files',
            assessedFileCount: 1,
            implementationDigest: 'implementation-digest',
          },
        },
        { verdict: 'approve', rationale: 'Ship it', decisionIdentity: DECISION_IDENTITY_REVIEWER },
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
          implReview: { ...state.implReview!, currDigest: 'implementation-digest' },
          implementationRiskAssessment: {
            computedMinimumTaskClass: 'HIGH-RISK',
            touchedSurfaces: ['src/state/schema.ts'],
            assessedFrom: 'implementation_changed_files',
            assessedFileCount: 1,
            implementationDigest: 'implementation-digest',
          },
        },
        { verdict: 'approve', rationale: 'Ship it', decisionIdentity: DECISION_IDENTITY_REVIEWER },
        ctx,
      );
      expect(result).toMatchObject({ kind: 'blocked', code: 'PROOFGRAPH_RISK_ASSESSMENT_STALE' });
    });

    it('blocks with IMPLEMENTATION_REVIEW_SUBJECT_MISMATCH before the ProofGraph gate can evaluate', () => {
      const state = makeProgressedState('EVIDENCE_REVIEW');
      const result = executeReviewDecision(
        {
          ...state,
          // The implementation was replaced after review: the recorded review
          // still covers 'digest-of-impl'. The unproven ProofGraph fact below
          // would also gate approval — the subject guard must win as the
          // earliest, most specific block.
          implementation: { ...state.implementation!, digest: 'implementation-digest' },
          proofGraph: proofGraph(),
        },
        { verdict: 'approve', rationale: 'Ship it', decisionIdentity: DECISION_IDENTITY_REVIEWER },
        ctx,
      );
      expect(result).toMatchObject({
        kind: 'blocked',
        code: 'IMPLEMENTATION_REVIEW_SUBJECT_MISMATCH',
      });
      if (result.kind === 'blocked') {
        expect(result.reason).toContain('digest-of-impl');
        expect(result.reason).toContain('implementation-digest');
      }
    });

    it('does not apply the gate to hypothesis claims', () => {
      const state = makeProgressedState('EVIDENCE_REVIEW');
      const result = executeReviewDecision(
        { ...state, proofGraph: proofGraph('hypothesis') },
        { verdict: 'approve', rationale: 'Ship it', decisionIdentity: DECISION_IDENTITY_REVIEWER },
        ctx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') expect(result.state.phase).toBe('EXPORT_READY');
    });

    it('changes_requested at PLAN_REVIEW → PLAN', () => {
      const state = makeProgressedState('PLAN_REVIEW');
      const result = executeReviewDecision(
        state,
        {
          verdict: 'changes_requested',
          rationale: 'Needs more detail',
          decisionIdentity: DECISION_IDENTITY_REVIEWER,
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

    it('reject at PLAN_REVIEW → REJECTED while preserving decision evidence', () => {
      const state = makeProgressedState('PLAN_REVIEW');
      const result = executeReviewDecision(
        state,
        {
          verdict: 'reject',
          rationale: 'Wrong approach',
          decisionIdentity: DECISION_IDENTITY_REVIEWER,
        },
        ctx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.phase).toBe('REJECTED');
        expect(result.state.plan).not.toBeNull();
        expect(result.state.selfReview).not.toBeNull();
        expect(result.state.reviewDecision?.verdict).toBe('reject');
      }
    });

    it('changes_requested at EVIDENCE_REVIEW → IMPLEMENTATION', () => {
      const state = makeProgressedState('EVIDENCE_REVIEW');
      const result = executeReviewDecision(
        state,
        {
          verdict: 'changes_requested',
          rationale: 'Missing edge case',
          decisionIdentity: DECISION_IDENTITY_REVIEWER,
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
          decisionIdentity: DECISION_IDENTITY_REVIEWER,
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
          decisionIdentity: DECISION_IDENTITY_REVIEWER,
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
        { verdict: 'approve', rationale: 'ok', decisionIdentity: DECISION_IDENTITY_REVIEWER },
        ctx,
      );
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') expect(result.code).toBe('COMMAND_NOT_ALLOWED');
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe('CORNER', () => {
    it('four-eyes blocks when the reviewer identity matches the initiator in regulated mode (P30)', () => {
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
          decisionIdentity: state.initiatedByIdentity!,
        },
        regulatedCtx,
      );
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') expect(result.code).toBe('FOUR_EYES_ACTOR_MATCH');
    });

    it('four-eyes allows when the reviewer identity differs from the initiator in regulated mode (P30)', () => {
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
          decisionIdentity: DECISION_IDENTITY_REVIEWER,
        },
        regulatedCtx,
      );
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') expect(result.code).toBe('DECISION_IDENTITY_REQUIRED');
    });

    it('blocks approve when claim_validated minimum meets a best_effort actor', () => {
      const state = {
        ...makeProgressedState('PLAN_REVIEW'),
        policySnapshot: {
          ...REGULATED_POLICY_SNAPSHOT,
          minimumActorAssuranceForApproval: 'claim_validated' as const,
        },
      };
      const regulatedCtx = {
        ...ctx,
        policy: {
          ...REGULATED_POLICY,
          minimumActorAssuranceForApproval: 'claim_validated' as const,
        },
      };
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve',
          rationale: 'LGTM',
          decisionIdentity: DECISION_IDENTITY_REVIEWER, // best_effort
        },
        regulatedCtx,
      );
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') expect(result.code).toBe('ACTOR_ASSURANCE_INSUFFICIENT');
    });

    it('allows approve when claim_validated minimum is met by a verified actor', () => {
      const state = {
        ...makeProgressedState('PLAN_REVIEW'),
        policySnapshot: {
          ...REGULATED_POLICY_SNAPSHOT,
          minimumActorAssuranceForApproval: 'claim_validated' as const,
        },
      };
      const regulatedCtx = {
        ...ctx,
        policy: {
          ...REGULATED_POLICY,
          minimumActorAssuranceForApproval: 'claim_validated' as const,
        },
      };
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve',
          rationale: 'LGTM',
          decisionIdentity: DECISION_IDENTITY_VERIFIED_REVIEWER, // verified
        },
        regulatedCtx,
      );
      expect(result.kind).toBe('ok');
    });

    it('different verified reviewer passes four-eyes and assurance checks', () => {
      const state = {
        ...makeProgressedState('PLAN_REVIEW'),
        policySnapshot: {
          ...REGULATED_POLICY_SNAPSHOT,
          minimumActorAssuranceForApproval: 'claim_validated' as const,
        },
      };
      const regulatedCtx = {
        ...ctx,
        policy: {
          ...REGULATED_POLICY,
          minimumActorAssuranceForApproval: 'claim_validated' as const,
        },
      };
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve',
          rationale: 'LGTM',
          decisionIdentity: DECISION_IDENTITY_VERIFIED_REVIEWER,
        },
        regulatedCtx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.phase).toBe('VALIDATION');
      }
    });

    it('same verified actor blocks FOUR_EYES_ACTOR_MATCH', () => {
      const state = {
        ...makeProgressedState('PLAN_REVIEW'),
        policySnapshot: {
          ...REGULATED_POLICY_SNAPSHOT,
          minimumActorAssuranceForApproval: 'claim_validated' as const,
        },
        initiatedByIdentity: DECISION_IDENTITY_VERIFIED_REVIEWER,
      };
      const regulatedCtx = {
        ...ctx,
        policy: {
          ...REGULATED_POLICY,
          minimumActorAssuranceForApproval: 'claim_validated' as const,
        },
      };
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve',
          rationale: 'LGTM',
          decisionIdentity: DECISION_IDENTITY_VERIFIED_REVIEWER,
        },
        regulatedCtx,
      );
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') expect(result.code).toBe('FOUR_EYES_ACTOR_MATCH');
    });

    it('allows best_effort approval when the minimum is best_effort', () => {
      const state = {
        ...makeProgressedState('PLAN_REVIEW'),
        policySnapshot: {
          ...REGULATED_POLICY_SNAPSHOT,
          minimumActorAssuranceForApproval: 'best_effort' as const,
        },
      };
      const regulatedCtx = {
        ...ctx,
        policy: {
          ...REGULATED_POLICY,
          minimumActorAssuranceForApproval: 'best_effort' as const,
        },
      };
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve',
          rationale: 'LGTM',
          decisionIdentity: DECISION_IDENTITY_REVIEWER, // best_effort
        },
        regulatedCtx,
      );
      expect(result.kind).toBe('ok');
    });

    it('claim_validated minimum applies even when self-approval is allowed', () => {
      const state = {
        ...makeProgressedState('PLAN_REVIEW'),
        policySnapshot: {
          ...REGULATED_POLICY_SNAPSHOT,
          allowSelfApproval: true,
          minimumActorAssuranceForApproval: 'claim_validated' as const,
        },
      };
      const regulatedCtx = {
        ...ctx,
        policy: {
          ...REGULATED_POLICY,
          allowSelfApproval: true,
          minimumActorAssuranceForApproval: 'claim_validated' as const,
        },
      };
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve',
          rationale: 'LGTM',
          decisionIdentity: DECISION_IDENTITY_REVIEWER,
        },
        regulatedCtx,
      );
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') expect(result.code).toBe('ACTOR_ASSURANCE_INSUFFICIENT');
    });

    it('P30: obsolete decidedBy-only decisions are rejected at the identity boundary', () => {
      // The persisted contract no longer accepts a flat decidedBy string.
      expect(
        ReviewDecision.safeParse({
          verdict: 'approve',
          rationale: 'LGTM',
          decidedAt: '2026-01-01T00:00:00.000Z',
          decidedBy: DECISION_IDENTITY_REVIEWER.actorId,
        }).success,
      ).toBe(false);
      const state = {
        ...makeProgressedState('PLAN_REVIEW'),
        policySnapshot: { ...REGULATED_POLICY_SNAPSHOT },
      };
      const regulatedCtx = { ...ctx, policy: REGULATED_POLICY };
      const result = executeReviewDecision(
        state,
        { verdict: 'approve', rationale: 'LGTM' } as unknown as ReviewDecisionInput,
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
          decisionIdentity: DECISION_IDENTITY_REVIEWER,
        },
        ctx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.reviewDecision?.decisionIdentity).toEqual(DECISION_IDENTITY_REVIEWER);
        expect(result.state.reviewDecision?.decisionIdentity.actorId).toBe(
          DECISION_IDENTITY_REVIEWER.actorId,
        );
      }
    });

    it('rejects at EVIDENCE_REVIEW into the terminal REJECTED phase', () => {
      const state = makeProgressedState('EVIDENCE_REVIEW');
      const result = executeReviewDecision(
        state,
        {
          verdict: 'reject',
          rationale: 'Start over',
          decisionIdentity: DECISION_IDENTITY_REVIEWER,
        },
        ctx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.phase).toBe('REJECTED');
        expect(result.state.plan).not.toBeNull();
        expect(result.state.implementation).not.toBeNull();
        expect(result.state.reviewDecision?.verdict).toBe('reject');
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
          decisionIdentity: state.initiatedByIdentity!,
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
          decisionIdentity: DECISION_IDENTITY_REVIEWER,
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
          decisionIdentity: DECISION_IDENTITY_REVIEWER,
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

    it('the ProofGraph gate does not apply to PLAN_REVIEW approval', () => {
      const state = makeProgressedState('PLAN_REVIEW');
      const result = executeReviewDecision(
        { ...state, proofGraph: proofGraph() },
        { verdict: 'approve', rationale: 'LGTM', decisionIdentity: DECISION_IDENTITY_REVIEWER },
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
          decisionIdentity: DECISION_IDENTITY_REVIEWER,
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

    it('reject at ARCH_REVIEW → REJECTED with preserved architecture', () => {
      const state = makeProgressedState('ARCH_REVIEW');
      const result = executeReviewDecision(
        state,
        {
          verdict: 'reject',
          rationale: 'Wrong approach entirely',
          decisionIdentity: DECISION_IDENTITY_REVIEWER,
        },
        ctx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.phase).toBe('REJECTED');
        expect(result.state.architecture).not.toBeNull();
        expect(result.state.selfReview).not.toBeNull();
        expect(result.state.reviewDecision?.verdict).toBe('reject');
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
          decisionIdentity: state.initiatedByIdentity!,
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
          decisionIdentity: DECISION_IDENTITY_REVIEWER,
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
      { verdict: 'approve', rationale: 'ok', decisionIdentity: DECISION_IDENTITY_REVIEWER },
      mCtx,
    );
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.reason).toContain('/review-decision');
      expect(result.reason).toContain('TICKET');
    }
  });
});
