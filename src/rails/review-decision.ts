/**
 * @module review-decision
 * @description /review-decision rail — human verdict at a User Gate.
 *
 * Works at both User Gate phases:
 * - PLAN_REVIEW:     approve → VALIDATION, changes → PLAN, reject → TICKET
 * - EVIDENCE_REVIEW: approve → COMPLETE, changes → IMPLEMENTATION, reject → TICKET
 *
 * Four-eyes principle enforcement (regulated mode):
 * When policy.allowSelfApproval === false, the reviewer (decidedBy)
 * MUST be different from the session initiator (state.initiatedBy).
 * This satisfies MaRisk AT 7.2 (5) — separation of duties.
 *
 * State clearing patterns (governance-critical):
 *
 * | Gate            | Verdict            | Keep                    | Clear                                    |
 * |-----------------|--------------------|-------------------------|------------------------------------------|
 * | PLAN_REVIEW     | approve            | ticket, plan, selfReview| reviewDecision                           |
 * | PLAN_REVIEW     | changes_requested  | ticket, plan            | selfReview, reviewDecision               |
 * | PLAN_REVIEW     | reject             | ticket                  | plan, selfReview, validation, impl, ...  |
 * | EVIDENCE_REVIEW | approve            | everything              | (nothing — complete)                     |
 * | EVIDENCE_REVIEW | changes_requested  | ticket, plan, validation| impl, implReview, reviewDecision         |
 * | EVIDENCE_REVIEW | reject             | ticket                  | plan, selfReview, validation, impl, ...  |
 *
 * @version v1
 */

import type { SessionState, Event } from "../state/schema";
import type { ReviewDecision, ReviewVerdict, ValidationResult } from "../state/evidence";
import { Command, isCommandAllowed } from "../machine/commands";
import { evaluate, evaluateWithEvent } from "../machine/evaluate";
import type { RailResult, RailContext, TransitionRecord } from "./types";
import { applyTransition } from "./types";
import { blocked } from "../config/reasons";

// ─── Input ────────────────────────────────────────────────────────────────────

export interface ReviewDecisionInput {
  readonly verdict: ReviewVerdict;
  readonly rationale: string;
  readonly decidedBy: string;
}

// ─── Verdict → Event mapping ──────────────────────────────────────────────────

const VERDICT_TO_EVENT: Record<ReviewVerdict, Event> = {
  approve: "APPROVE",
  changes_requested: "CHANGES_REQUESTED",
  reject: "REJECT",
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
 * Apply state clearing pattern based on gate + verdict.
 *
 * Clearing rules (governance-critical):
 * - approve: keep everything (state flows forward)
 * - changes_requested at PLAN_REVIEW: clear selfReview (fresh review loop)
 * - changes_requested at EVIDENCE_REVIEW: clear impl + implReview (re-implement)
 * - reject at any gate: clear everything downstream of TICKET
 */
function applyStateClearingPattern(
  state: SessionState,
  verdict: ReviewVerdict,
): SessionState {
  if (verdict === "approve") return state;

  if (verdict === "reject") {
    return { ...state, ...REJECT_CLEAR };
  }

  // changes_requested
  if (state.phase === "PLAN_REVIEW") {
    return { ...state, selfReview: null };
  }
  if (state.phase === "EVIDENCE_REVIEW") {
    return { ...state, implementation: null, implReview: null };
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
    return blocked("COMMAND_NOT_ALLOWED", {
      command: "/review-decision",
      phase: state.phase,
    });
  }

  // 2. Validate verdict
  const event = VERDICT_TO_EVENT[input.verdict];
  if (!event) {
    return blocked("INVALID_VERDICT", { verdict: String(input.verdict) });
  }

  // 3. Four-eyes principle enforcement
  //    In regulated mode (allowSelfApproval: false), the reviewer
  //    must be different from the session initiator.
  //    This satisfies MaRisk AT 7.2 (5) — separation of duties.
  if (ctx.policy?.allowSelfApproval === false) {
    if (input.decidedBy === state.initiatedBy) {
      return blocked("SELF_APPROVAL_FORBIDDEN", {
        initiator: state.initiatedBy,
      });
    }
  }

  // 4. Resolve target phase via topology
  const target = evaluateWithEvent(state.phase, event);
  if (target === undefined) {
    return blocked("INVALID_TRANSITION", {
      event: String(event),
      phase: state.phase,
    });
  }

  // 5. Create evidence
  const decision: ReviewDecision = {
    verdict: input.verdict,
    rationale: input.rationale,
    decidedAt: ctx.now(),
    decidedBy: input.decidedBy,
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

  return { kind: "ok", state: finalState, evalResult, transitions: [transition] };
}
