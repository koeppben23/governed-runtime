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

import type { SessionState, Event } from '../state/schema';
import type {
  ReviewDecision,
  ReviewVerdict,
  ValidationResult,
  DecisionIdentity,
} from '../state/evidence';
import { Command, isCommandAllowed } from '../machine/commands';
import { evaluate, evaluateWithEvent } from '../machine/evaluate';
import type { RailResult, RailContext, TransitionRecord } from './types';
import { applyTransition } from './types';
import { blocked } from '../config/reasons';

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
 * State fields cleared on reject (from any gate).
 * Everything downstream of TICKET is wiped — plan must be rebuilt from scratch.
 */
const REJECT_CLEAR = {
  plan: null,
  selfReview: null,
  validation: [] as ValidationResult[],
  implementation: null,
  implReview: null,
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
 * - changes_requested at EVIDENCE_REVIEW: clear impl + implReview (re-implement)
 * - changes_requested at ARCH_REVIEW: clear selfReview (fresh review loop)
 * - reject at PLAN_REVIEW/EVIDENCE_REVIEW: clear everything downstream of TICKET
 * - reject at ARCH_REVIEW: clear architecture + selfReview (back to READY)
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
    return { ...state, ...REJECT_CLEAR };
  }

  // changes_requested
  if (state.phase === 'PLAN_REVIEW') {
    return { ...state, selfReview: null };
  }
  if (state.phase === 'EVIDENCE_REVIEW') {
    return { ...state, implementation: null, implReview: null };
  }
  if (state.phase === 'ARCH_REVIEW') {
    return { ...state, selfReview: null };
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

  // 3. Four-eyes and decision identity enforcement.
  //    Regulated mode applies strict identity checks only for approval decisions.
  //    changes_requested/reject remain available for safety interventions.
  //    P30: Requires structured identity — no legacy fail-open from sessionID only.
  if (ctx.policy?.allowSelfApproval === false && input.verdict === 'approve') {
    // P30: Require structured initiator identity (fail-closed on legacy sessions)
    if (!state.initiatedByIdentity) {
      return blocked('DECISION_IDENTITY_REQUIRED');
    }

    // P30: Require structured decision identity (fail-closed on legacy decisions)
    if (!input.decisionIdentity) {
      return blocked('DECISION_IDENTITY_REQUIRED');
    }

    // P30: Block unknown source actors
    if (state.initiatedByIdentity.actorSource === 'unknown') {
      return blocked('REGULATED_ACTOR_UNKNOWN', {
        role: 'initiator',
      });
    }

    if (input.decisionIdentity.actorSource === 'unknown') {
      return blocked('REGULATED_ACTOR_UNKNOWN', {
        role: 'reviewer',
      });
    }

    // P30: Four-eyes enforcement via structured identity
    if (input.decisionIdentity.actorId === state.initiatedByIdentity.actorId) {
      return blocked('FOUR_EYES_ACTOR_MATCH', {
        initiator: state.initiatedByIdentity.actorId,
      });
    }
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

  // 6. Apply state clearing pattern based on gate + verdict
  const clearedState = applyStateClearingPattern(
    { ...state, reviewDecision: decision },
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
