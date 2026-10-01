import { describe, expect, it } from 'vitest';
import { executeReviewDecision } from './review-decision.js';
import {
  makeState,
  ARCHITECTURE_DECISION,
  IMPL_EVIDENCE,
  PLAN_RECORD,
  FIXED_TIME,
  APPROVED_IMPL_REVIEW,
  REDUCED_CEREMONY_DECISION,
} from '../fixtures.js';
import { TEAM_POLICY } from '../config/policy.js';
import type { FlowGuardPolicy } from '../config/policy.js';
import type { ReviewAssuranceState } from '../state/evidence-review.js';
import { DecisionIdentity } from '../state/evidence-identity.js';
import {
  assuranceChain,
  ARCH_INVOCATION_ID,
  ARCH_OBLIGATION_ID,
} from './review-decision-test-helpers.js';
import { hashText } from '../shared/hashing.js';
import { canonicalJsonStringify } from '../shared/canonical-json.js';
import { emptyClaimDeclarations } from '../state/proofgraph-approval.js';

const baseCtx = {
  now: () => FIXED_TIME,
  digest: (text: string) => `sha256:${text.length}`,
  policy: TEAM_POLICY,
};

/**
 * Bound architecture review evidence in the canonical assurance chain: one
 * fulfilled/consumed obligation plus its invocation with a findingsHash.
 * `obligationInvocationId: false` reproduces the direct host-task shape where
 * the obligation's invocationId is unset and the invocation links back via
 * obligationId only.
 */
function architectureAssurance(input: {
  subjectDigest: string;
  status: 'fulfilled' | 'consumed';
  iteration?: number;
  findingsHash?: string;
  capturedVerdict?: string;
  claimDeclarationsDigest?: string;
  obligationInvocationId?: boolean;
}): ReviewAssuranceState {
  return assuranceChain([
    {
      obligationId: ARCH_OBLIGATION_ID,
      subjectDigest: input.subjectDigest,
      status: input.status,
      ...(input.iteration !== undefined ? { iteration: input.iteration } : {}),
      ...(input.findingsHash !== undefined ? { findingsHash: input.findingsHash } : {}),
      ...(input.capturedVerdict !== undefined ? { capturedVerdict: input.capturedVerdict } : {}),
      ...(input.claimDeclarationsDigest !== undefined
        ? { claimDeclarationsDigest: input.claimDeclarationsDigest }
        : {}),
      invocationId: input.obligationInvocationId === false ? null : ARCH_INVOCATION_ID,
      consumedByObligationId: input.status === 'consumed' ? ARCH_OBLIGATION_ID : null,
    },
  ]);
}

function withPolicy(overrides: Partial<FlowGuardPolicy>): FlowGuardPolicy {
  return { ...TEAM_POLICY, ...overrides };
}

const PLAN_OBLIGATION_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PLAN_INVOCATION_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

interface PlanAssuranceInput {
  subjectDigest: string;
  status: 'fulfilled' | 'consumed' | 'pending';
  obligationType?: 'plan' | 'architecture';
  obligationId?: string;
  invocationId?: string;
  findingsHash?: string;
  iteration?: number;
  createdAt?: string;
  capturedVerdict?: string;
  claimDeclarationsDigest?: string;
}

/** Minimal single-obligation assurance for plan-certificate binding tests. */
function planAssurance(input: PlanAssuranceInput): ReviewAssuranceState {
  const obligationId = input.obligationId ?? PLAN_OBLIGATION_ID;
  return assuranceChain([
    {
      obligationId,
      obligationType: input.obligationType ?? 'plan',
      subjectDigest: input.subjectDigest,
      status: input.status,
      ...(input.iteration !== undefined ? { iteration: input.iteration } : {}),
      ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
      invocationId: input.invocationId ?? PLAN_INVOCATION_ID,
      findingsHash: input.findingsHash ?? 'a'.repeat(64),
      ...(input.capturedVerdict !== undefined ? { capturedVerdict: input.capturedVerdict } : {}),
      // Default: the empty declaration set (most plan-approval tests carry no claims).
      claimDeclarationsDigest:
        input.claimDeclarationsDigest ??
        hashText(canonicalJsonStringify(emptyClaimDeclarations('plan'))),
      consumedByObligationId: input.status === 'consumed' ? obligationId : null,
    },
  ]);
}

function identityWithoutAssurance(): typeof reviewerIdentity {
  const identity = { ...reviewerIdentity };
  Reflect.deleteProperty(identity, 'actorAssurance');
  return identity;
}

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
  reviewCycle: 1,
  maxIterations: 3,
  prevDigest: null,
  currDigest: 'review-digest',
  revisionDelta: 'none' as const,
  verdict: 'accept' as const,
  decidedAt: FIXED_TIME,
};

const PLAN_CLAIM = {
  claimId: '00000000-0000-4000-8000-000000000003',
  statement: 'The login flow rejects invalid credentials.',
  critical: true,
  authoritySectionId: 'authentication',
  claimScope: 'specific_behavior' as const,
  expectedCheckId: 'test',
};

const ARCHITECTURE_CLAIM = {
  claimId: '00000000-0000-4000-8000-000000000004',
  statement: 'The selected architecture keeps service data durable.',
  critical: true,
  authoritySectionId: 'decision',
  requiredReviewEvidence: ['architecture-review'],
};

