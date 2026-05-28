/**
 * @module validate
 * @description /validate rail — run verification checks via subprocess execution.
 *
 * Allowed only in VALIDATION phase. Runs all active checks by executing
 * discovered verification commands and recording execution evidence.
 *
 * After validation:
 * - ALL_PASSED → auto-advance to IMPLEMENTATION
 * - CHECK_FAILED → transition to PLAN (plan must be revised + re-approved)
 *
 * v2: Execution-evidence model. FlowGuard executes commands directly.
 * Agent self-report is no longer accepted.
 *
 * @version v2
 */

import type { SessionState } from '../state/schema.js';
import type { ValidationResult } from '../state/evidence-validation.js';
import { Command, isCommandAllowed } from '../machine/commands.js';
import type { RailResult, RailContext } from './types.js';
import { autoAdvance, createPolicyEvalFn } from './types.js';
import { blocked } from '../config/reasons.js';

// ─── Executor Interface ───────────────────────────────────────────────────────

/**
 * Executor for running a single verification check.
 *
 * In production: delegates to verification/executor.ts (subprocess execution).
 * In tests: can be mocked with deterministic results.
 */
export interface ValidateExecutors {
  /**
   * Run a single verification check and produce execution evidence.
   * Must return a ValidationResult with cryptographic evidence binding.
   */
  runCheck: (checkId: string, state: SessionState) => Promise<ValidationResult>;
}

// ─── Rail ─────────────────────────────────────────────────────────────────────

export async function executeValidate(
  state: SessionState,
  ctx: RailContext,
  executors: ValidateExecutors,
): Promise<RailResult> {
  // 1. Admissibility
  if (!isCommandAllowed(state.phase, Command.VALIDATE)) {
    return blocked('COMMAND_NOT_ALLOWED', {
      command: '/validate',
      phase: state.phase,
    });
  }

  // 2. Preconditions — vacuous truth: if no active checks, skip validation entirely
  if (state.activeChecks.length === 0) {
    // No checks to run — auto-advance immediately (vacuous truth)
    const evalFn = createPolicyEvalFn(ctx);
    const { state: finalState, evalResult, transitions } = autoAdvance(state, evalFn, ctx);
    return { kind: 'ok', state: finalState, evalResult, transitions };
  }

  if (!state.plan) {
    return blocked('PLAN_REQUIRED', { action: 'validation' });
  }

  // 3. Run all active checks
  const results: ValidationResult[] = [];

  for (const checkId of state.activeChecks) {
    const result = await executors.runCheck(checkId, state);
    results.push(result);
  }

  // 4. Record results in state
  // If any check failed, clear planning evidence so the plan must be revised and
  // re-approved (CHECK_FAILED → PLAN). Without clearing, autoAdvance would see
  // stale self-review/reviewDecision and skip past PLAN immediately.
  const allPassed = results.every((r) => r.passed);
  const nextState: SessionState = {
    ...state,
    validation: results,
    error: null,
    ...(allPassed
      ? {}
      : {
          selfReview: null,
          reviewDecision: null,
          plan: state.plan ? { ...state.plan, reviewFindings: undefined } : null,
        }),
  };

  // 5. Auto-advance (ALL_PASSED → IMPLEMENTATION, or CHECK_FAILED → PLAN) — policy-aware
  const evalFn = createPolicyEvalFn(ctx);
  const { state: finalState, evalResult, transitions } = autoAdvance(nextState, evalFn, ctx);

  return { kind: 'ok', state: finalState, evalResult, transitions };
}
