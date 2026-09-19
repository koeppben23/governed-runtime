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
 * State clearing patterns (FlowGuard-critical). The table distinguishes three
 * effects precisely:
 * - clear:    the field is set to null/empty
 * - reset:    a sub-state is rewound to its pre-review value (not cleared)
 * - preserve: the field survives the decision unchanged
 *
 * | Gate            | Verdict           | Actual persisted behavior                                                                                                  |
 * |-----------------|-------------------|----------------------------------------------------------------------------------------------------------------------------|
 * | PLAN_REVIEW     | approve           | reviewDecision preserved; nothing is cleared                                                                               |
 * | PLAN_REVIEW     | changes_requested | selfReview and reviewDecision cleared; reviewCycles.plan + 1                                                               |
 * | EVIDENCE_REVIEW | approve           | everything preserved, including reviewDecision                                                                             |
 * | EVIDENCE_REVIEW | changes_requested | implementation, implValidation, implReview, reducedCeremony, reviewDecision cleared; reviewCycles.implementation + 1       |
 * | ARCH_REVIEW     | approve           | architecture marked accepted; reviewDecision preserved; nothing is cleared                                                 |
 * | ARCH_REVIEW     | changes_requested | architecture kept but reviewCompletion reset to 'pending' and approvalCertificate reset; selfReview cleared; reviewDecision preserved; reviewCycles.architecture + 1 |
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
import type { ReviewDecision, ReviewVerdict } from '../state/evidence.js';
import { Command, isCommandAllowed } from '../machine/commands.js';
import { evaluate, evaluateWithEvent } from '../machine/evaluate.js';
import type { RailResult, RailContext, TransitionRecord } from './types.js';
import { applyTransition } from './types.js';
import { blocked } from '../config/reasons.js';
import {
  approvalCertificatePatch,
  enforceApprovalPreconditions,
  enforceImplementationReviewSubject,
  enforceOverrideAgreement,
  isApprovalVerdict,
  type ReviewDecisionInput,
} from './review-decision-gates.js';

export type { ReviewDecisionInput };

// ─── Verdict → Event mapping ──────────────────────────────────────────────────

const VERDICT_TO_EVENT: Record<ReviewVerdict, Event> = {
  approve: 'APPROVE',
  approve_with_governance_override: 'APPROVE',
  changes_requested: 'CHANGES_REQUESTED',
  reject: 'REJECT',
};

/**
 * Apply the gate- and verdict-specific state pattern.
 *
 * - approve:      preserve everything (at ARCH_REVIEW the architecture status is
 *                 additionally marked 'accepted'); nothing is cleared
 * - reject:       preserve the reviewed evidence and the recorded decision at
 *                 the REJECTED terminal position
 * - changes_requested: clear the owning loop state, reset the architecture
 *                 review sub-state at ARCH_REVIEW (reviewCompletion back to
 *                 'pending', approvalCertificate back to undefined), and advance
 *                 exactly the owning `reviewCycles` counter. `reviewDecision`
 *                 itself is preserved at ARCH_REVIEW and cleared at
 *                 PLAN_REVIEW / EVIDENCE_REVIEW — see the module table.
 *
 * `changes_requested` at the implementation readiness loop (IMPL_REVIEW) is
 * handled by `handleChangesRequestedReview` in
 * `integration/tools/implement-review.ts`.
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
