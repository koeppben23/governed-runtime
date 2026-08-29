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
  ArchitectureReviewBinding,
} from '../state/proofgraph-approval.js';
import {
  authorizedCriticalPlanClaimIds,
  emptyClaimDeclarations,
} from '../state/proofgraph-approval.js';
import { Command, isCommandAllowed } from '../machine/commands.js';
import { evaluate, evaluateWithEvent } from '../machine/evaluate.js';
import type { RailResult, RailBlocked, RailContext, TransitionRecord } from './types.js';
import { applyTransition } from './types.js';
import { blocked } from '../config/reasons.js';
import { compareActorIdentity, isAssuranceAtLeast } from '../identity/actor-info.js';
import { canonicalJsonStringify } from '../shared/canonical-json.js';
import { digestToId } from '../shared/hashing.js';
import { evaluateProofGraphGate } from '../audit/proofgraph/gate.js';
import { mapEnforcementReasonToRegistryCode } from '../audit/proofgraph/reason-code-mapping.js';
import {
  resolveArchitectureReviewEvidence,
  resolveLatestPlanReviewEvidence,
  resolvePlanReviewEvidence,
  type ArchitectureReviewEvidenceResolution,
  type ResolvedPlanReviewEvidence,
} from './review-evidence-resolution.js';
import { enforcePlanReviewEvidence, planCertificatePatch } from './plan-review-evidence.js';
import { countUnboundMutationEpisodes } from '../state/evidence-mutation-episode.js';

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
        ? {
            ...state.architecture,
            reviewCompletion: 'pending',
            approvalCertificate: undefined,
          }
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
  const rejectedCriticalClaim = state.plan?.claimSubmissionDiagnostics?.rejectedClaims.find(
    (claim) => claim.disposition === 'rejected_blocking',
  );
  if (rejectedCriticalClaim) {
    return blocked('PROOFGRAPH_CLAIM_NOT_DECLARED', {
      claimRef: rejectedCriticalClaim.claimRef,
      field: 'claim declaration',
      detail: rejectedCriticalClaim.reason,
    });
  }
  const authorization = authorizedCriticalPlanClaimIds(state.plan);
  const decision = evaluateProofGraphGate({
    projection: state.proofGraph,
    authorizedCriticalClaimIds: authorization.kind === 'authorized' ? authorization.claimIds : [],
    certificateValid: authorization.kind === 'authorized',
    implementationDigest: state.implementation?.digest,
    riskAssessment: state.implementationRiskAssessment,
  });
  if (!decision.gated) return null;
  if (decision.kind === 'critical_fact_required') {
    return blocked('PROOFGRAPH_CRITICAL_FACT_REQUIRED', {
      triggers: decision.relevantTriggers.join(', '),
    });
  }
  if (decision.kind === 'facts_unproven') {
    // facts_unproven — include per-claim registry details in the message
    const claimDetails = decision.blockingClaims
      .map((bc) => `${bc.claimId} (${bc.registryCode})`)
      .join(', ');
    return blocked('PROOFGRAPH_CRITICAL_FACTS_UNPROVEN', {
      claimDetails,
      claimIds: decision.blockingClaimIds.join(', '),
    });
  }
  const registryCode = mapEnforcementReasonToRegistryCode(decision.reasonCode);
  if (decision.kind === 'evaluation_unavailable') {
    return blocked(registryCode, { claimIds: decision.blockingClaimIds.join(', ') });
  }
  return blocked(registryCode, undefined);
}

/**
 * The final human approval is bound to the recorded implementation digest.
 * Any unresolved dispatch or completed-but-unbound host mutation can have
 * changed the worktree after that digest was captured. A fenced unknown-outcome
 * resolution is historical provenance; fresh evidence is enforced separately
 * by the canonical revalidation gate before review acceptance.
 */
function enforceMutationEpisodeEvidenceApproval(
  state: SessionState,
  input: ReviewDecisionInput,
): RailBlocked | null {
  if (state.phase !== 'EVIDENCE_REVIEW' || input.verdict !== 'approve') return null;
  const unboundCount = countUnboundMutationEpisodes(
    state.mutationEpisodes,
    state.mutationEpisodeResolutions,
  );
  return unboundCount > 0
    ? blocked('MUTATION_EPISODE_BINDING_REQUIRED', { count: String(unboundCount) })
    : null;
}

