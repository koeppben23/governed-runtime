/**
 * @module continue
 * @description /continue rail — routing command that advances the workflow.
 *
 * Behavior depends on current phase:
 * - User Gate (PLAN_REVIEW, EVIDENCE_REVIEW, ARCH_REVIEW): return "waiting" — use /review-decision
 * - Terminal (COMPLETE, ARCH_COMPLETE, REVIEW_COMPLETE): return "terminal"
 * - VALIDATION: run all active checks, then evaluate
 * - PLAN: run one more self-review iteration, then evaluate
 * - IMPL_REVIEW: run one more review iteration, then evaluate
 * - ARCHITECTURE: run one more ADR self-review iteration, then evaluate
 * - Other phases: just evaluate (may advance if evidence is present)
 *
 * /continue is the universal "do the next thing" command.
 * It never blocks — it always returns a result telling the user what happened.
 *
 * maxIterations for review loops are resolved from policy:
 * - Existing state values are used if present (selfReview.maxIterations)
 * - Falls back to policy.maxSelfReviewIterations / policy.maxImplReviewIterations
 * - Ultimate fallback: 3 (TEAM_POLICY default)
 *
 * @version v1
 */

import type { SessionState } from '../state/schema.js';
import type {
  CheckId,
  ValidationResult,
  PlanEvidence,
  ImplEvidence,
  PlanRecord,
  LoopVerdict,
  ArchitectureDecision,
} from '../state/evidence.js';
import { validateAdrSections } from '../state/evidence.js';
import { Command, isCommandAllowed } from '../machine/commands.js';
import { USER_GATES, TERMINAL } from '../machine/topology.js';
import type { RailResult, RailContext } from './types.js';
import {
  autoAdvance,
  runSingleIteration,
  createPolicyEvalFn,
  DEFAULT_MAX_REVIEW_ITERATIONS,
} from './types.js';
import { blocked } from '../config/reasons.js';

// ─── Executor Interface ───────────────────────────────────────────────────────

/**
 * Side effects for phase-specific work.
 * Only the relevant executor is called, based on current phase.
 */
export interface ContinueExecutors {
  /** Run a single validation check. */
  runCheck: (checkId: CheckId, state: SessionState) => Promise<ValidationResult>;
  /** Run one self-review iteration (PLAN phase). */
  selfReview: (
    plan: PlanEvidence,
    iteration: number,
  ) => Promise<{ verdict: LoopVerdict; revisedBody?: string }>;
  /** Run one impl review iteration (IMPL_REVIEW phase). */
  implReview: (
    impl: ImplEvidence,
    plan: PlanRecord,
    iteration: number,
  ) => Promise<{ verdict: LoopVerdict; updatedImpl?: ImplEvidence }>;
  /** Run one ADR self-review iteration (ARCHITECTURE phase). */
  architectureReview: (
    adr: ArchitectureDecision,
    iteration: number,
  ) => Promise<{ verdict: LoopVerdict; revisedText?: string }>;
}

// ─── Rail ─────────────────────────────────────────────────────────────────────

export async function executeContinue(
  state: SessionState,
  ctx: RailContext,
  executors: ContinueExecutors,
): Promise<RailResult> {
  // 1. Admissibility
  if (!isCommandAllowed(state.phase, Command.CONTINUE)) {
    return blocked('COMMAND_NOT_ALLOWED', {
      command: '/continue',
      phase: state.phase,
    });
  }

  // 2. Quick exits for user gates and terminal
  if (TERMINAL.has(state.phase)) {
    return { kind: 'ok', state, evalResult: { kind: 'terminal' }, transitions: [] };
  }
  if (USER_GATES.has(state.phase)) {
    return {
      kind: 'ok',
      state,
      evalResult: {
        kind: 'waiting',
        phase: state.phase,
        reason: `Use /review-decision to provide your verdict at ${state.phase}`,
      },
      transitions: [],
    };
  }

  // 3. Phase-specific work
  let workState = state;

  switch (state.phase) {
    case 'VALIDATION':
      workState = await runValidationChecks(workState, ctx, executors);
      break;

    case 'PLAN':
      workState = await runOneSelfReviewIteration(workState, ctx, executors);
      break;

    case 'IMPL_REVIEW':
      workState = await runOneImplReviewIteration(workState, ctx, executors);
      break;

    case 'ARCHITECTURE':
      workState = await runOneArchitectureReviewIteration(workState, ctx, executors);
      break;

    // Other phases: no work needed, just evaluate
  }

  // 4. Auto-advance (policy-aware)
  const evalFn = createPolicyEvalFn(ctx);
  const {
    state: advancedState,
    evalResult: result,
    transitions,
  } = autoAdvance(workState, evalFn, ctx);

  // Finalize ADR status on architecture flow completion (solo auto-approve)
  const finalState =
    advancedState.phase === 'ARCH_COMPLETE' && advancedState.architecture
      ? {
          ...advancedState,
          architecture: { ...advancedState.architecture, status: 'accepted' as const },
        }
      : advancedState;

  return { kind: 'ok', state: finalState, evalResult: result, transitions };
}

// ─── Phase-Specific Handlers ──────────────────────────────────────────────────

/** Run all active validation checks. Records results in state.validation.
 *  If any check fails, clears selfReview and reviewDecision so the plan
 *  must be revised and re-approved (CHECK_FAILED → PLAN semantics). */
