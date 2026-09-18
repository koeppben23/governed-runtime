/**
 * @module review-decision
 * @description /review-decision rail — human verdict at a User Gate.
 *
 * Works at all three User Gate phases:
 * - PLAN_REVIEW:     approve → VALIDATION, changes → PLAN, reject → REJECTED
 * - EVIDENCE_REVIEW: approve → COMPLETE, changes → IMPLEMENTATION, reject → REJECTED
 * - ARCH_REVIEW:     approve → ARCH_COMPLETE, changes → ARCHITECTURE, reject → REJECTED
 *
 * Four-eyes principle enforcement (regulated mode):
 * For approval decisions only, when policy.allowSelfApproval === false,
 * the reviewer (decisionIdentity.actorId) MUST be different from the session
 * initiator (state.initiatedByIdentity.actorId).
 * This satisfies MaRisk AT 7.2 (5) — separation of duties.
 *
 * State clearing patterns (FlowGuard-critical):
 *
 * | Gate            | Verdict            | Keep                    | Clear                                    |
 * |-----------------|--------------------|-------------------------|------------------------------------------|
 * | PLAN_REVIEW     | approve            | ticket, plan, selfReview| reviewDecision                           |
 * | PLAN_REVIEW     | changes_requested  | ticket, plan            | selfReview, reviewDecision               |
 * | EVIDENCE_REVIEW | approve            | everything              | (nothing — complete)                     |
 * | EVIDENCE_REVIEW | changes_requested  | ticket, plan, validation| impl, implReview, reviewDecision         |
 * | ARCH_REVIEW     | approve            | architecture, selfReview| (nothing — complete)                     |
 * | ARCH_REVIEW     | changes_requested  | architecture            | selfReview                               |
 *
 * A `changes_requested` verdict also increments exactly the owning loop's human
 * review-cycle counter (`state.reviewCycles.plan|architecture|implementation`):
 * the cleared loop restarts `iteration` at 1, and the counter keeps the two
 * iteration-1 passes distinguishable in persisted evidence and audit. Approve
 * and reject NEVER change a counter.
 *
 * @version v1
 */

import type { SessionState, Event } from '../state/schema.js';
import type { ReviewDecision, ReviewVerdict, DecisionIdentity } from '../state/evidence.js';
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
import { resolveWorkflowDirective } from '../machine/workflow-directive.js';
import type { RailResult, RailBlocked, RailContext, TransitionRecord } from './types.js';
import { applyTransition } from './types.js';
import { blocked } from '../config/reasons.js';
import { compareActorIdentity } from '../identity/actor-info.js';
import { isAssuranceAtLeast } from '../shared/actor-assurance.js';
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
import {
  enforcePlanReviewEvidence,
  planCertificatePatch,
  planClaimDeclarationsDigest,
} from './plan-review-evidence.js';
import { countUnboundMutationEpisodes } from '../state/evidence-mutation-episode.js';

// ─── Input ────────────────────────────────────────────────────────────────────

/**
 * Input for /review-decision rail.
 *
 * P30: `decisionIdentity` is the sole actor attribution. The rail persists it
 * verbatim and derives four-eyes, assurance, and certificate authority from it.
 */
export interface ReviewDecisionInput {
  readonly verdict: ReviewVerdict;
  readonly rationale: string;
  readonly decisionIdentity: DecisionIdentity;
}

// ─── Verdict → Event mapping ──────────────────────────────────────────────────

const VERDICT_TO_EVENT: Record<ReviewVerdict, Event> = {
  approve: 'APPROVE',
  approve_with_governance_override: 'APPROVE',
  changes_requested: 'CHANGES_REQUESTED',
  reject: 'REJECT',
};

/** Both approval verdicts authorize the approval preconditions and certificates. */
function isApprovalVerdict(verdict: ReviewVerdict): boolean {
  return verdict === 'approve' || verdict === 'approve_with_governance_override';
}

/**
 * Enforce agreement between the human intent and the canonical directive:
 * an exhausted gate accepts only APPROVE_WITH_GOVERNANCE_OVERRIDE, a normal
 * gate only APPROVE. The directive is the single authority for which intent
 * the gate requires — there is no second exhaustion check here.
 */
