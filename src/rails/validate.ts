/**
 * @module validate
 * @description /validate rail — run verification checks via subprocess execution.
 *
 * Allowed in VALIDATION and IMPL_VALIDATION phases. Runs all active checks by
 * executing discovered verification commands and recording execution evidence.
 *
 * After validation:
 * - VALIDATION: ALL_PASSED → IMPLEMENTATION; CHECK_FAILED → PLAN
 * - IMPL_VALIDATION: ALL_PASSED → IMPL_REVIEW; CHECK_FAILED → IMPLEMENTATION
 * - Either phase: CHECK_ERRORED stays in same phase for retry
 *
 * v2: Execution-evidence model. FlowGuard executes commands directly.
 * Agent self-report is no longer accepted.
 *
 * v3: IMPL_VALIDATION support — post-implementation checks write to
 * implValidation and keep the approved plan intact.
 *
 * @version v3
 */

import type { SessionState } from '../state/schema.js';
import type { ValidationResult } from '../state/evidence-validation.js';
import { isExecutionError } from '../state/evidence-validation.js';
import { Command, isCommandAllowed } from '../machine/commands.js';
import type { RailResult, RailContext } from './types.js';
import { autoAdvance, createPolicyEvalFn } from './types.js';
import { blockedFromOverflow } from './auto-advance-overflow.js';
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
    const advanced = autoAdvance(state, evalFn, ctx);
    if (advanced.kind === 'overflow') {
      return blockedFromOverflow(advanced);
    }
    const { state: finalState, evalResult, transitions } = advanced;
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

  // 4. Record results in state — phase-aware slot and failure semantics.
  const nextState = buildValidationResultState(state, results);

  // 5. Auto-advance — policy-aware
  const evalFn = createPolicyEvalFn(ctx);
  const advanced = autoAdvance(nextState, evalFn, ctx);
  if (advanced.kind === 'overflow') {
    return blockedFromOverflow(advanced);
  }
  const { state: finalState, evalResult, transitions } = advanced;

  return { kind: 'ok', state: finalState, evalResult, transitions };
}

/**
 * Build the next state after validation — phase-aware slot assignment and
 * evidence clearing.
 *
 * In IMPL_VALIDATION: writes to implValidation, clears implementation on
 * genuine failure (CODE is wrong), keeps the approved plan intact.
 * In VALIDATION: writes to validation, clears plan/self-review/reviewDecision
 * on genuine failure (PLAN is wrong).
 * Execution errors (timeout/command-not-found) never clear evidence in either
 * phase — the session stays for a retry.
 */
function buildValidationResultState(
  state: SessionState,
  results: ValidationResult[],
): SessionState {
  const allPassed = results.every((r) => r.passed);
  const hasExecutionError = results.some(isExecutionError);
  const genuinelyFailed = !allPassed && !hasExecutionError;
  const postImplementation = state.phase === 'IMPL_VALIDATION';

  return {
    ...state,
    ...(postImplementation ? { implValidation: results } : { validation: results }),
    error: null,
    ...(postImplementation && genuinelyFailed ? { implementation: null } : {}),
    ...(!postImplementation && genuinelyFailed
      ? {
          selfReview: null,
          reviewDecision: null,
          plan: state.plan ? { ...state.plan, reviewFindings: undefined } : null,
        }
      : {}),
  };
}
