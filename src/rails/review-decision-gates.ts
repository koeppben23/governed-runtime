/**
 * @module review-decision-gates
 * @description Approval gates and certificates for the /review-decision rail.
 *
 * Input contract, verdict classification, override agreement, identity and
 * assurance enforcement, architecture/plan evidence coherence, ProofGraph and
 * mutation-episode gates, approval preconditions, and approval certificates.
 * The rail executor and its state-clearing patterns stay in
 * `review-decision.ts`.
 *
 * @version v1
 */

import type { SessionState } from '../state/schema.js';
import type { ReviewDecision, ReviewVerdict, DecisionIdentity } from '../state/evidence.js';
import type {
  ArchitectureApprovalCertificate,
  ArchitectureReviewBinding,
} from '../state/proofgraph-approval.js';
import {
  authorizedCriticalPlanClaimIds,
  emptyClaimDeclarations,
} from '../state/proofgraph-approval.js';
import { resolveWorkflowDirective } from '../machine/workflow-directive.js';
import type { RailBlocked, RailContext } from './types.js';
import { blocked } from '../config/reasons.js';
import { compareActorIdentity } from '../identity/actor-info.js';
import { isApprovalVerdict } from '../state/evidence.js';
import { isAssuranceAtLeast } from '../shared/actor-assurance.js';
import { canonicalJsonStringify } from '../shared/canonical-json.js';
import { digestToId } from '../shared/hashing.js';
import { evaluateProofGraphGate, planClaimAuthorityOf } from '../audit/proofgraph/gate.js';
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

/**
 * Enforce agreement between the human intent and the canonical directive:
 * an exhausted gate accepts only APPROVE_WITH_GOVERNANCE_OVERRIDE, a normal
 * gate only APPROVE. The directive is the single authority for which intent
 * the gate requires — there is no second exhaustion check here.
 */
export function enforceOverrideAgreement(
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

/** True when the decision is a human approval at the plan or evidence gate. */
function isEvidenceApprovalPhase(state: SessionState, input: ReviewDecisionInput): boolean {
  return (
    (state.phase === 'PLAN_REVIEW' || state.phase === 'EVIDENCE_REVIEW') &&
    isApprovalVerdict(input.verdict)
  );
}

function evaluateEvidenceProofGraphGate(
  state: SessionState,
): ReturnType<typeof evaluateProofGraphGate> {
  const authorization = authorizedCriticalPlanClaimIds(planClaimAuthorityOf(state.plan));
  return evaluateProofGraphGate({
    ...(state.proofGraph !== undefined ? { projection: state.proofGraph } : {}),
    authorizedCriticalClaimIds: authorization.kind === 'authorized' ? authorization.claimIds : [],
    certificateValid: authorization.kind === 'authorized',
    ...(state.implementation?.digest !== undefined
      ? { implementationDigest: state.implementation.digest }
      : {}),
    riskAssessment: state.implementationRiskAssessment,
  });
}

/** Enforce ProofGraph only for governed plan and final evidence approval. */
function enforceProofGraphEvidenceApproval(
  state: SessionState,
  input: ReviewDecisionInput,
): RailBlocked | null {
  if (!isEvidenceApprovalPhase(state, input)) return null;
  const rejectedBlock = rejectedCriticalClaimBlock(state);
  if (rejectedBlock) return rejectedBlock;
  if (state.phase !== 'EVIDENCE_REVIEW') return null;
  const decision = evaluateEvidenceProofGraphGate(state);
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
export function enforceImplementationReviewSubject(
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

export function approvalCertificatePatch(
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
export function enforceApprovalPreconditions(
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
