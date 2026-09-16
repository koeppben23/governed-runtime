import { describe, expect, it } from 'vitest';
import { executeReviewDecision } from './review-decision.js';
import { makeState, IMPL_EVIDENCE, PLAN_RECORD, FIXED_TIME } from '../fixtures.js';
import { TEAM_POLICY } from '../config/policy.js';
import type { ReviewAssuranceState } from '../state/evidence-review.js';
import { assuranceChain } from './review-decision-test-helpers.js';
import { hashText } from '../shared/hashing.js';
import { canonicalJsonStringify } from '../shared/canonical-json.js';
import { emptyClaimDeclarations } from '../state/proofgraph-approval.js';

const baseCtx = {
  now: () => FIXED_TIME,
  digest: (text: string) => `sha256:${text.length}`,
  policy: TEAM_POLICY,
};

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
      iteration: input.iteration,
      createdAt: input.createdAt,
      invocationId: input.invocationId ?? PLAN_INVOCATION_ID,
      findingsHash: input.findingsHash ?? 'a'.repeat(64),
      capturedVerdict: input.capturedVerdict,
      // Default: the empty declaration set (most plan-approval tests carry no claims).
      claimDeclarationsDigest:
        input.claimDeclarationsDigest ??
        hashText(canonicalJsonStringify(emptyClaimDeclarations('plan'))),
      consumedByObligationId: input.status === 'consumed' ? obligationId : null,
    },
  ]);
}

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

describe('review-decision rail', () => {
  // ─── GOVERNANCE OVERRIDE GATE ─────────────────────────────────────────

  describe('governance override gate', () => {
    it('blocks plain approve at an exhausted plan gate with GOVERNANCE_OVERRIDE_REQUIRED', () => {
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
        { verdict: 'approve', rationale: 'plain approval', decisionIdentity: reviewerIdentity },
        baseCtx,
      );
      expect(result).toMatchObject({ kind: 'blocked', code: 'GOVERNANCE_OVERRIDE_REQUIRED' });
      expect(state.plan?.approvalCertificate).toBeUndefined();
    });

    it('blocks a governance override at a normal plan gate with GOVERNANCE_OVERRIDE_NOT_REQUIRED', () => {
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
        {
          verdict: 'approve_with_governance_override',
          rationale: 'unnecessary override',
          decisionIdentity: reviewerIdentity,
        },
        baseCtx,
      );
      expect(result).toMatchObject({ kind: 'blocked', code: 'GOVERNANCE_OVERRIDE_NOT_REQUIRED' });
      expect(state.plan?.approvalCertificate).toBeUndefined();
    });

    it('blocks a governance override at an exhausted evidence gate without an implementation review result', () => {
      const state = makeState('EVIDENCE_REVIEW', {
        plan: { ...PLAN_RECORD, reviewCompletion: 'reviewer_accepted' },
        implementation: IMPL_EVIDENCE,
        implementationRework: { rejectedDigest: IMPL_EVIDENCE.digest, exhausted: true },
      });
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve_with_governance_override',
          rationale: 'override without review evidence',
          decisionIdentity: reviewerIdentity,
        },
        baseCtx,
      );
      expect(result).toMatchObject({
        kind: 'blocked',
        code: 'IMPLEMENTATION_REVIEW_EVIDENCE_REQUIRED',
      });
    });

    it('allows a governance override at an exhausted evidence gate when the reviewed subject matches', () => {
      const state = makeState('EVIDENCE_REVIEW', {
        plan: { ...PLAN_RECORD, reviewCompletion: 'reviewer_accepted' },
        implementation: IMPL_EVIDENCE,
        implementationRework: { rejectedDigest: IMPL_EVIDENCE.digest, exhausted: true },
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
        {
          verdict: 'approve_with_governance_override',
          rationale: 'override on the reviewed revision',
          decisionIdentity: reviewerIdentity,
        },
        baseCtx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.phase).toBe('EXPORT_READY');
        expect(result.state.reviewDecision?.verdict).toBe('approve_with_governance_override');
      }
    });

    it('blocks a normal approve when the implementation review covered a different revision', () => {
      const state = makeState('EVIDENCE_REVIEW', {
        plan: { ...PLAN_RECORD, reviewCompletion: 'reviewer_accepted' },
        implementation: IMPL_EVIDENCE,
        implReview: {
          iteration: 1,
          reviewCycle: 1,
          maxIterations: 3,
          prevDigest: null,
          currDigest: 'digest-of-another-implementation',
          revisionDelta: 'none',
          verdict: 'accept',
          executedAt: FIXED_TIME,
        },
      });
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve',
          rationale: 'approve stale review',
          decisionIdentity: reviewerIdentity,
        },
        baseCtx,
      );
      expect(result).toMatchObject({
        kind: 'blocked',
        code: 'IMPLEMENTATION_REVIEW_SUBJECT_MISMATCH',
      });
      if (result.kind === 'blocked') {
        expect(result.reason).toContain('digest-of-another-implementation');
        expect(result.reason).toContain(IMPL_EVIDENCE.digest);
      }
    });
  });
});
