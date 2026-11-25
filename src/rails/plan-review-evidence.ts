/**
 * @module rails/plan-review-evidence
 * @description Plan approval certificate authority for the /review-decision
 * rail: the plan evidence gate, the certificate binding projection, and the
 * certificate minting. Gate and mint share ONE evidence resolution per
 * decision operation — the binding is a pure projection of the gate-passed
 * resolution, never a second resolver run.
 *
 * CE5 hardening (architecture parity with a stricter override rule):
 *
 * - `reviewer_accepted`: exact-subject, canonically linked evidence with
 *   `capturedVerdict === 'accept'` mints a `current_review` binding.
 * - `review_exhausted`: the latest bound evidence must carry
 *   `changes_requested`
 *   verdict AND must have reviewed exactly the subject being approved
 *   (`reviewedSubjectDigest === approvedSubjectDigest`) — an unreviewed
 *   revision is never releasable by an override.
 * - Anything else fails closed. Legacy evidence without a captured verdict is
 *   never manufactured at the authority boundary.
 */

import type { SessionState } from '../state/schema.js';
import type { ReviewDecision } from '../state/evidence.js';
import type { ReviewCompletion } from '../state/evidence-primitives.js';
import type { PlanApprovalCertificate, ReviewBinding } from '../state/proofgraph-approval.js';
import { emptyClaimDeclarations } from '../state/proofgraph-approval.js';
import { planApprovalCertificateIdentity } from '../state/proofgraph-plan-certificate.js';
import { planApprovalContextOf } from '../state/proofgraph-approval-context.js';
import type { RailBlocked, RailContext } from './types.js';
import { blocked } from '../config/reasons.js';
import { canonicalJsonStringify } from '../shared/canonical-json.js';
import { hashText } from '../shared/hashing.js';
import type {
  PlanReviewSubjectAuthority,
  ResolvedPlanReviewEvidence,
} from './review-evidence-resolution.js';

export function enforcePlanReviewEvidence(
  state: SessionState,
  resolution: ResolvedPlanReviewEvidence | null,
): RailBlocked | null {
  if (state.phase !== 'PLAN_REVIEW') return null;
  const plan = state.plan;
  const completion: ReviewCompletion = plan?.reviewCompletion ?? 'pending';
  if (completion === 'pending') {
    return blockedPlanEvidenceRequired(completion, 'missing', 'unavailable');
  }
  if (!resolution) {
    return blockedPlanEvidenceRequired(completion, 'missing', 'unavailable');
  }
  if (resolution.reviewerVerdict === undefined) {
    return blockedPlanEvidenceRequired(completion, 'resolved', 'missing');
  }
  // The claim-declaration binding is part of the evidence authority: evidence
  // that never froze the reviewed claim set cannot certify the current claims.
  if (resolution.claimDeclarationsDigest === undefined) {
    return blockedPlanEvidenceRequired(completion, 'resolved', 'claim_declarations_missing');
  }
  if (resolution.claimDeclarationsDigest !== planClaimDeclarationsDigest(plan)) {
    return blockedPlanEvidenceRequired(completion, 'resolved', 'claim_declarations_mismatch');
  }
  if (completion === 'reviewer_accepted') {
    return enforceAcceptedPlanVerdict(resolution.reviewerVerdict);
  }
  return enforceExhaustedPlanVerdict(plan, resolution.reviewerVerdict, resolution);
}

/** Canonical digest of the claim declarations currently bound to a plan authority. */
export function planClaimDeclarationsDigest(plan: SessionState['plan']): string {
  return hashText(
    canonicalJsonStringify(plan?.claimDeclarations ?? emptyClaimDeclarations('plan')),
  );
}

function blockedPlanEvidenceRequired(
  reviewCompletion: ReviewCompletion,
  reviewEvidence: string,
  capturedVerdict: string,
): RailBlocked {
  return blocked('PLAN_REVIEW_EVIDENCE_REQUIRED', {
    reviewCompletion,
    reviewEvidence,
    capturedVerdict,
  });
}

function enforceAcceptedPlanVerdict(capturedVerdict: string): RailBlocked | null {
  if (capturedVerdict !== 'accept') {
    return blocked('PLAN_REVIEW_EVIDENCE_CONTRADICTS_COMPLETION', {
      reviewCompletion: 'reviewer_accepted',
      capturedVerdict,
    });
  }
  return null;
}

function enforceExhaustedPlanVerdict(
  plan: SessionState['plan'],
  capturedVerdict: string,
  resolution: ResolvedPlanReviewEvidence,
): RailBlocked | null {
  if (capturedVerdict !== 'changes_requested') {
    return blocked('PLAN_REVIEW_EVIDENCE_CONTRADICTS_COMPLETION', {
      reviewCompletion: 'review_exhausted',
      capturedVerdict,
    });
  }
  if (!plan || resolution.subjectDigest !== plan.current.digest) {
    return blocked('PLAN_REVIEW_OVERRIDE_SUBJECT_MISMATCH', {
      reviewedSubjectDigest: resolution.subjectDigest,
      approvedSubjectDigest: plan?.current.digest ?? 'missing',
    });
  }
  return null;
}

/**
 * Build the certificate binding from the gate-resolved evidence and the
 * recorded completion — a pure projection, never a second resolution.
 */
