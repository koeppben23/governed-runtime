/**
 * @module topology
 * @description Transition table — the formal state machine graph.
 *              Phase x Event → Phase. Immutable. Read-only at runtime.
 *
 * Three standalone flows from READY:
 *
 * Ticket flow:
 *   READY → TICKET → PLAN → PLAN_REVIEW → VALIDATION → IMPLEMENTATION → IMPL_VALIDATION → IMPL_REVIEW → EVIDENCE_REVIEW → EXPORT_READY → COMPLETE
 *   Reduced ceremony: IMPLEMENTATION → EVIDENCE_REVIEW only via explicit REDUCED_CEREMONY transition.
 *
 * Architecture flow:
 *   READY → ARCHITECTURE → ARCH_REVIEW → ARCH_COMPLETE
 *
 * Review flow:
 *   READY → PEER_REVIEW → PEER_REVIEW_COMPLETE
 *
 * Rules:
 * - Terminal phases (COMPLETE, ARCH_COMPLETE, PEER_REVIEW_COMPLETE, REJECTED, ABORTED) have empty maps.
 * - READY is command-driven (no guards, no auto-advance).
 * - ERROR loops back to the same phase in all non-gate, non-terminal, non-READY phases.
 * - User-gate phases (PLAN_REVIEW, EVIDENCE_REVIEW, ARCH_REVIEW) have NO error event.
 * - Every transition is explicitly listed. No wildcards, no inheritance.
 *
 * {@link FLOW_PHASES} additionally owns the canonical FORWARD phase progression
 * of each flow (used for evidence milestones). It is a semantic projection of
 * the graph, not a restatement of it: the graph intentionally contains
 * self-loops, backedges, REJECTED/ABORTED, and the REDUCED_CEREMONY shortcut
 * that are NOT part of any progression.
 *
 * @version v3
 */

import type { Phase, Event } from '../state/schema.js';

// ─── Transition Table ─────────────────────────────────────────────────────────

/**
 * The complete transition table.
 * For each phase: a map of events to target phases.
 *
 * Reading: TRANSITIONS.get("READY")?.get("TICKET_SELECTED") === "TICKET"
 */
export const TRANSITIONS: ReadonlyMap<Phase, ReadonlyMap<Event, Phase>> = new Map<
  Phase,
  ReadonlyMap<Event, Phase>