/** Architecture approval requires a completed reviewer cycle, never a pending loop. */
function enforceArchitectureReviewCompletion(
  state: SessionState,
  input: ReviewDecisionInput,
): RailBlocked | null {
  if (state.phase !== 'ARCH_REVIEW' || input.verdict !== 'approve') return null;
  const completion = state.architecture?.reviewCompletion;
  if (completion === 'reviewer_accepted' || completion === 'review_exhausted') return null;
  return blocked('ARCHITECTURE_REVIEW_COMPLETION_REQUIRED', {
    reviewCompletion: completion ?? 'missing',
  });
}

/**
 * Architecture approval requires bindable independent-review evidence:
 * `reviewer_accepted` demands exact-subject evidence for the current ADR
 * digest; `review_exhausted` demands the latest real bound evidence so the
 * override provenance stays explicit. Receives the already-resolved binding so
 * gate and certificate minting share ONE resolution — no second resolver run,
 * no drift inside one decision operation.
 */
function enforceArchitectureReviewEvidence(
  state: SessionState,
  resolution: ArchitectureReviewEvidenceResolution | null,
): RailBlocked | null {
  // Called only from the approve path; keeping the phase guard alone avoids
  // dead operands.
  if (state.phase !== 'ARCH_REVIEW') return null;
  if (resolution?.kind === 'bound') return null;
  const reviewCompletion = state.architecture?.reviewCompletion ?? 'missing';
  if (resolution?.kind === 'completion_contradiction') {
    return blocked('ARCHITECTURE_REVIEW_EVIDENCE_CONTRADICTS_COMPLETION', {
      reviewCompletion,
      capturedVerdict: resolution.capturedVerdict,
    });
  }
  return blocked('ARCHITECTURE_REVIEW_EVIDENCE_REQUIRED', {
    reviewCompletion,
    capturedVerdict: resolution?.kind === 'verdict_missing' ? 'missing' : 'unavailable',
  });
}

function createArchitectureApprovalCertificate(
  architecture: NonNullable<SessionState['architecture']>,
  decision: ReviewDecision,
  ctx: RailContext,
  reviewBinding: ArchitectureReviewBinding,
): ArchitectureApprovalCertificate {
  const claimDeclarations =
    architecture.claimDeclarations ?? emptyClaimDeclarations('architecture');
  const claimDeclarationsDigest = ctx.digest(canonicalJsonStringify(claimDeclarations));
  const decisionAttestationDigest = ctx.digest(canonicalJsonStringify(decision));
  const certificateIdDigest = ctx.digest(
    canonicalJsonStringify({
      authorityDigest: architecture.digest,
      claimDeclarationsDigest,
      decisionAttestationDigest,
      // The binding block co-signs the certificate identity: relabeling the
      // binding kind or swapping the reviewed digest changes the certificateId.
      reviewBinding,
      approvedAt: decision.decidedAt,
      approvedBy: decision.decidedBy,
    }),
  );
  const certificateId = digestToId(certificateIdDigest, 4);
  return {
    flow: 'architecture',
    authorityDigest: architecture.digest,
    claimDeclarationsDigest,
    decisionAttestationDigest,
    approvedAt: decision.decidedAt,
    approvedBy: decision.decidedBy,
    certificateId,
    reviewBinding,
  };
}

function architectureCertificatePatch(
  state: SessionState,
  decision: ReviewDecision,
  ctx: RailContext,
  architectureReviewBinding: ArchitectureReviewBinding | null,
): Partial<Pick<SessionState, 'architecture'>> {
  if (
    state.phase !== 'ARCH_REVIEW' ||
    !state.architecture ||
    state.architecture.approvalCertificate ||
    !architectureReviewBinding
  ) {
    return {};
  }
  return {
    architecture: {
      ...state.architecture,
      approvalCertificate: createArchitectureApprovalCertificate(
        state.architecture,
        decision,
        ctx,
        architectureReviewBinding,
      ),
    },
  };
}

