/**
 * @module plan
 * @description /plan rail — generate/accept a plan and run self-review loop.
 *
 * Behavior:
 * 1. Validate admissibility (allowed in TICKET and PLAN)
 * 2. Require ticket evidence
 * 3. Generate plan (via LLM executor) or accept user-provided text
 * 4. Run self-review loop (up to maxIterations from policy, digest-stop convergence)
 * 5. Update PlanRecord with version history
 * 6. Auto-advance (TICKET → PLAN → PLAN_REVIEW if loop converged)
 *
 * The self-review loop is the "digest-stop" mechanism:
 *   - Each iteration: review → verdict + optional revision
 *   - Convergence: verdict=approve AND revisionDelta=none
 *   - Force-stop: iteration >= maxIterations
 *
 * maxIterations is resolved from policy:
 * - SOLO: 1 (fast, minimal ceremony)
 * - TEAM/REGULATED: 3 (deep convergence)
 *
 * Side effects (LLM calls) are delegated to PlanExecutors (injected).
 *
 * @version v1
 */

import type { SessionState } from "../state/schema";
import type { TicketEvidence, PlanEvidence, LoopVerdict } from "../state/evidence";
import { Command, isCommandAllowed } from "../machine/commands";
import type { RailResult, RailContext } from "./types";
import { autoAdvance, runConvergenceLoop, createPolicyEvalFn, DEFAULT_MAX_REVIEW_ITERATIONS } from "./types";
import { blocked } from "../config/reasons";

// ─── Executor Interface ───────────────────────────────────────────────────────

/**
 * Side effects delegated to the adapter layer.
 * The rail orchestrates; the executor does the actual LLM work.
 */
export interface PlanExecutors {
  /** Generate a plan from the ticket. Returns plan body text. */
  generate: (ticket: TicketEvidence) => Promise<string>;
  /**
   * Review a plan iteration. Returns verdict and optional revised body.
   * If verdict=changes_requested AND revisedBody is provided, the plan is revised.
   * If verdict=approve, revisedBody is ignored.
   */
  selfReview: (
    plan: PlanEvidence,
    iteration: number,
  ) => Promise<{ verdict: LoopVerdict; revisedBody?: string }>;
}

// ─── Input ────────────────────────────────────────────────────────────────────

export interface PlanInput {
  /** User-provided plan text. If absent, plan is generated via executor. */
  readonly text?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Extract markdown section headers from plan text. */
function extractSections(body: string): string[] {
  return body
    .split("\n")
    .filter((line) => /^#{1,3}\s/.test(line))
    .map((line) => line.replace(/^#+\s*/, "").trim());
}

// ─── Rail ─────────────────────────────────────────────────────────────────────

export async function executePlan(
  state: SessionState,
  input: PlanInput,
  ctx: RailContext,
  executors: PlanExecutors,
): Promise<RailResult> {
  // 1. Admissibility
  if (!isCommandAllowed(state.phase, Command.PLAN)) {
    return blocked("COMMAND_NOT_ALLOWED", {
      command: "/plan",
      phase: state.phase,
    });
  }

  // 2. Require ticket
  if (!state.ticket) {
    return blocked("TICKET_REQUIRED", { action: "creating a plan" });
  }

  // 3. Generate or accept plan body
  const planBody = input.text?.trim()
    ? input.text
    : await executors.generate(state.ticket);

  if (!planBody.trim()) {
    return blocked("EMPTY_PLAN");
  }

  // 4. Create initial plan evidence
  const currentPlan: PlanEvidence = {
    body: planBody,
    digest: ctx.digest(planBody),
    sections: extractSections(planBody),
    createdAt: ctx.now(),
  };

  // 5. Preserve version history
  const history = state.plan
    ? [state.plan.current, ...state.plan.history]
    : [];

  // 6. Self-review loop (digest-stop)
  // maxIterations from policy (SOLO=1, TEAM/REGULATED=3)
  const maxIterations = ctx.policy?.maxSelfReviewIterations ?? DEFAULT_MAX_REVIEW_ITERATIONS;

  const loop = await runConvergenceLoop(currentPlan, maxIterations, async (plan, iter) => {
    const review = await executors.selfReview(plan, iter);
    if (review.verdict === "changes_requested" && review.revisedBody?.trim()) {
      history.unshift(plan);
      return {
        verdict: review.verdict,
        updated: {
          body: review.revisedBody,
          digest: ctx.digest(review.revisedBody),
          sections: extractSections(review.revisedBody),
          createdAt: ctx.now(),
        },
      };
    }
    return { verdict: review.verdict };
  });

  // 7. Build final state
  const nextState: SessionState = {
    ...state,
    plan: { current: loop.artifact, history },
    selfReview: {
      iteration: loop.iteration,
      maxIterations: loop.maxIterations,
      prevDigest: loop.prevDigest,
      currDigest: loop.currDigest,
      revisionDelta: loop.revisionDelta,
      verdict: loop.verdict,
    },
    error: null,
  };

  // 8. Auto-advance (TICKET → PLAN → PLAN_REVIEW if converged) — policy-aware
  const evalFn = createPolicyEvalFn(ctx);
  const { state: finalState, evalResult: result, transitions } = autoAdvance(nextState, evalFn, ctx);

  return { kind: "ok", state: finalState, evalResult: result, transitions };
}