>([
  // ── READY (Routing) ───────────────────────────────────────────
  // Command-driven: user selects one of 3 flows.
  // No guards, no ERROR event — waiting for explicit command.
  [
    'READY',
    new Map<Event, Phase>([
      ['TICKET_SELECTED', 'TICKET'],
      ['ARCHITECTURE_SELECTED', 'ARCHITECTURE'],
      ['PEER_REVIEW_SELECTED', 'PEER_REVIEW'],
      ['ABORT', 'ABORTED'],
    ]),
  ],

  // ═══════════════════════════════════════════════════════════════
  // TICKET FLOW
  // ═══════════════════════════════════════════════════════════════

  // ── TICKET ──────────────────────────────────────────────────
  // Stays until ticket+plan evidence exists, then advances to PLAN.
  [
    'TICKET',
    new Map<Event, Phase>([
      ['PLAN_READY', 'PLAN'],
      ['ERROR', 'TICKET'],
      ['ABORT', 'ABORTED'],
    ]),
  ],

  // ── PLAN ────────────────────────────────────────────────────
  // Self-review loop: iterates until convergence (digest-stop).
  [
    'PLAN',
    new Map<Event, Phase>([
      ['SELF_REVIEW_MET', 'PLAN_REVIEW'],
      ['SELF_REVIEW_PENDING', 'PLAN'],
      ['ERROR', 'PLAN'],
      ['ABORT', 'ABORTED'],
    ]),
  ],

  // ── PLAN_REVIEW (User Gate) ─────────────────────────────────
  // Human decides: approve → VALIDATION, changes → PLAN, reject → REJECTED.
  [
    'PLAN_REVIEW',
    new Map<Event, Phase>([
      ['APPROVE', 'VALIDATION'],
      ['CHANGES_REQUESTED', 'PLAN'],
      ['REJECT', 'REJECTED'],
      ['ABORT', 'ABORTED'],
    ]),
  ],

  // ── VALIDATION ──────────────────────────────────────────────
  // Runs N checks in one phase (not N separate phases).
  // CHECK_FAILED → PLAN: failed validation means the plan is deficient.
  // CHECK_ERRORED → VALIDATION: a check could not be executed (timeout /
  // command-not-found) — a transient/infra condition, not a plan deficiency.
  // Stay in VALIDATION for a retry and keep the approved plan intact.
  [
    'VALIDATION',
    new Map<Event, Phase>([
      ['ALL_PASSED', 'IMPLEMENTATION'],
      ['CHECK_FAILED', 'PLAN'],
      ['CHECK_ERRORED', 'VALIDATION'],
      ['ERROR', 'VALIDATION'],
      ['ABORT', 'ABORTED'],
    ]),
  ],

  // ── IMPLEMENTATION ──────────────────────────────────────────
  // IMPL_COMPLETE → IMPL_VALIDATION: the fixed code is re-validated (checks
  // re-run against the implementation) before the independent review. Reduced
  // ceremony still bypasses straight to EVIDENCE_REVIEW (disabled under team).
  [
    'IMPLEMENTATION',
    new Map<Event, Phase>([
      ['REDUCED_CEREMONY', 'EVIDENCE_REVIEW'],
      ['IMPL_COMPLETE', 'IMPL_VALIDATION'],
      ['ERROR', 'IMPLEMENTATION'],
      ['ABORT', 'ABORTED'],
    ]),
  ],

  // ── IMPL_VALIDATION ─────────────────────────────────────────
  // Re-runs the active verification checks against the IMPLEMENTED code (the
  // post-fix run), recorded in `implValidation` (distinct from the pre-impl
  // `validation`). ALL_PASSED → IMPL_REVIEW; CHECK_FAILED → IMPLEMENTATION
  // (the CODE is wrong, not the plan); CHECK_ERRORED → self (timeout/executor
  // error retry, mirrors VALIDATION); ERROR → self.
  [
    'IMPL_VALIDATION',
    new Map<Event, Phase>([
      ['ALL_PASSED', 'IMPL_REVIEW'],
      ['CHECK_FAILED', 'IMPLEMENTATION'],
      ['CHECK_ERRORED', 'IMPL_VALIDATION'],
      ['ERROR', 'IMPL_VALIDATION'],
      ['ABORT', 'ABORTED'],
    ]),
  ],

  // ── IMPL_REVIEW ─────────────────────────────────────────────
  // Review loop: approve converges to evidence review; requested changes
  // return to implementation so fresh evidence replaces stale evidence.
  [
    'IMPL_REVIEW',
    new Map<Event, Phase>([
      ['REVIEW_MET', 'EVIDENCE_REVIEW'],
      // Exhausted review loops end at the human gate, where only the explicit
      // governance override can still approve the unchanged reviewed revision.
      ['REVIEW_EXHAUSTED', 'EVIDENCE_REVIEW'],
      ['REVIEW_PENDING', 'IMPL_REVIEW'],
      ['CHANGES_REQUESTED', 'IMPLEMENTATION'],
      ['ERROR', 'IMPL_REVIEW'],
      ['ABORT', 'ABORTED'],
    ]),
  ],

  // ── EVIDENCE_REVIEW (User Gate) ─────────────────────────────
  // Human decides: approve → EXPORT_READY, changes → IMPLEMENTATION, reject → REJECTED.
  [
    'EVIDENCE_REVIEW',
    new Map<Event, Phase>([
      ['APPROVE', 'EXPORT_READY'],
      ['CHANGES_REQUESTED', 'IMPLEMENTATION'],
      ['REJECT', 'REJECTED'],
      ['ABORT', 'ABORTED'],
    ]),
  ],

  // ── EXPORT_READY ─────────────────────────────────────────────
  // Completion is possible only after the export rail has materialized and
  // persisted exact, verifiable export evidence.
  [
    'EXPORT_READY',
    new Map<Event, Phase>([
      ['EXPORT_MATERIALIZED', 'COMPLETE'],
      ['ABORT', 'ABORTED'],
    ]),
  ],

  // ── COMPLETE (Terminal) ─────────────────────────────────────
  ['COMPLETE', new Map<Event, Phase>()],
  ['REJECTED', new Map<Event, Phase>()],
  ['ABORTED', new Map<Event, Phase>()],

  // ═══════════════════════════════════════════════════════════════
  // ARCHITECTURE FLOW
  // ═══════════════════════════════════════════════════════════════

  // ── ARCHITECTURE ────────────────────────────────────────────
  // Self-review loop (same convergence pattern as PLAN).
  [
    'ARCHITECTURE',
    new Map<Event, Phase>([
      ['SELF_REVIEW_MET', 'ARCH_REVIEW'],
      ['SELF_REVIEW_PENDING', 'ARCHITECTURE'],
      ['ERROR', 'ARCHITECTURE'],
      ['ABORT', 'ABORTED'],
    ]),
  ],

  // ── ARCH_REVIEW (User Gate) ─────────────────────────────────
  // Human decides: approve → ARCH_COMPLETE, changes → ARCHITECTURE, reject → REJECTED.
  [
    'ARCH_REVIEW',
    new Map<Event, Phase>([
      ['APPROVE', 'ARCH_COMPLETE'],
      ['CHANGES_REQUESTED', 'ARCHITECTURE'],
      ['REJECT', 'REJECTED'],
      ['ABORT', 'ABORTED'],
    ]),
  ],

  // ── ARCH_COMPLETE (Terminal) ────────────────────────────────
  ['ARCH_COMPLETE', new Map<Event, Phase>()],

  // ═══════════════════════════════════════════════════════════════
  // PEER_REVIEW FLOW
  // ═══════════════════════════════════════════════════════════════

  // ── PEER_REVIEW ──────────────────────────────────────────────────
  // Generates peer review report, then auto-advances to terminal.
  [
    'PEER_REVIEW',
    new Map<Event, Phase>([
      ['PEER_REVIEW_DONE', 'PEER_REVIEW_COMPLETE'],
      ['ERROR', 'PEER_REVIEW'],
      ['ABORT', 'ABORTED'],
    ]),
  ],

  // ── REVIEW_COMPLETE (Terminal) ──────────────────────────────
  ['PEER_REVIEW_COMPLETE', new Map<Event, Phase>()],
]);

