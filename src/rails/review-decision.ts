/**
 * @module review-decision
 * @description /review-decision rail — human verdict at a User Gate.
 *
 * Works at all three User Gate phases:
 * - PLAN_REVIEW:     approve → VALIDATION, changes → PLAN, reject → TICKET
 * - EVIDENCE_REVIEW: approve → COMPLETE, changes → IMPLEMENTATION, reject → TICKET
 * - ARCH_REVIEW:     approve → ARCH_COMPLETE, changes → ARCHITECTURE, reject → READY
 *
 * Four-eyes principle enforcement (regulated mode):
 * For approval decisions only, when policy.allowSelfApproval === false,
 * the reviewer (decidedBy) MUST be different from the session initiator
 * (state.initiatedBy).
 * This satisfies MaRisk AT 7.2 (5) — separation of duties.
 *
 * State clearing patterns (FlowGuard-critical):
 *
 * | Gate            | Verdict            | Keep                    | Clear                                    |
 * |-----------------|--------------------|-------------------------|------------------------------------------|
 * | PLAN_REVIEW     | approve            | ticket, plan, selfReview| reviewDecision                           |
 * | PLAN_REVIEW     | changes_requested  | ticket, plan            | selfReview, reviewDecision               |
 * | PLAN_REVIEW     | reject             | ticket                  | plan, selfReview, validation, impl, ...  |
 * | EVIDENCE_REVIEW | approve            | everything              | (nothing — complete)                     |
 * | EVIDENCE_REVIEW | changes_requested  | ticket, plan, validation| impl, implReview, reviewDecision         |
 * | EVIDENCE_REVIEW | reject             | ticket                  | plan, selfReview, validation, impl, ...  |
 * | ARCH_REVIEW     | approve            | architecture, selfReview| (nothing — complete)                     |
 * | ARCH_REVIEW     | changes_requested  | architecture            | selfReview                               |
 * | ARCH_REVIEW     | reject             | (nothing)               | architecture, selfReview                 |
 *
 * @version v1
 */

import type { SessionState, Event } from '../state/schema.js';
import type {
  ReviewDecision,
  ReviewVerdict,
  ValidationResult,
  DecisionIdentity,
} from '../state/evidence.js';
import type {
  ArchitectureApprovalCertificate,
  PlanApprovalCertificate,
} from '../state/proofgraph-approval.js';
import { authorizedCriticalPlanClaimIds } from '../state/proofgraph-approval.js';
import { Command, isCommandAllowed } from '../machine/commands.js';
import { evaluate, evaluateWithEvent } from '../machine/evaluate.js';
import type { RailResult, RailBlocked, RailContext, TransitionRecord } from './types.js';
import { applyTransition } from './types.js';
import { blocked } from '../config/reasons.js';
import { compareActorIdentity, isAssuranceAtLeast } from '../identity/actor-info.js';
import { canonicalJsonStringify } from '../shared/canonical-json.js';
import { evaluateProofGraphGate } from '../audit/proofgraph/gate.js';

// ─── Input ────────────────────────────────────────────────────────────────────

/**
 * Input for /review-decision rail.
 *
 * P30: Includes decisionIdentity for regulated approval attribution.
 * The decidedBy field remains for backward compatibility;
 * decisionIdentity provides full provenance for audit and four-eyes proof.
 */
export interface ReviewDecisionInput {
  readonly verdict: ReviewVerdict;
  readonly rationale: string;
  readonly decidedBy: string;
  readonly decisionIdentity?: DecisionIdentity;
}

// ─── Verdict → Event mapping ──────────────────────────────────────────────────

const VERDICT_TO_EVENT: Record<ReviewVerdict, Event> = {
  approve: 'APPROVE',
  changes_requested: 'CHANGES_REQUESTED',
  reject: 'REJECT',
};

// ─── State Clearing ───────────────────────────────────────────────────────────

/**
 * State fields cleared on reject (from PLAN_REVIEW or EVIDENCE_REVIEW).
 * Everything downstream of TICKET is wiped — plan must be rebuilt from scratch.
 * Ticket itself is preserved (session returns to TICKET phase).
 */