interface CertificatePatchBindings {
  readonly architectureReviewBinding: ArchitectureReviewBinding | null;
  readonly planReviewEvidence: ResolvedPlanReviewEvidence | null;
}

function approvalCertificatePatch(
  state: SessionState,
  input: ReviewDecisionInput,
  decision: ReviewDecision,
  ctx: RailContext,
  bindings: CertificatePatchBindings,
): Partial<Pick<SessionState, 'plan' | 'architecture'>> {
  if (input.verdict !== 'approve') return {};
  return {
    ...planCertificatePatch(state, decision, ctx, bindings.planReviewEvidence),
    ...architectureCertificatePatch(state, decision, ctx, bindings.architectureReviewBinding),
  };
}

/**
 * Approval preconditions: four-eyes, decision identity, architecture review
 * completion, architecture evidence coherence, plan evidence coherence, and
 * the ProofGraph gate, and mutation evidence binding. Resolves the architecture AND plan evidence ONCE per
 * decision operation; the same resolved bindings are returned to the caller
 * and used later by the certificate patch, so gate and mint can never disagree
 * within this operation.
 */
function enforceApprovalPreconditions(
  state: SessionState,
  input: ReviewDecisionInput,
  ctx: RailContext,
): {
  block: RailBlocked | null;
  evidence: ArchitectureReviewEvidenceResolution | null;
  planEvidence: ResolvedPlanReviewEvidence | null;
} {
  if (input.verdict !== 'approve') return { block: null, evidence: null, planEvidence: null };
  const identityBlock = enforceApprovalIdentity(state, input, ctx);
  if (identityBlock) return { block: identityBlock, evidence: null, planEvidence: null };
  const architectureReviewBlock = enforceArchitectureReviewCompletion(state, input);
  if (architectureReviewBlock) {
    return { block: architectureReviewBlock, evidence: null, planEvidence: null };
  }
  // The phase guards live in the gates and the patch; resolving is a pure read
  // and stays side-effect free for non-ARCH/PLAN phases.
  const evidence = state.architecture
    ? resolveArchitectureReviewEvidence(state, state.architecture)
    : null;
  const architectureEvidenceBlock = enforceArchitectureReviewEvidence(state, evidence);
  if (architectureEvidenceBlock)
    return { block: architectureEvidenceBlock, evidence, planEvidence: null };
  // The plan resolution follows the recorded completion: exact-subject for
  // reviewer_accepted, latest-bound for review_exhausted (the gate then
  // enforces reviewed==approved). Resolving is a pure read.
  const plan = state.plan;
  const planEvidence = plan
    ? plan.reviewCompletion === 'review_exhausted'
      ? resolveLatestPlanReviewEvidence(state)
      : resolvePlanReviewEvidence(state, plan.current.digest)
    : null;
  const planEvidenceBlock = enforcePlanReviewEvidence(state, planEvidence);
  if (planEvidenceBlock) return { block: planEvidenceBlock, evidence, planEvidence };
  const mutationEpisodeBlock = enforceMutationEpisodeEvidenceApproval(state, input);
  if (mutationEpisodeBlock) return { block: mutationEpisodeBlock, evidence, planEvidence };
  const proofGraphBlock = enforceProofGraphEvidenceApproval(state, input);
  return { block: proofGraphBlock, evidence, planEvidence };
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

  // 3. Approval preconditions (four-eyes, identity, architecture/plan evidence, ProofGraph).
  const {
    block: preconditionBlock,
    evidence: architectureEvidenceResolution,
    planEvidence: planReviewEvidence,
  } = enforceApprovalPreconditions(state, input, ctx);
  if (preconditionBlock) return preconditionBlock;

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
  const architectureReviewBinding =
    architectureEvidenceResolution?.kind === 'bound'
      ? architectureEvidenceResolution.binding
      : null;
  const certificatePatch = approvalCertificatePatch(state, input, decision, ctx, {
    architectureReviewBinding,
    planReviewEvidence,
  });

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