async function runValidationChecks(
  state: SessionState,
  ctx: RailContext,
  executors: ContinueExecutors,
): Promise<SessionState> {
  const results: ValidationResult[] = [];

  for (const checkId of state.activeChecks) {
    const result = await executors.runCheck(checkId, state);
    results.push(result);
  }

  const allPassed = results.every((r) => r.passed);
  return {
    ...state,
    validation: results,
    ...(allPassed ? {} : { selfReview: null, reviewDecision: null }),
  };
}

/** Run one self-review iteration (for PLAN phase). */
async function runOneSelfReviewIteration(
  state: SessionState,
  ctx: RailContext,
  executors: ContinueExecutors,
): Promise<SessionState> {
  if (!state.plan) return state;

  const currentPlan = state.plan.current;
  const planHistory = state.plan.history;
  const startIteration = state.selfReview?.iteration ?? 0;
  // maxIterations: existing state value > policy > fallback 3
  const maxIterations =
    state.selfReview?.maxIterations ??
    ctx.policy?.maxSelfReviewIterations ??
    DEFAULT_MAX_REVIEW_ITERATIONS;

  const loop = await runSingleIteration(
    currentPlan,
    startIteration,
    maxIterations,
    async (plan, iter) => {
      const review = await executors.selfReview(plan, iter);
      if (review.verdict === 'changes_requested' && review.revisedBody?.trim()) {
        return {
          verdict: review.verdict,
          updated: {
            body: review.revisedBody,
            digest: ctx.digest(review.revisedBody),
            sections: currentPlan.sections, // Will be re-extracted by adapter
            createdAt: ctx.now(),
          },
        };
      }
      return { verdict: review.verdict };
    },
  );

  // No iteration ran (already at max)
  if (loop.iteration === startIteration) return state;

  const updatedPlan =
    loop.artifact !== currentPlan
      ? { current: loop.artifact, history: [currentPlan, ...planHistory] }
      : state.plan;

  return {
    ...state,
    plan: updatedPlan,
    selfReview: {
      iteration: loop.iteration,
      maxIterations: loop.maxIterations,
      prevDigest: loop.prevDigest,
      currDigest: loop.currDigest,
      revisionDelta: loop.revisionDelta,
      verdict: loop.verdict,
    },
  };
}

/** Run one impl review iteration (for IMPL_REVIEW phase). */
async function runOneImplReviewIteration(
  state: SessionState,
  ctx: RailContext,
  executors: ContinueExecutors,
): Promise<SessionState> {
  if (!state.implementation || !state.plan) return state;

  const currentImpl = state.implementation;
  const plan = state.plan;
  const startIteration = state.implReview?.iteration ?? 0;
  // maxIterations: existing state value > policy > fallback 3
  const maxIterations =
    state.implReview?.maxIterations ??
    ctx.policy?.maxImplReviewIterations ??
    DEFAULT_MAX_REVIEW_ITERATIONS;

  const loop = await runSingleIteration(
    currentImpl,
    startIteration,
    maxIterations,
    async (impl, iter) => {
      const review = await executors.implReview(impl, plan, iter);
      return { verdict: review.verdict, updated: review.updatedImpl };
    },
  );

  // No iteration ran (already at max)
  if (loop.iteration === startIteration) return state;

  return {
    ...state,
    implementation: loop.artifact,
    implReview: {
      iteration: loop.iteration,
      maxIterations: loop.maxIterations,
      prevDigest: loop.prevDigest,
      currDigest: loop.currDigest,
      revisionDelta: loop.revisionDelta,
      verdict: loop.verdict,
      executedAt: ctx.now(),
    },
  };
}

/** Run one ADR self-review iteration (for ARCHITECTURE phase). */
async function runOneArchitectureReviewIteration(
  state: SessionState,
  ctx: RailContext,
  executors: ContinueExecutors,
): Promise<SessionState> {
  if (!state.architecture) return state;

  const currentAdr = state.architecture;
  const startIteration = state.selfReview?.iteration ?? 0;
  // maxIterations: existing state value > policy > fallback 3
  const maxIterations =
    state.selfReview?.maxIterations ??
    ctx.policy?.maxSelfReviewIterations ??
    DEFAULT_MAX_REVIEW_ITERATIONS;

  const loop = await runSingleIteration(
    currentAdr,
    startIteration,
    maxIterations,
    async (adr, iter) => {
      const review = await executors.architectureReview(adr, iter);
      if (review.verdict === 'changes_requested' && review.revisedText?.trim()) {
        const revisedText = review.revisedText.trim();
        // Validate MADR sections on revision
        const missingSections = validateAdrSections(revisedText);
        if (missingSections.length > 0) {
          // Invalid revision — treat as no change (keep current ADR)
          return { verdict: review.verdict };
        }
        return {
          verdict: review.verdict,
          updated: {
            ...adr,
            adrText: revisedText,
            digest: ctx.digest(revisedText),
          },
        };
      }
      return { verdict: review.verdict };
    },
  );

  // No iteration ran (already at max)
  if (loop.iteration === startIteration) return state;

  const updatedArchitecture = loop.artifact !== currentAdr ? loop.artifact : state.architecture;

  return {
    ...state,
    architecture: updatedArchitecture,
    selfReview: {
      iteration: loop.iteration,
      maxIterations: loop.maxIterations,
      prevDigest: loop.prevDigest,
      currDigest: loop.currDigest,
      revisionDelta: loop.revisionDelta,
      verdict: loop.verdict,
    },
  };
}
