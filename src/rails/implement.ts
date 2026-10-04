/**
 * @module implement
 * @description /implement rail — record implementation and advance into fresh post-implementation validation.
 *
 * Behavior:
 * 1. Validate admissibility (allowed in IMPLEMENTATION)
 * 2. Verify preconditions: ticket, plan, baseline validation passed
 * 3. Execute implementation via LLM executor
 * 4. Record ImplEvidence
 * 5. Enter IMPL_VALIDATION with an EMPTY post-implementation validation slot
 * 6. Runtime system work executes every active check against the frozen
 *    implementation subject before IMPL_REVIEW may become reachable
 *
 * Pre-implementation validation is baseline evidence only. It must never be
 * copied into `implValidation`: any repository mutation makes those results
 * stale for the implementation subject by definition.
 *
 * @version v2
 */

import type { SessionState } from '../state/schema.js';
import type { ImplEvidence, PlanRecord, TicketEvidence, LoopVerdict } from '../state/evidence.js';
import { Command, isCommandAllowed } from '../machine/commands.js';
import type { RailResult, RailContext, TransitionRecord } from './types.js';
import {
  autoAdvance,
  runConvergenceLoop,
  createPolicyEvalFn,
  buildImplReviewState,
  DEFAULT_MAX_REVIEW_ITERATIONS,
} from './types.js';
import { blocked } from '../config/reasons.js';
import { blockedFromOverflow } from './auto-advance-overflow.js';

// ─── Executor Interface ───────────────────────────────────────────────────────

export interface ImplExecutors {
  /**
   * Execute the implementation. Returns changed file lists.
   * The executor does the actual LLM coding work.
   */
  execute: (
    ticket: TicketEvidence,
    plan: PlanRecord,
  ) => Promise<{ changedFiles: string[]; domainFiles: string[] }>;

  /**
   * Historical bundled-review seam retained for rail-level tests. Production
   * review is host-orchestrated after fresh IMPL_VALIDATION completes.
   */
  reviewAndRevise: (
    impl: ImplEvidence,
    plan: PlanRecord,
    iteration: number,
  ) => Promise<{ verdict: LoopVerdict; updatedImpl?: ImplEvidence }>;
}

// ─── Rail ─────────────────────────────────────────────────────────────────────

/**
 * Deterministic, collision-resistant implementation id for the rail-level
 * executor seam. Rails must not use Node randomness; the id derives from the
 * frozen content digest and the recording timestamp, so it is unique per
 * `/implement` execution while staying pure. The canonical integration tool
 * path generates its own UUID instead.
 */
function deriveRailImplementationId(ctx: RailContext, digest: string): string {
  const hex = ctx
    .digest(`${digest}:${ctx.now()}`)
    .replace(/[^0-9a-f]/gi, '')
    .toLowerCase()
    .padEnd(30, '0')
    .slice(0, 30);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(12, 15)}-a${hex.slice(15, 18)}-${hex.slice(18, 30)}`;
}

async function collectAndAdvance(
  state: SessionState,
  work: { ticket: TicketEvidence; plan: PlanRecord },
  ctx: RailContext,
  executors: ImplExecutors,
  evalFn: ReturnType<typeof createPolicyEvalFn>,
): Promise<{
  currentImpl: ImplEvidence;
  nextState: SessionState;
  transitions: TransitionRecord[];
}> {
  const { changedFiles, domainFiles } = await executors.execute(work.ticket, work.plan);
  const digest = ctx.digest(changedFiles.sort().join('\n'));
  const currentImpl: ImplEvidence = {
    implementationId: deriveRailImplementationId(ctx, digest),
    changedFiles,
    domainFiles,
    digest,
    executedAt: ctx.now(),
  };
  const nextState: SessionState = {
    ...state,
    implementation: currentImpl,
    // Hard freshness boundary: baseline validation belongs to the approved plan
    // and pre-mutation repository state. A newly recorded implementation is a
    // different verification subject, so every post-implementation check starts
    // unproven and must be executed again through the canonical run-check path.
    implValidation: [],
    implReview: null,
    error: null,
  };
  const advanced = autoAdvance(nextState, evalFn, ctx);
  if (advanced.kind === 'overflow') {
    // Non-terminating advance (misconfigured topology). Keep the recorded evidence
    // at IMPLEMENTATION; the caller re-evaluates and surfaces the stop.
    return { currentImpl, nextState, transitions: [] };
  }
  return { currentImpl, nextState: advanced.state, transitions: [...advanced.transitions] };
}

export async function executeImplement(
  state: SessionState,
  ctx: RailContext,
  executors: ImplExecutors,
): Promise<RailResult> {
  if (!isCommandAllowed(state.phase, Command.IMPLEMENT)) {
    return blocked('COMMAND_NOT_ALLOWED', { command: '/implement', phase: state.phase });
  }
  if (!state.ticket) return blocked('TICKET_REQUIRED', { action: 'implementation' });
  if (!state.plan) return blocked('PLAN_REQUIRED', { action: 'implementation' });
  if (
    state.activeChecks.length > 0 &&
    !state.activeChecks.every((id) => state.validation.some((v) => v.checkId === id && v.passed))
  ) {
    return blocked('VALIDATION_INCOMPLETE');
  }

  const evalFn = createPolicyEvalFn(ctx);
  const {
    currentImpl,
    nextState,
    transitions: allTransitions,
  } = await collectAndAdvance(
    state,
    { ticket: state.ticket, plan: state.plan },
    ctx,
    executors,
    evalFn,
  );

  // With active checks, the freshness boundary above intentionally leaves the
  // machine in IMPL_VALIDATION. Runtime-owned system work executes those checks
  // and only then activates independent implementation review.
  const maxIterations = ctx.policy?.reviewBudget.implementation ?? DEFAULT_MAX_REVIEW_ITERATIONS;
  if (nextState.phase !== 'IMPL_REVIEW') {
    const result = evalFn(nextState);
    return { kind: 'ok', state: nextState, evalResult: result, transitions: allTransitions };
  }

  // A zero-check policy may still reach IMPL_REVIEW directly. Preserve the
  // rail's historical bundled-review behavior for that explicit vacuous case;
  // normal production flows with active checks never enter this branch.
  const plan = state.plan;
  const loop = await runConvergenceLoop(currentImpl, maxIterations, async (impl, iter) => {
    const review = await executors.reviewAndRevise(impl, plan, iter);
    return {
      verdict: review.verdict,
      ...(review.updatedImpl !== undefined ? { updated: review.updatedImpl } : {}),
    };
  });

  if (loop.kind === 'blocked') {
    return blocked('SUBAGENT_UNABLE_TO_REVIEW', {
      obligationId: 'impl-review',
      reason: `reviewer subagent declared the implementation unreviewable at iteration ${loop.iteration}`,
    });
  }

  const finalState: SessionState = {
    ...nextState,
    implementation: loop.artifact,
    implReview: buildImplReviewState(loop, ctx.now(), state.reviewCycles.implementation),
  };
  const advanced = autoAdvance(finalState, evalFn, ctx);
  if (advanced.kind === 'overflow') return blockedFromOverflow(advanced);
  return {
    kind: 'ok',
    state: advanced.state,
    evalResult: advanced.evalResult,
    transitions: [...allTransitions, ...advanced.transitions],
  };
}