function enforceOverrideAgreement(
  state: SessionState,
  input: ReviewDecisionInput,
): RailBlocked | null {
  const allowedIntents = resolveWorkflowDirective(state).allowedIntents;
  const overrideRequired = allowedIntents.includes('APPROVE_WITH_GOVERNANCE_OVERRIDE');
  if (input.verdict === 'approve' && overrideRequired) {
    return blocked('GOVERNANCE_OVERRIDE_REQUIRED', { intent: 'APPROVE' });
  }
  if (input.verdict === 'approve_with_governance_override' && !overrideRequired) {
    return blocked('GOVERNANCE_OVERRIDE_NOT_REQUIRED', {
      intent: 'APPROVE_WITH_GOVERNANCE_OVERRIDE',
    });
  }
  // The override is the strongest governance moment: it must carry a durable,
  // non-empty rationale. Empty or whitespace-only justifications are
  // fail-closed rejected; a plain approval has no rationale requirement.
  if (input.verdict === 'approve_with_governance_override' && input.rationale.trim().length === 0) {
    return blocked('GOVERNANCE_OVERRIDE_RATIONALE_REQUIRED', {
      intent: 'APPROVE_WITH_GOVERNANCE_OVERRIDE',
    });
  }
  return null;
}

/**
 * Apply state clearing pattern based on gate + verdict.
 *
 * Clearing rules (FlowGuard-critical):
 * - approve: keep everything (state flows forward)
 * - changes_requested at PLAN_REVIEW: clear selfReview (fresh review loop)
 * - changes_requested at IMPL_REVIEW: cleared by handleChangesRequestedReview in implement.ts
 * - changes_requested at EVIDENCE_REVIEW: clear impl + implReview + reducedCeremony (re-implement)
 * - changes_requested at ARCH_REVIEW: clear selfReview (fresh review loop)
 * - reject: preserve the reviewed evidence and recorded decision at REJECTED
 *
 * reducedCeremony is revoked on any changes_requested that loops back to IMPLEMENTATION
 * because the prior TRIVIAL determination is invalidated by the review finding issues.
 */
