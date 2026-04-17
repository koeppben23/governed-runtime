/**
 * @module abort
 * @description /abort rail — emergency clean termination of a FlowGuard session.
 *
 * Bypasses the topology entirely. Directly sets phase = COMPLETE with an error
 * marker (code: "ABORTED"). This is the escape hatch for:
 * - CI/CD pipeline aborts
 * - User cancellation
 * - Unrecoverable errors where the session must be terminated cleanly
 *
 * Design:
 * - Does NOT use the topology (no ABORT transition in the transition table)
 * - Does NOT use the evaluator (no guard evaluation)
 * - Directly writes phase = COMPLETE + error = ABORTED
 * - The ABORT event is recorded in the transition field for audit trail
 * - Idempotent at COMPLETE (already terminal — no-op)
 *
 * After abort:
 * - state.phase === "COMPLETE"
 * - state.error !== null (code: "ABORTED")
 * - state.transition.event === "ABORT"
 * - The session is terminal — no further commands except /review
 *
 * Distinguishing aborted from completed:
 * - Normal completion: state.error === null at COMPLETE
 * - Aborted: state.error.code === "ABORTED" at COMPLETE
 *
 * @version v1
 */

import type { SessionState } from '../state/schema';
import type { ErrorInfo } from '../state/evidence';
import { evaluate } from '../machine/evaluate';
import type { RailResult, RailContext, TransitionRecord } from './types';

// ─── Input ────────────────────────────────────────────────────────────────────

export interface AbortInput {
  /** Reason for aborting. Recorded in error.message for audit trail. */
  readonly reason: string;
  /** Who initiated the abort (user, pipeline, system). */
  readonly actor: string;
}

// ─── Rail ─────────────────────────────────────────────────────────────────────

export function executeAbort(state: SessionState, input: AbortInput, ctx: RailContext): RailResult {
  // 1. Idempotent at COMPLETE — already terminal
  if (state.phase === 'COMPLETE') {
    const result = evaluate(state, ctx.policy);
    return { kind: 'ok', state, evalResult: result, transitions: [] };
  }

  // 2. Record abort error
  const now = ctx.now();

  const error: ErrorInfo = {
    code: 'ABORTED',
    message: input.reason || 'Session aborted',
    recoveryHint: 'Start a new session with /hydrate',
    occurredAt: now,
  };

  // 3. Directly set terminal state (bypasses topology)
  const finalState: SessionState = {
    ...state,
    phase: 'COMPLETE',
    transition: {
      from: state.phase,
      to: 'COMPLETE',
      event: 'ABORT',
      at: now,
    },
    error,
  };

  // Record the bypass transition for audit
  const transition: TransitionRecord = {
    from: state.phase,
    to: 'COMPLETE',
    event: 'ABORT',
    at: now,
  };

  // 4. Evaluate (returns "terminal") — policy-aware
  const result = evaluate(finalState, ctx.policy);

  return { kind: 'ok', state: finalState, evalResult: result, transitions: [transition] };
}