const REJECT_CLEAR = {
  plan: null,
  selfReview: null,
  validation: [] as ValidationResult[],
  implValidation: [] as ValidationResult[],
  implementation: null,
  implReview: null,
  reviewDecision: null,
};

/**
 * State fields cleared on reject from PLAN_REVIEW.
 * Ticket is also cleared — user must re-enter ticket text.
 */
const REJECT_CLEAR_FROM_PLAN = {
  ticket: null,
  plan: null,
  selfReview: null,
  validation: [] as ValidationResult[],
  implValidation: [] as ValidationResult[],
  implementation: null,
  implReview: null,
  reviewDecision: null,
};

/**
 * State fields cleared on reject at ARCH_REVIEW.
 * Architecture flow is wiped — user returns to READY to choose a new flow.
 */
const ARCH_REJECT_CLEAR = {
  architecture: null,
  selfReview: null,
};

/**
 * Apply state clearing pattern based on gate + verdict.
 *
 * Clearing rules (FlowGuard-critical):
 * - approve: keep everything (state flows forward)
 * - changes_requested at PLAN_REVIEW: clear selfReview (fresh review loop)
 * - changes_requested at IMPL_REVIEW: cleared by handleChangesRequestedReview in implement.ts
 * - changes_requested at EVIDENCE_REVIEW: clear impl + implReview + reducedCeremony (re-implement)
 * - changes_requested at ARCH_REVIEW: clear selfReview (fresh review loop)
 * - reject at PLAN_REVIEW/EVIDENCE_REVIEW: clear everything downstream of TICKET
 * - reject at ARCH_REVIEW: clear architecture + selfReview (back to READY)
 *
 * reducedCeremony is revoked on any changes_requested that loops back to IMPLEMENTATION
 * because the prior TRIVIAL determination is invalidated by the review finding issues.
 */
function applyStateClearingPattern(state: SessionState, verdict: ReviewVerdict): SessionState {
  if (verdict === 'approve') {
    // At ARCH_REVIEW, set architecture status to "accepted" on approval
    if (state.phase === 'ARCH_REVIEW' && state.architecture) {
      return { ...state, architecture: { ...state.architecture, status: 'accepted' } };
    }
    return state;
  }

  if (verdict === 'reject') {
    if (state.phase === 'ARCH_REVIEW') {
      return { ...state, ...ARCH_REJECT_CLEAR };
    }
    if (state.phase === 'PLAN_REVIEW') {
      return { ...state, ...REJECT_CLEAR_FROM_PLAN };
    }
    return { ...state, ...REJECT_CLEAR, reducedCeremony: null };
  }

  // changes_requested
  if (state.phase === 'PLAN_REVIEW') {
    return { ...state, selfReview: null, reviewDecision: null };
  }
  if (state.phase === 'EVIDENCE_REVIEW') {
    return {
      ...state,
      implementation: null,
      implValidation: [],
      implReview: null,
      reducedCeremony: null,
      reviewDecision: null,
    };
  }
  if (state.phase === 'ARCH_REVIEW') {
    return {
      ...state,
      architecture: state.architecture
        ? { ...state.architecture, approvalCertificate: undefined }
        : null,
      selfReview: null,
    };
  }

  return state;
}

// ─── Identity Enforcement ─────────────────────────────────────────────────────

/**
 * Enforce four-eyes principle and assurance thresholds for approval decisions.
 *
 * Regulated mode (allowSelfApproval === false):
 * - Both initiator and reviewer must have structured identity.
 * - Neither may have actorSource 'unknown'.
 * - Initiator and reviewer actorId must differ (MaRisk AT 7.2 separation of duties).
 *
 * Assurance enforcement (P33 legacy + P34 explicit threshold):
 * - requireVerifiedActorsForApproval: true → minimum 'claim_validated'
 * - minimumActorAssuranceForApproval → explicit ordinal comparison via actor-info
 *
 * @returns RailBlocked if enforcement fails, null if approval may proceed.
 */
