/**
 * @module topology
 * @description Transition table — the formal state machine graph.
 *              Phase x Event → Phase. Immutable. Read-only at runtime.
 *
 * Three standalone flows from READY:
 *
 * Ticket flow:
 *   READY → TICKET → PLAN → PLAN_REVIEW → VALIDATION → IMPLEMENTATION → IMPL_REVIEW → EVIDENCE_REVIEW → COMPLETE
 *
 * Architecture flow:
 *   READY → ARCHITECTURE → ARCH_REVIEW → ARCH_COMPLETE
 *
 * Review flow:
 *   READY → REVIEW → REVIEW_COMPLETE
 *
 * Rules:
 * - Terminal phases (COMPLETE, ARCH_COMPLETE, REVIEW_COMPLETE) have empty maps.
 * - READY is command-driven (no guards, no auto-advance).
 * - ERROR loops back to the same phase in all non-gate, non-terminal, non-READY phases.
 * - User-gate phases (PLAN_REVIEW, EVIDENCE_REVIEW, ARCH_REVIEW) have NO error event.
 * - Every transition is explicitly listed. No wildcards, no inheritance.
 *
 * @version v2
 */

import type { Phase, Event } from "../state/schema";

// ─── Transition Table ─────────────────────────────────────────────────────────

/**
 * The complete transition table.
 * For each phase: a map of events to target phases.
 *
 * Reading: TRANSITIONS.get("READY")?.get("TICKET_SELECTED") === "TICKET"
 */
export const TRANSITIONS: ReadonlyMap<Phase, ReadonlyMap<Event, Phase>> = new Map<Phase, ReadonlyMap<Event, Phase>>([

  // ── READY (Routing) ───────────────────────────────────────────
  // Command-driven: user selects one of 3 flows.
  // No guards, no ERROR event — waiting for explicit command.
  ["READY", new Map<Event, Phase>([
    ["TICKET_SELECTED",        "TICKET"],
    ["ARCHITECTURE_SELECTED",  "ARCHITECTURE"],
    ["REVIEW_SELECTED",        "REVIEW"],
  ])],

  // ═══════════════════════════════════════════════════════════════
  // TICKET FLOW
  // ═══════════════════════════════════════════════════════════════

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
  ["VALIDATION", new Map<Event, Phase>([
    ["ALL_PASSED",   "IMPLEMENTATION"],
    ["CHECK_FAILED", "PLAN"],
    ["ERROR",        "VALIDATION"],
  ])],

  // ── IMPLEMENTATION ──────────────────────────────────────────
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
  ["EVIDENCE_REVIEW", new Map<Event, Phase>([
    ["APPROVE",            "COMPLETE"],
    ["CHANGES_REQUESTED",  "IMPLEMENTATION"],
    ["REJECT",             "TICKET"],
  ])],

  // ── COMPLETE (Terminal) ─────────────────────────────────────
  ["COMPLETE", new Map<Event, Phase>()],

  // ═══════════════════════════════════════════════════════════════
  // ARCHITECTURE FLOW
  // ═══════════════════════════════════════════════════════════════

  // ── ARCHITECTURE ────────────────────────────────────────────
  // Self-review loop (same convergence pattern as PLAN).
  ["ARCHITECTURE", new Map<Event, Phase>([
    ["SELF_REVIEW_MET",     "ARCH_REVIEW"],
    ["SELF_REVIEW_PENDING", "ARCHITECTURE"],
    ["ERROR",               "ARCHITECTURE"],
  ])],

  // ── ARCH_REVIEW (User Gate) ─────────────────────────────────
  // Human decides: approve → ARCH_COMPLETE, changes → ARCHITECTURE, reject → READY.
  ["ARCH_REVIEW", new Map<Event, Phase>([
    ["APPROVE",            "ARCH_COMPLETE"],
    ["CHANGES_REQUESTED",  "ARCHITECTURE"],
    ["REJECT",             "READY"],
  ])],

  // ── ARCH_COMPLETE (Terminal) ────────────────────────────────
  ["ARCH_COMPLETE", new Map<Event, Phase>()],

  // ═══════════════════════════════════════════════════════════════
  // REVIEW FLOW
  // ═══════════════════════════════════════════════════════════════

  // ── REVIEW ──────────────────────────────────────────────────
  // Generates compliance report, then auto-advances to terminal.
  ["REVIEW", new Map<Event, Phase>([
    ["REVIEW_DONE", "REVIEW_COMPLETE"],
    ["ERROR",       "REVIEW"],
  ])],

  // ── REVIEW_COMPLETE (Terminal) ──────────────────────────────
  ["REVIEW_COMPLETE", new Map<Event, Phase>()],
]);

// ─── Phase Classifications ────────────────────────────────────────────────────

/** User-gate phases: machine waits for explicit human input via /review-decision. */
export const USER_GATES: ReadonlySet<Phase> = new Set<Phase>([
  "PLAN_REVIEW",
  "EVIDENCE_REVIEW",
  "ARCH_REVIEW",
]);

/** Terminal phases: no outgoing transitions, workflow complete. */
export const TERMINAL: ReadonlySet<Phase> = new Set<Phase>([
  "COMPLETE",
  "ARCH_COMPLETE",
  "REVIEW_COMPLETE",
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