export function buildPlanReviewBinding(
  completion: ReviewCompletion,
  resolution: ResolvedPlanReviewEvidence,
  approvedSubjectDigest: string,
): ReviewBinding | null {
  if (completion === 'reviewer_accepted') {
    return {
      kind: 'current_review',
      reviewObligationId: resolution.obligationId,
      reviewEvidenceDigest: resolution.findingsHash,
      reviewedSubjectDigest: resolution.subjectDigest,
    };
  }
  if (completion === 'review_exhausted') {
    return {
      kind: 'review_exhausted_override',
      lastReviewObligationId: resolution.obligationId,
      lastReviewEvidenceDigest: resolution.findingsHash,
      reviewedSubjectDigest: resolution.subjectDigest,
      approvedSubjectDigest,
    };
  }
  return null;
}

/**
 * Bind the human approval to the exact immutable plan version and its claims.
 * The certificate digest deliberately excludes itself and uses the injected
 * digest authority so rail callers retain control of cryptographic hashing.
 * The review binding block co-signs the certificate identity: relabeling the
 * kind or swapping the reviewed digest changes the certificateId.
 */
/**
 * The exact plan-review authority tuple for the current plan record. Reused by
 * the explicit rail and the automatic plan-approval certificate minting, so
 * both resolve against the same authority.
 */
export function planReviewSubjectAuthority(
  plan: NonNullable<SessionState['plan']>,
): PlanReviewSubjectAuthority {
  return {
    subjectDigest: plan.current.digest,
    planVersion: plan.current.planVersion,
    claimDeclarationsDigest: planClaimDeclarationsDigest(plan),
  };
}

/**
 * Bind an explicit decision to the exact immutable plan version and its claims.
 * The certificate deliberately carries no `approvedBy`: the identity lives in
 * the attested decision, and its digest is recomputed at parse time.
 */
export function createPlanApprovalCertificate(
  state: SessionState,
  plan: NonNullable<SessionState['plan']>,
  decision: ReviewDecision,
  reviewBinding: ReviewBinding,
): PlanApprovalCertificate {
  const context = planApprovalContextOf(state);
  const claimDeclarationsDigest = planClaimDeclarationsDigest(plan);
  const approvedAt = decision.decidedAt;
  const approvalAttestation = {
    kind: 'explicit_decision' as const,
    decision,
    flowguardSessionId: context.flowguardSessionId,
    bindingDigest: context.bindingDigest,
    policyHash: context.policyHash,
    policyHashVersion: context.policyHashVersion,
  };
  const decisionAttestationDigest = hashText(canonicalJsonStringify(approvalAttestation));
  return {
    schemaVersion: 'plan-approval-certificate.v1',
    flow: 'plan',
    authorityDigest: plan.current.digest,
    claimDeclarationsDigest,
    decisionAttestationDigest,
    approvedAt,
    certificateId: planApprovalCertificateIdentity({
      authorityDigest: plan.current.digest,
      claimDeclarationsDigest,
      decisionAttestationDigest,
      planVersion: plan.current.planVersion,
      planRecordDigest: plan.current.recordDigest,
      reviewBinding,
      approvedAt,
    }),
    planVersion: plan.current.planVersion,
    planRecordDigest: plan.current.recordDigest,
    reviewBinding,
    approvalAttestation,
  };
}

/**
 * Mint the policy-authorized automatic plan-approval certificate. This is the
 * ONLY automatic certificate authority: it exists exclusively under a frozen
 * policy that permits automatic gates (`requireHumanGates === false`), and it
 * certifies an accepted review binding — never an exhausted override.
 */
export function createAutomaticPlanApprovalCertificate(
  state: SessionState,
  plan: NonNullable<SessionState['plan']>,
  ctx: RailContext,
  reviewBinding: ReviewBinding,
): PlanApprovalCertificate | null {
  if (plan.reviewCompletion !== 'reviewer_accepted') return null;
  if (state.policySnapshot.requireHumanGates) return null;
  const context = planApprovalContextOf(state);
  const claimDeclarationsDigest = planClaimDeclarationsDigest(plan);
  const approvedAt = ctx.now();
  const approvalAttestation = {
    kind: 'policy_auto' as const,
    decidedAt: approvedAt,
    flowguardSessionId: context.flowguardSessionId,
    bindingDigest: context.bindingDigest,
    policyHash: context.policyHash,
    policyHashVersion: context.policyHashVersion,
  };
  const decisionAttestationDigest = hashText(canonicalJsonStringify(approvalAttestation));
  return {
    schemaVersion: 'plan-approval-certificate.v1',
    flow: 'plan',
    authorityDigest: plan.current.digest,
    claimDeclarationsDigest,
    decisionAttestationDigest,
    approvedAt,
    certificateId: planApprovalCertificateIdentity({
      authorityDigest: plan.current.digest,
      claimDeclarationsDigest,
      decisionAttestationDigest,
      planVersion: plan.current.planVersion,
      planRecordDigest: plan.current.recordDigest,
      reviewBinding,
      approvedAt,
    }),
    planVersion: plan.current.planVersion,
    planRecordDigest: plan.current.recordDigest,
    reviewBinding,
    approvalAttestation,
  };
}

export function planCertificatePatch(
  state: SessionState,
  decision: ReviewDecision,
  planReviewEvidence: ResolvedPlanReviewEvidence | null,
): Partial<Pick<SessionState, 'plan'>> {
  if (state.phase !== 'PLAN_REVIEW' || !state.plan || state.plan.approvalCertificate) return {};
  const completion: ReviewCompletion = state.plan.reviewCompletion ?? 'pending';
  const binding = planReviewEvidence
    ? buildPlanReviewBinding(completion, planReviewEvidence, state.plan.current.digest)
    : null;
  if (!binding) return {};
  return {
    plan: {
      ...state.plan,
      approvalCertificate: createPlanApprovalCertificate(state, state.plan, decision, binding),
    },
  };
}
