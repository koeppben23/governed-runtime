/**
 * @module validate
 * @description /validate rail — explicitly run validation checks.
 *
 * Allowed only in VALIDATION phase. Runs all active checks and records results.
 * After validation:
 * - ALL_PASSED → auto-advance to IMPLEMENTATION
 * - CHECK_FAILED → transition to PLAN (plan must be revised + re-approved)
 *
 * This is the explicit alternative to /continue at VALIDATION.
 * Benefit: clearer intent ("I want to validate") vs. generic routing.
 *
 * The checks themselves are delegated to an executor interface.
 * The rail only orchestrates: which checks to run, recording results, evaluating.
 *
 * @version v1
 */

import type { SessionState } from '../state/schema';
import type { CheckId, ValidationResult } from '../state/evidence';
import { Command, isCommandAllowed } from '../machine/commands';
import { evaluate } from '../machine/evaluate';
import type { RailResult, RailContext } from './types';
import { autoAdvance } from './types';
import { blocked } from '../config/reasons';

// ─── Executor Interface ───────────────────────────────────────────────────────

export interface ValidateExecutors {
  /**
   * Run a single validation check.
   * The executor performs the actual check logic (test coverage analysis,
   * rollback safety analysis, business rules compliance, etc.).
   */
  runCheck: (checkId: CheckId, state: SessionState) => Promise<ValidationResult>;
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

  // 2. Preconditions
  if (state.activeChecks.length === 0) {
    return blocked('NO_ACTIVE_CHECKS');
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
    ...(allPassed ? {} : { selfReview: null, reviewDecision: null }),
  };

  // 5. Auto-advance (ALL_PASSED → IMPLEMENTATION, or CHECK_FAILED → PLAN) — policy-aware
  const evalFn = (s: SessionState) => evaluate(s, ctx.policy);
  const { state: finalState, evalResult, transitions } = autoAdvance(nextState, evalFn, ctx);

  return { kind: 'ok', state: finalState, evalResult, transitions };
}