function verifyFourEyes(state: SessionState, input: ReviewDecisionInput): RailBlocked | null {
  if (!state.initiatedByIdentity) return blocked('DECISION_IDENTITY_REQUIRED');
  if (!input.decisionIdentity) return blocked('DECISION_IDENTITY_REQUIRED');
  if (state.initiatedByIdentity.actorSource === 'unknown')
    return blocked('REGULATED_ACTOR_UNKNOWN', { role: 'initiator' });
  if (input.decisionIdentity.actorSource === 'unknown')
    return blocked('REGULATED_ACTOR_UNKNOWN', { role: 'reviewer' });
  const actorComparison = compareActorIdentity(input.decisionIdentity, state.initiatedByIdentity);
  if (actorComparison === 'same')
    return blocked('FOUR_EYES_ACTOR_MATCH', { initiator: state.initiatedByIdentity.actorId });
  if (actorComparison === 'uncomparable') return blocked('DECISION_IDENTITY_REQUIRED');
  return null;
}

function checkRequireVerified(input: ReviewDecisionInput): RailBlocked | null {
  if (
    input.decisionIdentity?.actorAssurance !== 'claim_validated' &&
    input.decisionIdentity?.actorAssurance !== 'idp_verified'
  )
    return blocked('ACTOR_ASSURANCE_INSUFFICIENT', {
      minimum: 'claim_validated',
      current: input.decisionIdentity?.actorAssurance ?? 'best_effort',
    });
  return null;
}

function checkMinAssurance(
  input: ReviewDecisionInput,
  minimum: 'claim_validated' | 'idp_verified',
): RailBlocked | null {
  if (!isAssuranceAtLeast(input.decisionIdentity?.actorAssurance, minimum))
    return blocked('ACTOR_ASSURANCE_INSUFFICIENT', {
      minimum,
      current: input.decisionIdentity?.actorAssurance ?? 'best_effort',
    });
  return null;
}

function verifyAssuranceThreshold(
  input: ReviewDecisionInput,
  ctx: RailContext,
): RailBlocked | null {
  const requireVerified = ctx.policy?.requireVerifiedActorsForApproval;
  const minimumAssurance = ctx.policy?.minimumActorAssuranceForApproval;
  if (requireVerified) return checkRequireVerified(input);
  if (minimumAssurance === 'claim_validated' || minimumAssurance === 'idp_verified')
    return checkMinAssurance(input, minimumAssurance);
  return null;
}

function enforceApprovalIdentity(
  state: SessionState,
  input: ReviewDecisionInput,
  ctx: RailContext,
): RailBlocked | null {
  if (ctx.policy?.allowSelfApproval === false) {
    const block = verifyFourEyes(state, input);
    if (block) return block;
  }
  return verifyAssuranceThreshold(input, ctx);
}

/** Enforce ProofGraph only for the governed lifecycle's final evidence approval. */
function enforceProofGraphEvidenceApproval(
  state: SessionState,
  input: ReviewDecisionInput,
): RailBlocked | null {
  if (state.phase !== 'EVIDENCE_REVIEW' || input.verdict !== 'approve') {
    return null;
  }
  const decision = evaluateProofGraphGate({
    projection: state.proofGraph,
    authorizedCriticalClaimIds: authorizedCriticalPlanClaimIds(state.plan),
    implementationDigest: state.implementation?.digest,
    riskAssessment: state.implementationRiskAssessment,
  });
  if (!decision.gated) return null;
  if (decision.kind === 'evaluation_unavailable') {
    return blocked('PROOFGRAPH_EVALUATION_UNAVAILABLE', {
      claimIds: decision.blockingClaimIds.join(', '),
    });
  }
  if (decision.kind === 'risk_assessment_stale') {
    return blocked('PROOFGRAPH_RISK_ASSESSMENT_STALE', {});
  }
  if (decision.kind === 'critical_fact_required') {
    return blocked('PROOFGRAPH_CRITICAL_FACT_REQUIRED', {
      triggers: decision.relevantTriggers.join(', '),
    });
  }
  return blocked('PROOFGRAPH_CRITICAL_FACTS_UNPROVEN', {
    claimIds: decision.blockingClaimIds.join(', '),
  });
}