// ─── Phase Classifications ────────────────────────────────────────────────────

/** User-gate phases: machine waits for explicit human input via /review-decision. */
export const USER_GATE_PHASES = [
  'PLAN_REVIEW',
  'EVIDENCE_REVIEW',
  'ARCH_REVIEW',
] as const satisfies readonly Phase[];

export type UserGatePhase = (typeof USER_GATE_PHASES)[number];

/** Runtime lookup for user-gate phases. Keep tuple above as compile-time authority. */
export const USER_GATES: ReadonlySet<Phase> = new Set<Phase>(USER_GATE_PHASES);

/** Terminal phases: no outgoing transitions, workflow complete. */
export const TERMINAL: ReadonlySet<Phase> = new Set<Phase>([
  'COMPLETE',
  'ARCH_COMPLETE',
  'PEER_REVIEW_COMPLETE',
  'REJECTED',
  'ABORTED',
]);

/**
 * Single authority for terminal-phase membership over an arbitrary string.
 *
 * Accepts a free-form `string` (e.g. `AuditEvent.phase`, which may be `'unknown'`)
 * and answers membership against {@link TERMINAL} WITHOUT asserting the input is
 * a `Phase` — the set's element type is widened for the read-only `.has` query,
 * so an arbitrary string is never unsafely narrowed into the `Phase` union.
 * Consumers that already hold a typed `Phase` should use `TERMINAL.has(phase)`
 * directly; this helper exists for the untyped-string boundary (audit reports).
 */
export function isTerminalPhase(value: string): boolean {
  return (TERMINAL as ReadonlySet<string>).has(value);
}

// ─── Flow Progressions ────────────────────────────────────────────────────────

/**
 * Canonical forward progression per flow — NOT the complete set of admissible
 * transitions.
 *
 * Consumers derive "is phase X reached-or-past milestone Y in this flow?" from
 * these tuples. They must NOT define local phase-rank maps, local copies of a
 * progression, or hardcoded READY flow-selection targets.
 *
 * The graph contains additional edges that are deliberately absent here:
 * self-loops (SELF_REVIEW_PENDING, REVIEW_PENDING, CHECK_ERRORED, ERROR),
 * backedges (CHANGES_REQUESTED/CHECK_FAILED), REJECTED, ABORTED, and the
 * REDUCED_CEREMONY shortcut. `topology.test.ts` proves every adjacent pair of a
 * progression is connected by at least one edge in {@link TRANSITIONS}; the
 * reverse direction is intentionally NOT required.
 */
export const FLOW_PHASES = {
  ticket: [
    'TICKET',
    'PLAN',
    'PLAN_REVIEW',
    'VALIDATION',
    'IMPLEMENTATION',
    'IMPL_VALIDATION',
    'IMPL_REVIEW',
    'EVIDENCE_REVIEW',
    'EXPORT_READY',
    'COMPLETE',
  ],
  architecture: ['ARCHITECTURE', 'ARCH_REVIEW', 'ARCH_COMPLETE'],
  review: ['PEER_REVIEW', 'PEER_REVIEW_COMPLETE'],
} as const satisfies Record<'ticket' | 'architecture' | 'review', readonly Phase[]>;

/** Flow names covered by {@link FLOW_PHASES}. */
export type FlowName = keyof typeof FLOW_PHASES;

/**
 * Whether a phase belongs to the named flow's canonical progression.
 *
 * Consumers that classify a session by flow (progress milestones, ProofGraph
 * projection) MUST use this instead of local phase sets.
 */
export function isFlowPhase(flow: FlowName, phase: Phase): boolean {
  const phases: readonly Phase[] = FLOW_PHASES[flow];
  return phases.includes(phase);
}

/**
 * Fail-closed ordinal comparison inside one canonical flow progression:
 * is `current` at or after `required`?
 *
 * Both phases must belong to the named flow. A phase outside it — `READY`,
 * `REJECTED`, `ABORTED`, or a phase of another flow — never counts as reached.
 * This is the single authority for evidence-milestone ordering; consumers must
 * not re-derive progressions or index arithmetic locally.
 */
export function isFlowPhaseAtOrAfter(flow: FlowName, current: Phase, required: Phase): boolean {
  const phases: readonly Phase[] = FLOW_PHASES[flow];
  const currentIndex = phases.indexOf(current);
  const requiredIndex = phases.indexOf(required);
  if (currentIndex < 0 || requiredIndex < 0) return false;
  return currentIndex >= requiredIndex;
}

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
