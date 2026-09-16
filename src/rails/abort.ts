/**
 * @module abort
 * @description /abort rail — emergency clean termination of a FlowGuard session.
 *
 * Transitions through the explicit ABORT topology event into the ABORTED terminal
 * position with an error marker (code: "ABORTED"). This is the escape hatch for:
 * - CI/CD pipeline aborts
 * - User cancellation
 * - Unrecoverable errors where the session must be terminated cleanly
 *
 * Design:
 * - Resolves ABORT through the topology; undefined transitions fail closed
 * - Does NOT use guard evaluation to select a transition
 * - The ABORT event is recorded in the transition field for audit trail
 * - Idempotent at any terminal phase — already terminal, so abort is a no-op
 *
 * After abort:
 * - state.phase === "ABORTED"
 * - state.error !== null (code: "ABORTED")
 * - state.transition.event === "ABORT"
 * - The session is terminal — no further commands except /review
 *
 * Distinguishing aborted from completed:
 * - Normal completion: state.error === null at COMPLETE
 * - Aborted: state.error.code === "ABORTED" at ABORTED
 *
 * @version v1
 */

import type { SessionState } from '../state/schema.js';
import type { ErrorInfo } from '../state/evidence.js';
import { evaluate, evaluateWithEvent } from '../machine/evaluate.js';
import { TERMINAL } from '../machine/topology.js';
import {
  applyTransition,
  type RailResult,
  type RailContext,
  type TransitionRecord,
} from './types.js';

// ─── Input ────────────────────────────────────────────────────────────────────

export interface AbortInput {
  /** Reason for aborting. Recorded in error.message for audit trail. */
  readonly reason: string;
  /** Who initiated the abort (user, pipeline, system). */
  readonly actor: string;
}

// ─── Rail ─────────────────────────────────────────────────────────────────────

export function executeAbort(state: SessionState, input: AbortInput, ctx: RailContext): RailResult {
  // 1. Idempotent at any terminal phase — already terminal, no overwrite
  if (TERMINAL.has(state.phase)) {
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

  // 3. Resolve the explicit terminal transition through the canonical topology.
  const target = evaluateWithEvent(state.phase, 'ABORT');
  if (target === undefined) {
    return {
      kind: 'blocked',
      code: 'INVALID_TRANSITION',
      reason: `No ABORT transition is defined for phase ${state.phase}`,
    };
  }
  const transitionedState = applyTransition(
    {
      ...state,
      error,
    },
    state.phase,
    target,
    'ABORT',
    now,
  );
  const finalState: SessionState = { ...transitionedState, error };

  // Record the bypass transition for audit
  const transition: TransitionRecord = {
    from: state.phase,
    to: target,
    event: 'ABORT',
    at: now,
  };

  // 4. Evaluate (returns "terminal") — policy-aware
  const result = evaluate(finalState, ctx.policy);

  return { kind: 'ok', state: finalState, evalResult: result, transitions: [transition] };
}