function applyStateClearingPattern(state: SessionState, verdict: ReviewVerdict): SessionState {
  if (isApprovalVerdict(verdict)) {
    // At ARCH_REVIEW, set architecture status to "accepted" on approval
    if (state.phase === 'ARCH_REVIEW' && state.architecture) {
      return { ...state, architecture: { ...state.architecture, status: 'accepted' } };
    }
    return state;
  }

  if (verdict === 'reject') return state;

  // changes_requested
  // A human request-changes decision ends the current human review cycle and
  // starts a new one: the owning loop's counter advances exactly once and the
  // corresponding loop state (and its `iteration`) is cleared below, so the
  // restarted loop mints its next obligations/projections in the new cycle.
  if (state.phase === 'PLAN_REVIEW') {
    return {
      ...state,
      selfReview: null,
      reviewDecision: null,
      reviewCycles: { ...state.reviewCycles, plan: state.reviewCycles.plan + 1 },
    };
  }
  if (state.phase === 'EVIDENCE_REVIEW') {
    return {
      ...state,
      implementation: null,
      implValidation: [],
      implReview: null,
      reducedCeremony: null,
      reviewDecision: null,
      reviewCycles: {
        ...state.reviewCycles,
        implementation: state.reviewCycles.implementation + 1,
      },
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
      reviewCycles: { ...state.reviewCycles, architecture: state.reviewCycles.architecture + 1 },
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
 * Assurance enforcement uses minimumActorAssuranceForApproval with an explicit
 * ordinal comparison via actor-info.
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

function checkMinAssurance(
  input: ReviewDecisionInput,
  minimum: 'claim_validated' | 'idp_verified',
): RailBlocked | null {
  const assurance = input.decisionIdentity.actorAssurance;
  if (!isAssuranceAtLeast(assurance, minimum))
    return blocked('ACTOR_ASSURANCE_INSUFFICIENT', {
      minimum,
      // A malformed (schema-invalid) identity has no tier; it is below every
      // threshold and must be labeled as such instead of leaking a missing var.
      current: assurance ?? 'unknown',
    });
  return null;
}

function verifyAssuranceThreshold(
  input: ReviewDecisionInput,
  ctx: RailContext,
): RailBlocked | null {
  const minimumAssurance = ctx.policy?.minimumActorAssuranceForApproval;
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

function rejectedCriticalClaimBlock(state: SessionState): RailBlocked | null {
  const claim = state.plan?.claimSubmissionDiagnostics?.rejectedClaims.find(
    (item) => item.disposition === 'rejected_blocking',
  );
  return claim
    ? blocked('PROOFGRAPH_CLAIM_NOT_DECLARED', {
        claimRef: claim.claimRef,
        field: 'claim declaration',
        detail: claim.reason,
      })
    : null;
}

/** Enforce ProofGraph only for governed plan and final evidence approval. */
function enforceProofGraphEvidenceApproval(
  state: SessionState,
  input: ReviewDecisionInput,
): RailBlocked | null {
  if (
    (state.phase !== 'PLAN_REVIEW' && state.phase !== 'EVIDENCE_REVIEW') ||
    !isApprovalVerdict(input.verdict)
  ) {
    return null;
  }
  const rejectedBlock = rejectedCriticalClaimBlock(state);
  if (rejectedBlock) return rejectedBlock;
  if (state.phase !== 'EVIDENCE_REVIEW') return null;
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
  if (state.phase !== 'EVIDENCE_REVIEW' || !isApprovalVerdict(input.verdict)) return null;
  const unboundCount = countUnboundMutationEpisodes(
    state.mutationEpisodes,
    state.mutationEpisodeResolutions,
  );
  return unboundCount > 0
    ? blocked('MUTATION_EPISODE_BINDING_REQUIRED', { count: String(unboundCount) })
    : null;
}

/**
 * Implementation approvals bind the exact reviewed revision: a human may
 * override open findings of the reviewed implementation, never approve a
 * different revision through a stale review. A governance override demands
 * that a review result exists at all; a normal approval only has to agree
 * with a recorded review when one exists (reduced ceremony records none).
 */
function enforceImplementationReviewSubject(
  state: SessionState,
  input: ReviewDecisionInput,
): RailBlocked | null {
  if (state.phase !== 'EVIDENCE_REVIEW' || !isApprovalVerdict(input.verdict)) return null;
  const reviewed = state.implReview;
  if (!reviewed) {
    return input.verdict === 'approve_with_governance_override'
      ? blocked('IMPLEMENTATION_REVIEW_EVIDENCE_REQUIRED')
      : null;
  }
  const current = state.implementation?.digest;
  if (!current || reviewed.currDigest !== current) {
    return blocked('IMPLEMENTATION_REVIEW_SUBJECT_MISMATCH', {
      reviewedDigest: reviewed.currDigest,
      currentDigest: current ?? 'missing',
    });
  }
  return null;
}

/** Architecture approval requires a completed reviewer cycle, never a pending loop. */
function enforceArchitectureReviewCompletion(
  state: SessionState,
  input: ReviewDecisionInput,
): RailBlocked | null {
  if (state.phase !== 'ARCH_REVIEW' || !isApprovalVerdict(input.verdict)) return null;
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
  if (resolution?.kind === 'bound') {
    // Hard cut: every governance override binds the exact reviewed subject.
    // An override may release open findings of the reviewed ADR, never a
    // different revision than the one the last review actually covered.
    if (
      resolution.binding.kind === 'review_exhausted_override' &&
      resolution.binding.reviewedSubjectDigest !== resolution.binding.approvedSubjectDigest
    ) {
      return blocked('ARCHITECTURE_REVIEW_OVERRIDE_SUBJECT_MISMATCH', {
        reviewedSubjectDigest: resolution.binding.reviewedSubjectDigest,
        approvedSubjectDigest: resolution.binding.approvedSubjectDigest,
      });
    }
    return null;
  }
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
      approvedBy: decision.decisionIdentity.actorId,
    }),
  );
  const certificateId = digestToId(certificateIdDigest, 4);
  return {
    flow: 'architecture',
    authorityDigest: architecture.digest,
    claimDeclarationsDigest,
    decisionAttestationDigest,
    approvedAt: decision.decidedAt,
    approvedBy: decision.decisionIdentity.actorId,
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
  if (!isApprovalVerdict(input.verdict)) return {};
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
  if (!isApprovalVerdict(input.verdict)) {
    return { block: null, evidence: null, planEvidence: null };
  }
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
  // The plan resolution follows the recorded completion: exact revision for
  // reviewer_accepted, latest-bound for review_exhausted (the gate then
  // enforces reviewed==approved). Both resolve against the SAME authority
  // tuple — content digest + planVersion + claim declarations digest — so a
  // review of an older revision with identical content can never win.
  // Resolving is a pure read.
  const plan = state.plan;
  const planEvidence = plan
    ? (() => {
        const authority = {
          subjectDigest: plan.current.digest,
          planVersion: plan.current.planVersion,
          claimDeclarationsDigest: planClaimDeclarationsDigest(plan),
        };
        return plan.reviewCompletion === 'review_exhausted'
          ? resolveLatestPlanReviewEvidence(state, authority)
          : resolvePlanReviewEvidence(state, authority);
      })()
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

  // 2b. The human intent must match the gate type derived from persisted state.
  const overrideBlock = enforceOverrideAgreement(state, input);
  if (overrideBlock) return overrideBlock;
  const implementationSubjectBlock = enforceImplementationReviewSubject(state, input);
  if (implementationSubjectBlock) return implementationSubjectBlock;

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
  // P30: Persist the structured decisionIdentity as the sole attribution authority.
  const decision: ReviewDecision = {
    verdict: input.verdict,
    rationale: input.rationale,
    decidedAt: ctx.now(),
    decisionIdentity: input.decisionIdentity,
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