describe('review-decision lifecycle boundaries', () => {
  function ticketFixture(text = 't', digest = 'd') {
    return {
      text,
      digest,
      source: 'user' as const,
      createdAt: '2026-01-01T00:00:00.000Z',
      riskDeclaration: { kind: 'absent' as const },
    };
  }

  describe('plan, architecture, and implementation lifecycle boundaries', () => {
    it('approve at ARCH_REVIEW sets architecture.status to "accepted"', () => {
      const state = makeState('ARCH_REVIEW', {
        architecture: { ...ARCHITECTURE_DECISION, reviewCompletion: 'reviewer_accepted' },
        reviewAssurance: architectureAssurance({
          subjectDigest: ARCHITECTURE_DECISION.digest,
          status: 'consumed',
          capturedVerdict: 'accept',
        }),
        selfReview: CONVERGED_SELF_REVIEW,
      });
      const result = executeReviewDecision(
        state,
        { verdict: 'approve', rationale: 'LGTM', decisionIdentity: reviewerIdentity },
        baseCtx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.architecture?.status).toBe('accepted');
      }
    });

    it('blocks approval at ARCH_REVIEW without completed architecture review evidence', () => {
      const state = makeState('ARCH_REVIEW', {
        architecture: null,
        selfReview: CONVERGED_SELF_REVIEW,
      });
      const result = executeReviewDecision(
        state,
        { verdict: 'approve', rationale: 'LGTM', decisionIdentity: reviewerIdentity },
        baseCtx,
      );
      expect(result).toMatchObject({
        kind: 'blocked',
        code: 'ARCHITECTURE_REVIEW_COMPLETION_REQUIRED',
      });
    });

    it('blocks approval at ARCH_REVIEW while review completion is pending', () => {
      const state = makeState('ARCH_REVIEW', {
        architecture: ARCHITECTURE_DECISION,
        selfReview: CONVERGED_SELF_REVIEW,
      });
      const result = executeReviewDecision(
        state,
        { verdict: 'approve', rationale: 'LGTM', decisionIdentity: reviewerIdentity },
        baseCtx,
      );
      expect(result).toMatchObject({
        kind: 'blocked',
        code: 'ARCHITECTURE_REVIEW_COMPLETION_REQUIRED',
      });
      expect(state.architecture?.status).toBe('proposed');
      expect(state.architecture?.approvalCertificate).toBeUndefined();
    });

    it.each(['reviewer_accepted', 'review_exhausted'] as const)(
      'allows approval with %s architecture review completion and binds the exact evidence',
      (reviewCompletion) => {
        const state = makeState('ARCH_REVIEW', {
          architecture: { ...ARCHITECTURE_DECISION, reviewCompletion },
          // Deliberately SAME digest as the current ADR for both paths: the
          // exhausted case must still yield review_exhausted_override — the
          // binding kind comes from the gate path, never from digest equality.
          reviewAssurance: architectureAssurance({
            subjectDigest: ARCHITECTURE_DECISION.digest,
            status: 'consumed',
            capturedVerdict:
              reviewCompletion === 'reviewer_accepted' ? 'accept' : 'changes_requested',
          }),
          selfReview: CONVERGED_SELF_REVIEW,
        });
        // An exhausted loop requires the explicit override intent; the gate
        // type is derived from persisted state, not chosen by the caller.
        const verdict =
          reviewCompletion === 'reviewer_accepted'
            ? ('approve' as const)
            : ('approve_with_governance_override' as const);
        const result = executeReviewDecision(
          state,
          { verdict, rationale: 'LGTM', decisionIdentity: reviewerIdentity },
          baseCtx,
        );
        expect(result.kind).toBe('ok');
        if (result.kind === 'ok') {
          expect(result.state.phase).toBe('ARCH_COMPLETE');
          expect(result.state.architecture?.status).toBe('accepted');
          expect(result.state.architecture?.approvalCertificate?.reviewBinding).toEqual(
            reviewCompletion === 'reviewer_accepted'
              ? {
                  kind: 'current_review',
                  reviewObligationId: ARCH_OBLIGATION_ID,
                  reviewEvidenceDigest: 'f'.repeat(64),
                  reviewedSubjectDigest: ARCHITECTURE_DECISION.digest,
                }
              : {
                  kind: 'review_exhausted_override',
                  lastReviewObligationId: ARCH_OBLIGATION_ID,
                  lastReviewEvidenceDigest: 'f'.repeat(64),
                  reviewedSubjectDigest: ARCHITECTURE_DECISION.digest,
                  approvedSubjectDigest: ARCHITECTURE_DECISION.digest,
                },
          );
        }
      },
    );

    it('blocks approval when the obligation invocationId is unset (no non-canonical rescue path)', () => {
      const state = makeState('ARCH_REVIEW', {
        architecture: { ...ARCHITECTURE_DECISION, reviewCompletion: 'reviewer_accepted' },
        reviewAssurance: architectureAssurance({
          subjectDigest: ARCHITECTURE_DECISION.digest,
          status: 'consumed',
          capturedVerdict: 'accept',
          obligationInvocationId: false,
        }),
        selfReview: CONVERGED_SELF_REVIEW,
      });
      const result = executeReviewDecision(
        state,
        { verdict: 'approve', rationale: 'LGTM', decisionIdentity: reviewerIdentity },
        baseCtx,
      );
      expect(result).toMatchObject({
        kind: 'blocked',
        code: 'ARCHITECTURE_REVIEW_EVIDENCE_REQUIRED',
      });
      expect(state.architecture?.approvalCertificate).toBeUndefined();
    });

    it('blocks approval at ARCH_REVIEW without bindable architecture review evidence', () => {
      const state = makeState('ARCH_REVIEW', {
        architecture: { ...ARCHITECTURE_DECISION, reviewCompletion: 'reviewer_accepted' },
        selfReview: CONVERGED_SELF_REVIEW,
      });
      const result = executeReviewDecision(
        state,
        { verdict: 'approve', rationale: 'LGTM', decisionIdentity: reviewerIdentity },
        baseCtx,
      );
      expect(result).toMatchObject({
        kind: 'blocked',
        code: 'ARCHITECTURE_REVIEW_EVIDENCE_REQUIRED',
      });
      expect(state.architecture?.approvalCertificate).toBeUndefined();
    });

    it('blocks reviewer_accepted approval when evidence reviewed a different digest (no cross-digest fallback)', () => {
      const state = makeState('ARCH_REVIEW', {
        architecture: { ...ARCHITECTURE_DECISION, reviewCompletion: 'reviewer_accepted' },
        reviewAssurance: architectureAssurance({
          subjectDigest: 'digest-of-prior-adr-revision',
          status: 'consumed',
          capturedVerdict: 'accept',
        }),
        selfReview: CONVERGED_SELF_REVIEW,
      });
      const result = executeReviewDecision(
        state,
        { verdict: 'approve', rationale: 'LGTM', decisionIdentity: reviewerIdentity },
        baseCtx,
      );
      expect(result).toMatchObject({
        kind: 'blocked',
        code: 'ARCHITECTURE_REVIEW_EVIDENCE_REQUIRED',
      });
    });

    it('blocks a review_exhausted_override whose reviewed subject differs from the approved subject', () => {
      const revisedDigest = 'digest-of-revised-adr';
      const state = makeState('ARCH_REVIEW', {
        architecture: {
          ...ARCHITECTURE_DECISION,
          digest: revisedDigest,
          reviewCompletion: 'review_exhausted',
        },
        reviewAssurance: architectureAssurance({
          subjectDigest: ARCHITECTURE_DECISION.digest,
          status: 'consumed',
          capturedVerdict: 'changes_requested',
        }),
        selfReview: CONVERGED_SELF_REVIEW,
      });
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve_with_governance_override',
          rationale: 'override',
          decisionIdentity: reviewerIdentity,
        },
        baseCtx,
      );
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') {
        expect(result.code).toBe('ARCHITECTURE_REVIEW_OVERRIDE_SUBJECT_MISMATCH');
        // The exact-equality requirement is surfaced with both digests.
        expect(result.reason).toContain(ARCHITECTURE_DECISION.digest);
        expect(result.reason).toContain(revisedDigest);
      }
      expect(state.architecture?.approvalCertificate).toBeUndefined();
    });

    it('relabeling the reviewBinding kind changes the certificate identity', () => {
      const accepted = makeState('ARCH_REVIEW', {
        architecture: { ...ARCHITECTURE_DECISION, reviewCompletion: 'reviewer_accepted' },
        reviewAssurance: architectureAssurance({
          subjectDigest: ARCHITECTURE_DECISION.digest,
          status: 'consumed',
          capturedVerdict: 'accept',
        }),
        selfReview: CONVERGED_SELF_REVIEW,
      });
      const exhausted = makeState('ARCH_REVIEW', {
        architecture: { ...ARCHITECTURE_DECISION, reviewCompletion: 'review_exhausted' },
        reviewAssurance: architectureAssurance({
          subjectDigest: ARCHITECTURE_DECISION.digest,
          status: 'consumed',
          capturedVerdict: 'changes_requested',
        }),
        selfReview: CONVERGED_SELF_REVIEW,
      });
      const ctx = { ...baseCtx, digest: hashText };
      const acceptedResult = executeReviewDecision(
        accepted,
        { verdict: 'approve', rationale: 'approved', decisionIdentity: reviewerIdentity },
        ctx,
      );
      const exhaustedResult = executeReviewDecision(
        exhausted,
        {
          verdict: 'approve_with_governance_override',
          rationale: 'approved',
          decisionIdentity: reviewerIdentity,
        },
        ctx,
      );
      expect(acceptedResult.kind).toBe('ok');
      expect(exhaustedResult.kind).toBe('ok');
      if (acceptedResult.kind === 'ok' && exhaustedResult.kind === 'ok') {
        const acceptedId = acceptedResult.state.architecture?.approvalCertificate?.certificateId;
        const exhaustedId = exhaustedResult.state.architecture?.approvalCertificate?.certificateId;
        expect(acceptedId).toBeDefined();
        expect(exhaustedId).toBeDefined();
        expect(acceptedId).not.toBe(exhaustedId);
      }
    });

    it('changes_requested at ARCH_REVIEW clears selfReview', () => {
      const approvedArchitecture = {
        ...ARCHITECTURE_DECISION,
        approvalCertificate: {
          flow: 'architecture' as const,
          authorityDigest: ARCHITECTURE_DECISION.digest,
          claimDeclarationsDigest: 'claims-digest',
          decisionAttestationDigest: 'decision-digest',
          approvedAt: FIXED_TIME,
          approvedBy: 'reviewer',
          certificateId: '00000000-0000-4000-8000-000000000001',
          reviewBinding: {
            kind: 'current_review' as const,
            reviewObligationId: '00000000-0000-4000-8000-000000000002',
            reviewEvidenceDigest: 'review-evidence-digest',
            reviewedSubjectDigest: ARCHITECTURE_DECISION.digest,
          },
        },
      };
      const state = makeState('ARCH_REVIEW', {
        architecture: approvedArchitecture,
        selfReview: CONVERGED_SELF_REVIEW,
      });
      const result = executeReviewDecision(
        state,
        {
          verdict: 'changes_requested',
          rationale: 'Needs work',
          decisionIdentity: reviewerIdentity,
        },
        baseCtx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.selfReview).toBeNull();
        // architecture should still be present
        expect(result.state.architecture).not.toBeNull();
        expect(result.state.architecture?.approvalCertificate).toBeUndefined();
        expect(result.state.architecture?.reviewCompletion).toBe('pending');
      }
    });

    it('changes_requested does NOT trigger four-eyes check (verdict gate)', () => {
      // Use regulated policy with allowSelfApproval=false
      // changes_requested by same person as initiator should NOT be blocked
      const state = makeState('PLAN_REVIEW', {
        plan: { ...PLAN_RECORD, reviewCompletion: 'reviewer_accepted' },
        selfReview: CONVERGED_SELF_REVIEW,
        initiatedBy: 'same-person',
        initiatedByIdentity: { ...initiatorIdentity, actorId: 'same-person' },
      });
      const result = executeReviewDecision(
        state,
        {
          verdict: 'changes_requested',
          rationale: 'Needs changes',
          decisionIdentity: { ...reviewerIdentity, actorId: 'same-person' },
        },
        { ...baseCtx, policy: withPolicy({ allowSelfApproval: false }) },
      );
      // Should NOT be blocked (four-eyes only applies to approve)
      expect(result.kind).toBe('ok');
    });

    it('P34: minimumActorAssuranceForApproval=claim_validated blocks best_effort actor', () => {
      const state = makeState('EVIDENCE_REVIEW', {
        implementation: IMPL_EVIDENCE,
        implReview: APPROVED_IMPL_REVIEW,
        plan: { ...PLAN_RECORD, reviewCompletion: 'reviewer_accepted' },
        initiatedBy: 'initiator',
        initiatedByIdentity: initiatorIdentity,
      });
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve',
          rationale: 'ok',
          decisionIdentity: { ...reviewerIdentity, actorAssurance: 'best_effort' as const },
        },
        {
          ...baseCtx,
          policy: withPolicy({
            minimumActorAssuranceForApproval: 'claim_validated',
          }),
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
        implReview: APPROVED_IMPL_REVIEW,
        plan: { ...PLAN_RECORD, reviewCompletion: 'reviewer_accepted' },
        initiatedBy: 'initiator',
        initiatedByIdentity: initiatorIdentity,
      });
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve',
          rationale: 'ok',
          decisionIdentity: { ...reviewerIdentity, actorAssurance: 'claim_validated' as const },
        },
        {
          ...baseCtx,
          policy: withPolicy({
            minimumActorAssuranceForApproval: 'idp_verified',
          }),
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
        implReview: APPROVED_IMPL_REVIEW,
        plan: { ...PLAN_RECORD, reviewCompletion: 'reviewer_accepted' },
        initiatedBy: 'initiator',
        initiatedByIdentity: initiatorIdentity,
      });
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve',
          rationale: 'ok',
          decisionIdentity: { ...reviewerIdentity, actorAssurance: 'claim_validated' as const },
        },
        {
          ...baseCtx,
          policy: withPolicy({
            minimumActorAssuranceForApproval: 'claim_validated',
          }),
        },
      );
      expect(result.kind).toBe('ok');
    });

    it('blocks final approval for a completed mutation episode not bound to implementation evidence', () => {
      const state = makeState('EVIDENCE_REVIEW', {
        implementation: IMPL_EVIDENCE,
        implReview: APPROVED_IMPL_REVIEW,
        plan: { ...PLAN_RECORD, reviewCompletion: 'reviewer_accepted' },
        mutationEpisodes: [
          {
            episodeId: '00000000-0000-4000-8000-000000000011',
            hostCallId: 'post-review-edit',
            toolName: 'apply_patch',
            runtimeInstanceId: '00000000-0000-4000-8000-000000000012',
            leaseGeneration: 1,
            authorizedAt: FIXED_TIME,
            status: 'completed',
            completedAt: FIXED_TIME,
            outcome: 'success',
            implementationDigest: null,
            evidenceStatus: 'ineligible',
          },
        ],
      });

      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve',
          rationale: 'approve stale subject',
          decisionIdentity: reviewerIdentity,
        },
        baseCtx,
      );

      expect(result).toMatchObject({ kind: 'blocked', code: 'MUTATION_EPISODE_BINDING_REQUIRED' });
    });

    it('blocks final approval for a host mutation dispatched without a completion outcome', () => {
      const state = makeState('EVIDENCE_REVIEW', {
        implementation: IMPL_EVIDENCE,
        implReview: APPROVED_IMPL_REVIEW,
        plan: { ...PLAN_RECORD, reviewCompletion: 'reviewer_accepted' },
        mutationEpisodes: [
          {
            episodeId: '00000000-0000-4000-8000-000000000015',
            hostCallId: 'pending-host-edit',
            toolName: 'edit',
            runtimeInstanceId: '00000000-0000-4000-8000-000000000016',
            leaseGeneration: 1,
            authorizedAt: FIXED_TIME,
            status: 'dispatch_authorized',
            completedAt: null,
            outcome: null,
            implementationDigest: null,
            evidenceStatus: 'ineligible',
          },
        ],
      });

      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve',
          rationale: 'approve pending subject',
          decisionIdentity: reviewerIdentity,
        },
        baseCtx,
      );

      expect(result).toMatchObject({ kind: 'blocked', code: 'MUTATION_EPISODE_BINDING_REQUIRED' });
    });

    it('allows final approval after a fenced unknown-outcome resolution and fresh review evidence', () => {
      const state = makeState('EVIDENCE_REVIEW', {
        implementation: { ...IMPL_EVIDENCE, executedAt: '2026-02-01T00:00:00.000Z' },
        implReview: APPROVED_IMPL_REVIEW,
        plan: { ...PLAN_RECORD, reviewCompletion: 'reviewer_accepted' },
        mutationEpisodes: [
          {
            episodeId: '00000000-0000-4000-8000-000000000017',
            hostCallId: 'crashed-host-edit',
            toolName: 'edit',
            runtimeInstanceId: '00000000-0000-4000-8000-000000000018',
            leaseGeneration: 1,
            authorizedAt: FIXED_TIME,
            status: 'dispatch_authorized',
            completedAt: null,
            outcome: null,
            implementationDigest: null,
            evidenceStatus: 'ineligible',
          },
        ],
        mutationEpisodeResolutions: [
          {
            resolutionId: '00000000-0000-4000-8000-000000000019',
            hostCallId: 'crashed-host-edit',
            status: 'reconciled_after_unknown_outcome',
            basis: 'worktree_recapture',
            resolvedAt: '2026-01-15T00:00:00.000Z',
            resolvingRuntimeInstanceId: '00000000-0000-4000-8000-000000000020',
            resolvingLeaseGeneration: 2,
          },
        ],
      });

      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve',
          rationale: 'approve recaptured subject',
          decisionIdentity: reviewerIdentity,
        },
        baseCtx,
      );

      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') expect(result.state.phase).toBe('EXPORT_READY');
    });

    it('does not block final approval for a historical episode bound stale by a later implementation', () => {
      const state = makeState('EVIDENCE_REVIEW', {
        implementation: IMPL_EVIDENCE,
        implReview: APPROVED_IMPL_REVIEW,
        plan: { ...PLAN_RECORD, reviewCompletion: 'reviewer_accepted' },
        mutationEpisodes: [
          {
            episodeId: '00000000-0000-4000-8000-000000000013',
            hostCallId: 'prior-implementation-edit',
            toolName: 'apply_patch',
            runtimeInstanceId: '00000000-0000-4000-8000-000000000014',
            leaseGeneration: 1,
            authorizedAt: FIXED_TIME,
            status: 'completed',
            completedAt: FIXED_TIME,
            outcome: 'success',
            implementationDigest: 'previous-implementation-digest',
            evidenceStatus: 'stale',
          },
        ],
      });

      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve',
          rationale: 'approve current subject',
          decisionIdentity: reviewerIdentity,
        },
        baseCtx,
      );

      expect(result.kind).toBe('ok');
    });

    it('P34: minimumActorAssuranceForApproval=idp_verified allows idp_verified actor', () => {
      const state = makeState('EVIDENCE_REVIEW', {
        implementation: IMPL_EVIDENCE,
        implReview: APPROVED_IMPL_REVIEW,
        plan: { ...PLAN_RECORD, reviewCompletion: 'reviewer_accepted' },
        initiatedBy: 'initiator',
        initiatedByIdentity: initiatorIdentity,
      });
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve',
          rationale: 'ok',
          decisionIdentity: { ...reviewerIdentity, actorAssurance: 'idp_verified' as const },
        },
        {
          ...baseCtx,
          policy: withPolicy({
            minimumActorAssuranceForApproval: 'idp_verified',
          }),
        },
      );
      expect(result.kind).toBe('ok');
    });

    it('P34: minimumActorAssuranceForApproval absent → no assurance check (else-if gate)', () => {
      const state = makeState('EVIDENCE_REVIEW', {
        implementation: IMPL_EVIDENCE,
        implReview: APPROVED_IMPL_REVIEW,
        plan: { ...PLAN_RECORD, reviewCompletion: 'reviewer_accepted' },
        initiatedBy: 'initiator',
        initiatedByIdentity: initiatorIdentity,
      });
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve',
          rationale: 'ok',
          decisionIdentity: { ...reviewerIdentity, actorAssurance: 'best_effort' as const },
        },
        {
          ...baseCtx,
          policy: withPolicy({
            // No assurance threshold is set.
          }),
        },
      );
      expect(result.kind).toBe('ok');
    });

    it('approve at PLAN_REVIEW does NOT modify architecture (phase guard)', () => {
      const state = makeState('PLAN_REVIEW', {
        plan: { ...PLAN_RECORD, reviewCompletion: 'reviewer_accepted' },
        selfReview: CONVERGED_SELF_REVIEW,
        reviewAssurance: planAssurance({
          subjectDigest: PLAN_RECORD.current.digest,
          status: 'consumed',
          capturedVerdict: 'accept',
        }),
      });
      const result = executeReviewDecision(
        state,
        { verdict: 'approve', rationale: 'ok', decisionIdentity: reviewerIdentity },
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
        plan: { ...PLAN_RECORD, reviewCompletion: 'reviewer_accepted' },
        selfReview: CONVERGED_SELF_REVIEW,
      });
      const planCycle = state.reviewCycles.plan;
      const result = executeReviewDecision(
        state,
        { verdict: 'changes_requested', rationale: 'rework', decisionIdentity: reviewerIdentity },
        baseCtx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.selfReview).toBeNull();
        expect(result.state.reviewDecision).toBeNull();
        expect(result.state.reviewCycles.plan).toBe(planCycle + 1);
      }
    });

    it('changes_requested at EVIDENCE_REVIEW clears implementation and implReview (survivor kill)', () => {
      const state = makeState('EVIDENCE_REVIEW', {
        implementation: IMPL_EVIDENCE,
        implReview: {
          iteration: 1,
          reviewCycle: 1,
          maxIterations: 3,
          prevDigest: IMPL_EVIDENCE.digest,
          currDigest: IMPL_EVIDENCE.digest,
          revisionDelta: 'none',
          verdict: 'accept',
          executedAt: FIXED_TIME,
        },
      });
      const implementationCycle = state.reviewCycles.implementation;
      const result = executeReviewDecision(
        state,
        { verdict: 'changes_requested', rationale: 'rework', decisionIdentity: reviewerIdentity },
        baseCtx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.implementation).toBeNull();
        expect(result.state.implValidation).toEqual([]);
        expect(result.state.implReview).toBeNull();
        expect(result.state.reviewDecision).toBeNull();
        expect(result.state.reviewCycles.implementation).toBe(implementationCycle + 1);
      }
    });

    it('changes_requested at ARCH_REVIEW clears selfReview (survivor kill)', () => {
      const state = makeState('ARCH_REVIEW', {
        architecture: { ...ARCHITECTURE_DECISION, reviewCompletion: 'review_exhausted' },
        selfReview: CONVERGED_SELF_REVIEW,
      });
      const architectureCycle = state.reviewCycles.architecture;
      const result = executeReviewDecision(
        state,
        { verdict: 'changes_requested', rationale: 'rework', decisionIdentity: reviewerIdentity },
        baseCtx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.selfReview).toBeNull();
        expect(result.state.architecture?.reviewCompletion).toBe('pending');
        expect(result.state.architecture?.approvalCertificate).toBeUndefined();
        // reset, not clear: the reviewed architecture survives.
        expect(result.state.architecture?.digest).toBe(ARCHITECTURE_DECISION.digest);
        // preserve: the human decision itself stays recorded at ARCH_REVIEW.
        expect(result.state.reviewDecision?.verdict).toBe('changes_requested');
        expect(result.state.reviewCycles.architecture).toBe(architectureCycle + 1);
      }
    });

    it('reject at PLAN_REVIEW preserves evidence at REJECTED (survivor kill)', () => {
      const state = makeState('PLAN_REVIEW', {
        ticket: ticketFixture('t', 'd'),
        plan: { ...PLAN_RECORD, reviewCompletion: 'reviewer_accepted' },
        selfReview: CONVERGED_SELF_REVIEW,
      });
      const result = executeReviewDecision(
        state,
        { verdict: 'reject', rationale: 'rejected', decisionIdentity: reviewerIdentity },
        baseCtx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.phase).toBe('REJECTED');
        expect(result.state.ticket).not.toBeNull();
        expect(result.state.plan).not.toBeNull();
        expect(result.state.selfReview).not.toBeNull();
        expect(result.state.reviewDecision?.verdict).toBe('reject');
      }
    });

    it('reject at ARCH_REVIEW preserves architecture and selfReview at REJECTED', () => {
      const state = makeState('ARCH_REVIEW', {
        architecture: ARCHITECTURE_DECISION,
        selfReview: CONVERGED_SELF_REVIEW,
      });
      const result = executeReviewDecision(
        state,
        { verdict: 'reject', rationale: 'rejected', decisionIdentity: reviewerIdentity },
        baseCtx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.phase).toBe('REJECTED');
        expect(result.state.architecture).not.toBeNull();
        expect(result.state.selfReview).not.toBeNull();
      }
    });

    it('a decision identity missing actorAssurance fails closed at the schema and rail boundaries', () => {
      const malformed = identityWithoutAssurance();
      // The persisted decision contract requires the assurance tier.
      expect(DecisionIdentity.safeParse(malformed).success).toBe(false);
      const state = makeState('PLAN_REVIEW', {
        initiatedByIdentity: initiatorIdentity,
      });
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve',
          rationale: 'ok',
          decisionIdentity: malformed,
        },
        {
          ...baseCtx,
          policy: withPolicy({ minimumActorAssuranceForApproval: 'claim_validated' }),
        },
      );
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') {
        expect(result.code).toBe('ACTOR_ASSURANCE_INSUFFICIENT');
        expect(result.reason).toContain('unknown');
        expect(result.reason).toContain('claim_validated');
      }
    });

    it('approve at non-ARCH_REVIEW phase does NOT mutate architecture status', () => {
      // Kills L122 mutant `if (true && state.architecture)`:
      // approve at PLAN_REVIEW with architecture present must leave it untouched.
      const state = makeState('PLAN_REVIEW', {
        initiatedByIdentity: initiatorIdentity,
        architecture: ARCHITECTURE_DECISION,
        plan: { ...PLAN_RECORD, reviewCompletion: 'reviewer_accepted' },
        selfReview: CONVERGED_SELF_REVIEW,
        reviewAssurance: planAssurance({
          subjectDigest: PLAN_RECORD.current.digest,
          status: 'consumed',
          capturedVerdict: 'accept',
        }),
      });
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve',
          rationale: 'ok',
          decisionIdentity: reviewerIdentity,
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

    it('excludes non-plan obligations from the plan certificate binding (blocks approval)', () => {
      const state = makeState('PLAN_REVIEW', {
        plan: { ...PLAN_RECORD, reviewCompletion: 'reviewer_accepted' },
        selfReview: CONVERGED_SELF_REVIEW,
        reviewAssurance: planAssurance({
          subjectDigest: PLAN_RECORD.current.digest,
          status: 'consumed',
          obligationType: 'architecture',
          capturedVerdict: 'accept',
        }),
      });
      const result = executeReviewDecision(
        state,
        { verdict: 'approve', rationale: 'ok', decisionIdentity: reviewerIdentity },
        baseCtx,
      );
      expect(result).toMatchObject({
        kind: 'blocked',
        code: 'PLAN_REVIEW_EVIDENCE_REQUIRED',
      });
      expect(state.plan?.approvalCertificate).toBeUndefined();
    });

    it('excludes pending obligations from the plan certificate binding (blocks approval)', () => {
      const state = makeState('PLAN_REVIEW', {
        plan: { ...PLAN_RECORD, reviewCompletion: 'reviewer_accepted' },
        selfReview: CONVERGED_SELF_REVIEW,
        reviewAssurance: planAssurance({
          subjectDigest: PLAN_RECORD.current.digest,
          status: 'pending',
          capturedVerdict: 'accept',
        }),
      });
      const result = executeReviewDecision(
        state,
        { verdict: 'approve', rationale: 'ok', decisionIdentity: reviewerIdentity },
        baseCtx,
      );
      expect(result).toMatchObject({
        kind: 'blocked',
        code: 'PLAN_REVIEW_EVIDENCE_REQUIRED',
      });
      expect(state.plan?.approvalCertificate).toBeUndefined();
    });

    it('blocks plan approval when the obligation invocation id links to no invocation (no rescue path)', () => {
      const base = planAssurance({
        subjectDigest: PLAN_RECORD.current.digest,
        status: 'fulfilled',
        findingsHash: 'd'.repeat(64),
        capturedVerdict: 'accept',
      });
      const state = makeState('PLAN_REVIEW', {
        plan: { ...PLAN_RECORD, reviewCompletion: 'reviewer_accepted' },
        selfReview: CONVERGED_SELF_REVIEW,
        reviewAssurance: {
          ...base,
          // The exact-subject obligation links to an invocation id that does
          // not exist; the invocation below carries the right obligationId —
          // the removed non-canonical fallback would have bound it.
          obligations: [{ ...base.obligations[0]!, invocationId: 'missing-invocation-id' }],
          invocations: [
            {
              ...base.invocations[0]!,
              obligationId: PLAN_OBLIGATION_ID,
              findingsHash: 'd'.repeat(64),
              capturedVerdict: 'accept',
            },
          ],
        },
      });
      const result = executeReviewDecision(
        state,
        { verdict: 'approve', rationale: 'ok', decisionIdentity: reviewerIdentity },
        baseCtx,
      );
      expect(result).toMatchObject({
        kind: 'blocked',
        code: 'PLAN_REVIEW_EVIDENCE_REQUIRED',
      });
      expect(state.plan?.approvalCertificate).toBeUndefined();
    });

    it('mints a review_exhausted_override binding when the last review covered the current subject', () => {
      const state = makeState('PLAN_REVIEW', {
        plan: { ...PLAN_RECORD, reviewCompletion: 'review_exhausted' },
        selfReview: CONVERGED_SELF_REVIEW,
        reviewAssurance: planAssurance({
          subjectDigest: PLAN_RECORD.current.digest,
          status: 'consumed',
          capturedVerdict: 'changes_requested',
          findingsHash: 'e'.repeat(64),
        }),
      });
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve_with_governance_override',
          rationale: 'override',
          decisionIdentity: reviewerIdentity,
        },
        baseCtx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.plan?.approvalCertificate?.reviewBinding).toEqual({
          kind: 'review_exhausted_override',
          lastReviewObligationId: PLAN_OBLIGATION_ID,
          lastReviewEvidenceDigest: 'e'.repeat(64),
          reviewedSubjectDigest: PLAN_RECORD.current.digest,
          approvedSubjectDigest: PLAN_RECORD.current.digest,
        });
      }
    });

    it('blocks an exhausted plan override when the last review covered a different subject (CE5 strict)', () => {
      const state = makeState('PLAN_REVIEW', {
        plan: { ...PLAN_RECORD, reviewCompletion: 'review_exhausted' },
        selfReview: CONVERGED_SELF_REVIEW,
        reviewAssurance: planAssurance({
          subjectDigest: 'digest-of-a-prior-plan-revision',
          status: 'consumed',
          capturedVerdict: 'changes_requested',
          findingsHash: 'e'.repeat(64),
        }),
      });
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve_with_governance_override',
          rationale: 'override',
          decisionIdentity: reviewerIdentity,
        },
        baseCtx,
      );
      expect(result).toMatchObject({
        kind: 'blocked',
        code: 'PLAN_REVIEW_OVERRIDE_SUBJECT_MISMATCH',
      });
      expect(state.plan?.approvalCertificate).toBeUndefined();
    });

    it('blocks an exhausted plan when the latest evidence captured accept (coherence)', () => {
      const state = makeState('PLAN_REVIEW', {
        plan: { ...PLAN_RECORD, reviewCompletion: 'review_exhausted' },
        selfReview: CONVERGED_SELF_REVIEW,
        reviewAssurance: planAssurance({
          subjectDigest: PLAN_RECORD.current.digest,
          status: 'consumed',
          capturedVerdict: 'accept',
          findingsHash: 'e'.repeat(64),
        }),
      });
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve_with_governance_override',
          rationale: 'override',
          decisionIdentity: reviewerIdentity,
        },
        baseCtx,
      );
      expect(result).toMatchObject({
        kind: 'blocked',
        code: 'PLAN_REVIEW_EVIDENCE_CONTRADICTS_COMPLETION',
      });
      expect(state.plan?.approvalCertificate).toBeUndefined();
    });

    it.each(['unable_to_review', 'unknown_verdict'])(
      'blocks an exhausted plan when evidence captured %s',
      (capturedVerdict) => {
        const state = makeState('PLAN_REVIEW', {
          plan: { ...PLAN_RECORD, reviewCompletion: 'review_exhausted' },
          selfReview: CONVERGED_SELF_REVIEW,
          reviewAssurance: planAssurance({
            subjectDigest: PLAN_RECORD.current.digest,
            status: 'consumed',
            capturedVerdict,
            findingsHash: 'e'.repeat(64),
          }),
        });
        const result = executeReviewDecision(
          state,
          {
            verdict: 'approve_with_governance_override',
            rationale: 'override',
            decisionIdentity: reviewerIdentity,
          },
          baseCtx,
        );
        expect(result).toMatchObject({
          kind: 'blocked',
          code: 'PLAN_REVIEW_EVIDENCE_CONTRADICTS_COMPLETION',
        });
        expect(state.plan?.approvalCertificate).toBeUndefined();
      },
    );

    it('blocks an exhausted plan when the evidence carries no captured verdict (CE1)', () => {
      const state = makeState('PLAN_REVIEW', {
        plan: { ...PLAN_RECORD, reviewCompletion: 'review_exhausted' },
        selfReview: CONVERGED_SELF_REVIEW,
        reviewAssurance: planAssurance({
          subjectDigest: PLAN_RECORD.current.digest,
          status: 'consumed',
          findingsHash: 'e'.repeat(64),
        }),
      });
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve_with_governance_override',
          rationale: 'override',
          decisionIdentity: reviewerIdentity,
        },
        baseCtx,
      );
      expect(result).toMatchObject({
        kind: 'blocked',
        code: 'PLAN_REVIEW_EVIDENCE_REQUIRED',
      });
      expect(state.plan?.approvalCertificate).toBeUndefined();
    });

    it('blocks a reviewer_accepted plan when the evidence captured a non-accept verdict (coherence)', () => {
      const state = makeState('PLAN_REVIEW', {
        plan: { ...PLAN_RECORD, reviewCompletion: 'reviewer_accepted' },
        selfReview: CONVERGED_SELF_REVIEW,
        reviewAssurance: planAssurance({
          subjectDigest: PLAN_RECORD.current.digest,
          status: 'consumed',
          capturedVerdict: 'changes_requested',
          findingsHash: 'e'.repeat(64),
        }),
      });
      const result = executeReviewDecision(
        state,
        { verdict: 'approve', rationale: 'ok', decisionIdentity: reviewerIdentity },
        baseCtx,
      );
      expect(result).toMatchObject({
        kind: 'blocked',
        code: 'PLAN_REVIEW_EVIDENCE_CONTRADICTS_COMPLETION',
      });
      expect(state.plan?.approvalCertificate).toBeUndefined();
    });

    it('skips the plan evidence gate outside PLAN_REVIEW (phase guard)', () => {
      const state = makeState('EVIDENCE_REVIEW', {
        ticket: ticketFixture('t', 'd'),
        plan: { ...PLAN_RECORD, reviewCompletion: 'pending' },
        selfReview: CONVERGED_SELF_REVIEW,
        implementation: IMPL_EVIDENCE,
        implReview: {
          iteration: 1,
          reviewCycle: 1,
          maxIterations: 3,
          prevDigest: null,
          currDigest: IMPL_EVIDENCE.digest,
          revisionDelta: 'none',
          verdict: 'accept',
          executedAt: FIXED_TIME,
        },
      });
      const result = executeReviewDecision(
        state,
        { verdict: 'approve', rationale: 'ok', decisionIdentity: reviewerIdentity },
        baseCtx,
      );
      // The plan gate is phase-guarded off; a pending plan completion cannot
      // block an EVIDENCE_REVIEW approval.
      expect(result.kind).toBe('ok');
    });

    it('blocks an exhausted plan when the latest plan obligation is still pending (no completed evidence)', () => {
      const state = makeState('PLAN_REVIEW', {
        plan: { ...PLAN_RECORD, reviewCompletion: 'review_exhausted' },
        selfReview: CONVERGED_SELF_REVIEW,
        reviewAssurance: planAssurance({
          subjectDigest: PLAN_RECORD.current.digest,
          status: 'pending',
          capturedVerdict: 'changes_requested',
          findingsHash: 'e'.repeat(64),
        }),
      });
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve_with_governance_override',
          rationale: 'override',
          decisionIdentity: reviewerIdentity,
        },
        baseCtx,
      );
      // A pending obligation is not completed review evidence — the override
      // path must not bind it, no matter how coherent its linkage looks.
      expect(result).toMatchObject({
        kind: 'blocked',
        code: 'PLAN_REVIEW_EVIDENCE_REQUIRED',
      });
      expect(state.plan?.approvalCertificate).toBeUndefined();
    });

    it('blocks plan approval when the canonical invocation back-references a different obligation (adversarial)', () => {
      const base = planAssurance({
        subjectDigest: PLAN_RECORD.current.digest,
        status: 'consumed',
        capturedVerdict: 'accept',
        findingsHash: 'e'.repeat(64),
      });
      const state = makeState('PLAN_REVIEW', {
        plan: { ...PLAN_RECORD, reviewCompletion: 'reviewer_accepted' },
        selfReview: CONVERGED_SELF_REVIEW,
        reviewAssurance: {
          ...base,
          // Correct invocationId, incoherent obligation back-reference.
          invocations: [
            { ...base.invocations[0]!, obligationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' },
          ],
        },
      });
      const result = executeReviewDecision(
        state,
        { verdict: 'approve', rationale: 'ok', decisionIdentity: reviewerIdentity },
        baseCtx,
      );
      expect(result).toMatchObject({
        kind: 'blocked',
        code: 'PLAN_REVIEW_EVIDENCE_REQUIRED',
      });
      expect(state.plan?.approvalCertificate).toBeUndefined();
    });

    it('blocks plan approval when the canonical invocation back-references a different obligation type (adversarial)', () => {
      const base = planAssurance({
        subjectDigest: PLAN_RECORD.current.digest,
        status: 'consumed',
        capturedVerdict: 'accept',
        findingsHash: 'e'.repeat(64),
      });
      const state = makeState('PLAN_REVIEW', {
        plan: { ...PLAN_RECORD, reviewCompletion: 'reviewer_accepted' },
        selfReview: CONVERGED_SELF_REVIEW,
        reviewAssurance: {
          ...base,
          invocations: [{ ...base.invocations[0]!, obligationType: 'architecture' as const }],
        },
      });
      const result = executeReviewDecision(
        state,
        { verdict: 'approve', rationale: 'ok', decisionIdentity: reviewerIdentity },
        baseCtx,
      );
      expect(result).toMatchObject({
        kind: 'blocked',
        code: 'PLAN_REVIEW_EVIDENCE_REQUIRED',
      });
      expect(state.plan?.approvalCertificate).toBeUndefined();
    });
  });
});
