/**
 * @module topology
 * @description Transition table — the formal state machine graph.
 *              Phase x Event → Phase. Immutable. Read-only at runtime.
 *
 *              ~80 lines replace 1,377 lines of YAML (phase_api.yaml + topology.yaml).
 *
 * Rules:
 * - COMPLETE is terminal (empty map — no outgoing transitions).
 * - ERROR loops back to the same phase in all non-user-gate, non-terminal phases.
 * - User-gate phases (PLAN_REVIEW, EVIDENCE_REVIEW) have NO error event
 *   (human is in control — machine cannot error during a human decision).
 * - Every transition is explicitly listed. No wildcards, no inheritance.
 *
 * @version v1
 */

import type { Phase, Event } from "../state/schema";

// ─── Transition Table ─────────────────────────────────────────────────────────

/**
 * The complete transition table.
 * For each phase: a map of events to target phases.
 *
 * Reading: TRANSITIONS.get("TICKET")?.get("PLAN_READY") === "PLAN"
 */
export const TRANSITIONS: ReadonlyMap<Phase, ReadonlyMap<Event, Phase>> = new Map<Phase, ReadonlyMap<Event, Phase>>([

  // ── TICKET ──────────────────────────────────────────────────
  // Stays until ticket+plan evidence exists, then advances to PLAN.
  ["TICKET", new Map<Event, Phase>([
    ["PLAN_READY", "PLAN"],
    ["ERROR",      "TICKET"],
  ])],

  // ── PLAN ────────────────────────────────────────────────────
  // Self-review loop: iterates until convergence (digest-stop).
  ["PLAN", new Map<Event, Phase>([
    ["SELF_REVIEW_MET",     "PLAN_REVIEW"],
    ["SELF_REVIEW_PENDING", "PLAN"],
    ["ERROR",               "PLAN"],
  ])],

  // ── PLAN_REVIEW (User Gate) ─────────────────────────────────
  // Human decides: approve → VALIDATION, changes → PLAN, reject → TICKET.
  ["PLAN_REVIEW", new Map<Event, Phase>([
    ["APPROVE",            "VALIDATION"],
    ["CHANGES_REQUESTED",  "PLAN"],
    ["REJECT",             "TICKET"],
  ])],

  // ── VALIDATION ──────────────────────────────────────────────
  // Runs N checks in one phase (not N separate phases).
  // CHECK_FAILED → PLAN: failed validation means the plan is deficient.
  // The plan must be revised and re-approved — that's the governance guarantee.
  ["VALIDATION", new Map<Event, Phase>([
    ["ALL_PASSED",   "IMPLEMENTATION"],
    ["CHECK_FAILED", "PLAN"],
    ["ERROR",        "VALIDATION"],
  ])],

  // ── IMPLEMENTATION ──────────────────────────────────────────
  // Executes implementation, then advances to review.
  ["IMPLEMENTATION", new Map<Event, Phase>([
    ["IMPL_COMPLETE", "IMPL_REVIEW"],
    ["ERROR",         "IMPLEMENTATION"],
  ])],

  // ── IMPL_REVIEW ─────────────────────────────────────────────
  // Review loop: iterates until convergence (digest-stop, max 3).
  ["IMPL_REVIEW", new Map<Event, Phase>([
    ["REVIEW_MET",     "EVIDENCE_REVIEW"],
    ["REVIEW_PENDING", "IMPL_REVIEW"],
    ["ERROR",          "IMPL_REVIEW"],
  ])],

  // ── EVIDENCE_REVIEW (User Gate) ─────────────────────────────
  // Human decides: approve → COMPLETE, changes → IMPLEMENTATION, reject → TICKET.
  // Option A: changes_requested goes to IMPLEMENTATION (no rework classifier).
  ["EVIDENCE_REVIEW", new Map<Event, Phase>([
    ["APPROVE",            "COMPLETE"],
    ["CHANGES_REQUESTED",  "IMPLEMENTATION"],
    ["REJECT",             "TICKET"],
  ])],

  // ── COMPLETE (Terminal) ─────────────────────────────────────
  // No outgoing transitions. Workflow is done.
  ["COMPLETE", new Map<Event, Phase>()],
]);

// ─── Phase Classifications ────────────────────────────────────────────────────

/** User-gate phases: machine waits for explicit human input via /review-decision. */
export const USER_GATES: ReadonlySet<Phase> = new Set<Phase>([
  "PLAN_REVIEW",
  "EVIDENCE_REVIEW",
]);

/** Terminal phases: no outgoing transitions, workflow complete. */
export const TERMINAL: ReadonlySet<Phase> = new Set<Phase>([
  "COMPLETE",
]);

// ─── Transition Resolution ────────────────────────────────────────────────────

/**
 * Resolve a transition: given current phase and event, return target phase.
 * Returns undefined if the transition is not defined — fail-closed.
 *
 * This is the ONLY way to determine the next phase. No shortcuts, no overrides.
 */
export function resolveTransition(phase: Phase, event: Event): Phase | undefined {
  return TRANSITIONS.get(phase)?.get(event);
}