/**
 * Bind the human approval to the exact immutable plan version and its claims.
 * The certificate digest deliberately excludes itself and uses the injected
 * digest authority so rail callers retain control of cryptographic hashing.
 */
function createPlanApprovalCertificate(
  plan: NonNullable<SessionState['plan']>,
  decision: ReviewDecision,
  ctx: RailContext,
  reviewObligationId?: string | null,
  reviewEvidenceDigest?: string | null,
): PlanApprovalCertificate {
  const claimDeclarations = plan.claimDeclarations ?? { flow: 'plan' as const, claims: [] };
  const claimDeclarationsDigest = ctx.digest(canonicalJsonStringify(claimDeclarations));
  const decisionAttestationDigest = ctx.digest(canonicalJsonStringify(decision));
  const planVersion = plan.current.planVersion;
  const planRecordDigest = plan.current.recordDigest;
  const obligationId = reviewObligationId ?? null;
  const evidenceDigest = reviewEvidenceDigest ?? null;

  const certificateIdDigest = ctx.digest(
    canonicalJsonStringify({
      authorityDigest: plan.current.digest,
      claimDeclarationsDigest,
      decisionAttestationDigest,
      planVersion,
      planRecordDigest,
      reviewObligationId: obligationId,
      reviewEvidenceDigest: evidenceDigest,
      approvedAt: decision.decidedAt,
      approvedBy: decision.decidedBy,
    }),
  );
  const certificateIdHex = certificateIdDigest
    .toLowerCase()
    .replaceAll(/[^a-f0-9]/g, '')
    .padEnd(32, '0')
    .slice(0, 32);
  const certificateId = `${certificateIdHex.slice(0, 8)}-${certificateIdHex.slice(8, 12)}-4${certificateIdHex.slice(13, 16)}-8${certificateIdHex.slice(17, 20)}-${certificateIdHex.slice(20)}`;
  return {
    flow: 'plan',
    authorityDigest: plan.current.digest,
    claimDeclarationsDigest,
    decisionAttestationDigest,
    approvedAt: decision.decidedAt,
    approvedBy: decision.decidedBy,
    certificateId,
    planVersion,
    planRecordDigest,
    reviewObligationId: obligationId,
    reviewEvidenceDigest: evidenceDigest,
  };
}

function createArchitectureApprovalCertificate(
  architecture: NonNullable<SessionState['architecture']>,
  decision: ReviewDecision,
  ctx: RailContext,
): ArchitectureApprovalCertificate {
  const claimDeclarations = architecture.claimDeclarations ?? {
    flow: 'architecture' as const,
    claims: [],
  };
  const claimDeclarationsDigest = ctx.digest(canonicalJsonStringify(claimDeclarations));
  const decisionAttestationDigest = ctx.digest(canonicalJsonStringify(decision));
  const certificateIdDigest = ctx.digest(
    canonicalJsonStringify({
      authorityDigest: architecture.digest,
      claimDeclarationsDigest,
      decisionAttestationDigest,
      approvedAt: decision.decidedAt,
      approvedBy: decision.decidedBy,
    }),
  );
  const certificateIdHex = certificateIdDigest
    .toLowerCase()
    .replaceAll(/[^a-f0-9]/g, '')
    .padEnd(32, '0')
    .slice(0, 32);
  const certificateId = `${certificateIdHex.slice(0, 8)}-${certificateIdHex.slice(8, 12)}-4${certificateIdHex.slice(13, 16)}-8${certificateIdHex.slice(17, 20)}-${certificateIdHex.slice(20)}`;
  return {
    flow: 'architecture',
    authorityDigest: architecture.digest,
    claimDeclarationsDigest,
    decisionAttestationDigest,
    approvedAt: decision.decidedAt,
    approvedBy: decision.decidedBy,
    certificateId,
  };
}

