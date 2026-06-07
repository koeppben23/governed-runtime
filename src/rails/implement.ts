/**
 * @module implement
 * @description /implement rail — execute implementation and auto-advance through IMPL_REVIEW.
 *
 * Behavior:
 * 1. Validate admissibility (allowed in IMPLEMENTATION)
 * 2. Verify preconditions: ticket, plan, validation passed
 * 3. Execute implementation via LLM executor
 * 4. Record ImplEvidence
 * 5. Auto-advance to IMPL_REVIEW
 * 6. Run impl review loop (up to maxIterations from policy, digest-stop)
 * 7. Auto-advance to EVIDENCE_REVIEW if review converges
 *
 * maxIterations is resolved from policy:
 * - SOLO: 1 (fast, minimal ceremony)
 * - TEAM/REGULATED: 3 (deep convergence)
 *
 * The auto-advance through IMPL_REVIEW eliminates /continue in the happy path.
 * If the review loop doesn't converge, stops at IMPL_REVIEW.
 *
 * @version v1
 */

import type { SessionState } from '../state/schema.js';
import type { ImplEvidence, PlanRecord, TicketEvidence, LoopVerdict } from '../state/evidence.js';
import { Command, isCommandAllowed } from '../machine/commands.js';
import type { RailResult, RailContext, TransitionRecord } from './types.js';
import {
  applyTransition,
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
   * Review the implementation against the plan.
   * Returns verdict. If changes_requested, the executor may have revised the impl
   * (reflected in updatedImpl).
   */
  reviewAndRevise: (
    impl: ImplEvidence,
    plan: PlanRecord,
    iteration: number,
  ) => Promise<{ verdict: LoopVerdict; updatedImpl?: ImplEvidence }>;
}

// ─── Rail ─────────────────────────────────────────────────────────────────────

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
  const currentImpl: ImplEvidence = {
    changedFiles,
    domainFiles,
    digest: ctx.digest(changedFiles.sort().join('\n')),
    executedAt: ctx.now(),
  };
  let nextState: SessionState = {
    ...state,
    implementation: currentImpl,
    implReview: null,
    error: null,
  };
  const allTransitions: TransitionRecord[] = [];
  const evalAfterImpl = evalFn(nextState);
  if (evalAfterImpl.kind === 'transition') {
    const at = ctx.now();
    allTransitions.push({
      from: nextState.phase,
      to: evalAfterImpl.target,
      event: evalAfterImpl.event,
      at,
    });
    nextState = applyTransition(
      nextState,
      nextState.phase,
      evalAfterImpl.target,
      evalAfterImpl.event,
      at,
    );
  }
  return { currentImpl, nextState, transitions: allTransitions };
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

  const maxIterations = ctx.policy?.maxImplReviewIterations ?? DEFAULT_MAX_REVIEW_ITERATIONS;
  if (nextState.phase !== 'IMPL_REVIEW') {
    const result = evalFn(nextState);
    return { kind: 'ok', state: nextState, evalResult: result, transitions: allTransitions };
  }

  const plan = state.plan;
  const loop = await runConvergenceLoop(currentImpl, maxIterations, async (impl, iter) => {
    const review = await executors.reviewAndRevise(impl, plan, iter);
    return { verdict: review.verdict, updated: review.updatedImpl };
  });

  if (loop.kind === 'blocked') {
    return blocked('SUBAGENT_UNABLE_TO_REVIEW', {
      obligationId: 'impl-review',
      reason: `reviewer subagent declared the implementation unreviewable at iteration ${loop.iteration}`,
    });
  }

  let finalState: SessionState = {
    ...nextState,
    implementation: loop.artifact,
    implReview: buildImplReviewState(loop, ctx.now()),
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
