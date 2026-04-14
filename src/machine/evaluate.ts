/**
 * @module evaluate
 * @description Pure evaluator — determines the next event/phase from current state.
 *
 *              Three variants:
 *              - evaluate():          Guard-based phases (machine decides autonomously)
 *              - evaluateWithEvent(): User-gate phases (human provides explicit event)
 *              Both support optional policy parameter for mode-aware behavior.
 *
 *              ~95 lines replace 2,177 lines of phase_kernel.py.
 *
 * Contract:
 * - evaluate() is a PURE FUNCTION: same state + policy → same result. No side effects.
 * - evaluateWithEvent() is a PURE FUNCTION: phase + event → target phase.
 * - Neither function mutates state, writes files, or produces audit events.
 *   That's the rail's responsibility.
 *
 * Policy-aware behavior:
 * - requireHumanGates: false → auto-approve at User Gates (solo mode)
 * - requireHumanGates: true  → return "waiting" at User Gates (team/regulated)
 * - No policy → defaults to requireHumanGates: true (safe default)
 *
 * Auto-approve safety:
 * When requireHumanGates is false, the evaluator fires APPROVE at User Gates.
 * This is safe because the APPROVE clearing pattern in review-decision is a no-op
 * (keep everything). No evidence is lost during auto-advance through gates.
 *
 * @version v1
 */

import type { SessionState, Phase, Event } from "../state/schema";
import { GUARDS } from "./guards";
import { resolveTransition, USER_GATES, TERMINAL } from "./topology";

// ─── Result Types ─────────────────────────────────────────────────────────────

/** Guard matched → transition to target phase. */
export interface EvalTransition {
  readonly kind: "transition";
  readonly event: Event;
  readonly target: Phase;
}

/** User Gate — machine is waiting for explicit human command. */
export interface EvalWaiting {
  readonly kind: "waiting";
  readonly phase: Phase;
  readonly reason: string;
}

/** Terminal — workflow complete, no further transitions. */
export interface EvalTerminal {
  readonly kind: "terminal";
}

/**
 * Phase needs more work or evidence before a guard can fire.
 * Normal state — NOT a bug. Examples:
 * - TICKET without ticket evidence (waiting for /ticket)
 * - VALIDATION before checks have been run (waiting for /continue)
 * - IMPLEMENTATION before impl executed (waiting for /implement)
 *
 * The rail/caller decides what to do: prompt user, run work, etc.
 */
export interface EvalPending {
  readonly kind: "pending";
  readonly phase: Phase;
}

export type EvalResult = EvalTransition | EvalWaiting | EvalTerminal | EvalPending;

// ─── Evaluator ────────────────────────────────────────────────────────────────

/**
 * Evaluate the current state to determine what happens next.
 *
 * Algorithm:
 * 1. If phase is terminal → return terminal.
 * 2. If phase is a User Gate:
 *    a. If policy.requireHumanGates === false → auto-approve (solo mode)
 *    b. Otherwise → return waiting (human must decide)
 * 3. Otherwise, iterate guards for the current phase (first match wins).
 * 4. If a guard matches, resolve the transition via topology.
 * 5. If no guard matches → return pending (phase needs work/evidence).
 *
 * This function is the HEART of the governance machine.
 * Every phase transition flows through here.
 *
 * @param state - Current session state.
 * @param policy - Optional policy for mode-aware behavior.
 *                 If omitted, defaults to requireHumanGates: true (safe default).
 */
export function evaluate(
  state: SessionState,
  policy?: { requireHumanGates?: boolean },
): EvalResult {
  const { phase } = state;

  // 1. Terminal — done
  if (TERMINAL.has(phase)) {
    return { kind: "terminal" };
  }

  // 2. User Gate — policy-dependent
  if (USER_GATES.has(phase)) {
    // Solo mode: auto-approve at user gates.
    // Fires APPROVE event, which resolveTransition maps to the next phase.
    // Safe because APPROVE clearing pattern is a no-op (keep everything).
    if (policy?.requireHumanGates === false) {
      const target = resolveTransition(phase, "APPROVE");
      if (target) {
        return { kind: "transition", event: "APPROVE", target };
      }
    }

    // Team/regulated mode (or no policy): wait for human decision.
    return {
      kind: "waiting",
      phase,
      reason:
        phase === "PLAN_REVIEW"
          ? "Awaiting plan review decision (approve / changes_requested / reject)"
          : "Awaiting evidence review decision (approve / changes_requested / reject)",
    };
  }

  // 3. Guard-based — evaluate guards in order
  const guardEntries = GUARDS.get(phase);
  if (!guardEntries) {
    return { kind: "pending", phase };
  }

  for (const { event, guard } of guardEntries) {
    if (guard(state)) {
      const target = resolveTransition(phase, event);
      if (target === undefined) {
        // Topology gap — guards and topology are misaligned.
        // This IS a bug (unlike pending). Log and treat as pending.
        return { kind: "pending", phase };
      }
      return { kind: "transition", event, target };
    }
  }

  // 4. No guard matched — phase needs more work or evidence
  return { kind: "pending", phase };
}

// ─── User-Event Evaluator ─────────────────────────────────────────────────────

/**
 * Evaluate with an explicit user-provided event.
 * Used by /review-decision at User Gate phases.
 *
 * The rail maps the user's verdict to an Event:
 *   "approve"            → APPROVE
 *   "changes_requested"  → CHANGES_REQUESTED
 *   "reject"             → REJECT
 *
 * Returns the target phase, or undefined if the event is invalid for this phase.
 * Undefined result → the rail MUST reject the command (fail-closed).
 */
export function evaluateWithEvent(phase: Phase, event: Event): Phase | undefined {
  return resolveTransition(phase, event);
}