function resolveAcceptedPlanReviewEvidence(state: SessionState): [string | null, string | null] {
  const acceptedObligation = [...(state.reviewAssurance?.obligations ?? [])]
    .reverse()
    .find(
      (o) => o.obligationType === 'plan' && (o.status === 'fulfilled' || o.status === 'consumed'),
    );
  const acceptedEvidence = acceptedObligation?.invocationId
    ? state.reviewAssurance?.invocations.find(
        (inv) => inv.invocationId === acceptedObligation.invocationId,
      )
    : null;
  return [acceptedObligation?.obligationId ?? null, acceptedEvidence?.findingsHash ?? null];
}

function approvalCertificatePatch(
  state: SessionState,
  input: ReviewDecisionInput,
  decision: ReviewDecision,
  ctx: RailContext,
): Partial<Pick<SessionState, 'plan' | 'architecture'>> {
  if (
    state.phase === 'PLAN_REVIEW' &&
    input.verdict === 'approve' &&
    state.plan &&
    !state.plan.approvalCertificate
  ) {
    return {
      plan: {
        ...state.plan,
        approvalCertificate: createPlanApprovalCertificate(
          state.plan,
          decision,
          ctx,
          ...resolveAcceptedPlanReviewEvidence(state),
        ),
      },
    };
  }
  if (
    state.phase === 'ARCH_REVIEW' &&
    input.verdict === 'approve' &&
    state.architecture &&
    !state.architecture.approvalCertificate
  ) {
    return {
      architecture: {
        ...state.architecture,
        approvalCertificate: createArchitectureApprovalCertificate(
          state.architecture,
          decision,
          ctx,
        ),
      },
    };
  }
  return {};
}

// ─── Rail ─────────────────────────────────────────────────────────────────────

export function executeReviewDecision(
  state: SessionState,
  input: ReviewDecisionInput,
  ctx: RailContext,
): RailResult {
  // 1. Admissibility
  if (!isCommandAllowed(state.phase, Command.REVIEW_DECISION)) {
    return blocked('COMMAND_NOT_ALLOWED', {
      command: '/review-decision',
      phase: state.phase,
    });
  }

  // 2. Validate verdict
  const event = VERDICT_TO_EVENT[input.verdict];
  if (!event) {
    return blocked('INVALID_VERDICT', { verdict: String(input.verdict) });
  }

  // 3. Four-eyes and decision identity enforcement (approval only).
  if (input.verdict === 'approve') {
    const identityBlock = enforceApprovalIdentity(state, input, ctx);
    if (identityBlock) return identityBlock;
    const proofGraphBlock = enforceProofGraphEvidenceApproval(state, input);
    if (proofGraphBlock) return proofGraphBlock;
  }

  // 4. Resolve target phase via topology
  const target = evaluateWithEvent(state.phase, event);
  if (target === undefined) {
    return blocked('INVALID_TRANSITION', {
      event: String(event),
      phase: state.phase,
    });
  }

  // 5. Create evidence
  // P30: Include structured decisionIdentity for regulated approval attribution
  const decision: ReviewDecision = {
    verdict: input.verdict,
    rationale: input.rationale,
    decidedAt: ctx.now(),
    decidedBy: input.decidedBy,
    ...(input.decisionIdentity ? { decisionIdentity: input.decisionIdentity } : {}),
  };

  // A certificate is created only for the first human approval at its flow's gate;
  // an existing immutable certificate is never rewritten.
  const certificatePatch = approvalCertificatePatch(state, input, decision, ctx);

  // 6. Apply state clearing pattern based on gate + verdict
  const clearedState = applyStateClearingPattern(
    {
      ...state,
      reviewDecision: decision,
      ...certificatePatch,
    },
    input.verdict,
  );

  // 7. Apply transition
  const at = ctx.now();
  const finalState = applyTransition(clearedState, state.phase, target, event, at);

  // Record the single transition for audit
  const transition: TransitionRecord = {
    from: state.phase,
    to: target,
    event,
    at,
  };

  // 8. Re-evaluate at new phase to get the eval result for the caller (policy-aware)
  const evalResult = evaluate(finalState, ctx.policy);

  return { kind: 'ok', state: finalState, evalResult, transitions: [transition] };
}
