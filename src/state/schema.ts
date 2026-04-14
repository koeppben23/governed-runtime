/**
 * @module schema
 * @description Core state model — Phase enum, Event enum, Transition, and SessionState.
 *              Single Zod schema validated on every atomic write.
 *
 * Design decisions (Lead-reviewed):
 * - No updatedAt at top-level (redundant — evidences have own timestamps)
 * - transition field (auditor sees last transition without parsing JSONL)
 * - plan with version history (compliance requirement for banks)
 * - activeChecks as closed enum (no silent typos)
 * - error field (fail-closed error state with recovery info)
 *
 * @version v1
 */

import { z } from "zod";
import {
  BindingInfo,
  CheckId,
  ErrorInfo,
  ImplEvidence,
  ImplReviewResult,
  PlanRecord,
  PolicySnapshotSchema,
  ReviewDecision,
  SelfReviewLoop,
  TicketEvidence,
  ValidationResult,
} from "./evidence";

// ─── Phase ────────────────────────────────────────────────────────────────────

/**
 * The 8 governance phases.
 * init() is a function (bootstrap, workspace, binding, discovery) — not a phase.
 *
 * Linear flow:
 *   TICKET → PLAN → PLAN_REVIEW → VALIDATION → IMPLEMENTATION → IMPL_REVIEW → EVIDENCE_REVIEW → COMPLETE
 *
 * Backward transitions:
 *   PLAN_REVIEW --changes_requested--> PLAN
 *   PLAN_REVIEW --reject--> TICKET
 *   EVIDENCE_REVIEW --changes_requested--> IMPLEMENTATION
 *   EVIDENCE_REVIEW --reject--> TICKET
 */
export const Phase = z.enum([
  "TICKET",
  "PLAN",
  "PLAN_REVIEW",
  "VALIDATION",
  "IMPLEMENTATION",
  "IMPL_REVIEW",
  "EVIDENCE_REVIEW",
  "COMPLETE",
]);
export type Phase = z.infer<typeof Phase>;

// ─── Event ────────────────────────────────────────────────────────────────────

/**
 * Machine-internal events that drive transitions.
 * Commands are user inputs; events are what the machine acts on.
 * Mapping: command → rail → state mutation → evaluate() → event → transition.
 */
export const Event = z.enum([
  // TICKET → PLAN
  "PLAN_READY",

  // PLAN self-review loop
  "SELF_REVIEW_MET",
  "SELF_REVIEW_PENDING",

  // User Gate decisions (PLAN_REVIEW, EVIDENCE_REVIEW)
  "APPROVE",
  "CHANGES_REQUESTED",
  "REJECT",

  // VALIDATION
  "ALL_PASSED",
  "CHECK_FAILED",

  // IMPLEMENTATION → IMPL_REVIEW
  "IMPL_COMPLETE",

  // IMPL_REVIEW loop
  "REVIEW_MET",
  "REVIEW_PENDING",

  // Error recovery (non-user-gate, non-terminal phases)
  "ERROR",

  // Emergency escape — bypasses topology, used only by /abort rail
  "ABORT",
]);
export type Event = z.infer<typeof Event>;

// ─── Transition ───────────────────────────────────────────────────────────────

/**
 * Last transition record.
 * Embedded in state so auditors can see the most recent transition
 * without parsing the JSONL audit trail.
 */
export const Transition = z.object({
  from: Phase,
  to: Phase,
  event: Event,
  at: z.string().datetime(),
});
export type Transition = z.infer<typeof Transition>;

// ─── Session State ────────────────────────────────────────────────────────────

/**
 * The complete governance session state.
 * Single JSON document, atomically persisted, Zod-validated on every write.
 *
 * Slot pattern: each evidence field is nullable.
 * - null = not yet produced (phase hasn't been reached)
 * - present = evidence exists (phase was executed)
 *
 * The evaluator reads these slots to determine which guards pass.
 */
export const SessionState = z.object({
  /** Unique session identifier. */
  id: z.string().uuid(),

  /** Schema version — always "v1" for this generation. */
  schemaVersion: z.literal("v1"),

  /** Current governance phase. */
  phase: Phase,

  /** Workspace binding (OpenCode session <-> git worktree). */
  binding: BindingInfo,

  // ── Evidence Slots ──────────────────────────────────────────

  /** Ticket/task evidence from /ticket. */
  ticket: TicketEvidence.nullable(),

  /** Plan record with version history from /plan. */
  plan: PlanRecord.nullable(),

  /** Self-review loop state (PLAN phase, digest-stop). */
  selfReview: SelfReviewLoop.nullable(),

  /** Validation check results (VALIDATION phase, N checks in one phase). */
  validation: z.array(ValidationResult),

  /** Implementation evidence from /implement. */
  implementation: ImplEvidence.nullable(),

  /** Implementation review iteration result (IMPL_REVIEW phase, digest-stop). */
  implReview: ImplReviewResult.nullable(),

  /** Human review decision at PLAN_REVIEW or EVIDENCE_REVIEW. */
  reviewDecision: ReviewDecision.nullable(),

  // ── Configuration ───────────────────────────────────────────

  /**
   * Active profile information — resolved at hydrate time.
   * Contains the profile ID, name, and LLM rule content.
   * The ruleContent is the stack-specific guidance text injected into
   * tool responses when commands reference "profile rules".
   * phaseRuleContent maps Phase values to additional phase-specific text
   * that is appended to ruleContent when the session is in that phase.
   * Null only if no profile was resolved (should not happen — baseline is always available).
   */
  activeProfile: z
    .object({
      id: z.string().min(1),
      name: z.string().min(1),
      ruleContent: z.string(),
      phaseRuleContent: z.record(z.string(), z.string()).optional(),
    })
    .nullable(),

  /**
   * Active validation checks for this session.
   * Open string set — profile registry validates at runtime.
   * Base: [test_quality, rollback_safety]. Extended per profile.
   */
  activeChecks: z.array(CheckId),

  /**
   * Immutable policy snapshot — frozen at session creation.
   * Records which governance rules governed this session.
   * The hash provides non-repudiation for auditors.
   */
  policySnapshot: PolicySnapshotSchema,

  /**
   * Identity of the session initiator (author).
   * Set once at hydrate time, never mutated.
   * Used for four-eyes principle enforcement:
   * initiatedBy !== reviewDecision.decidedBy (in regulated mode).
   */
  initiatedBy: z.string().min(1),

  // ── Metadata ────────────────────────────────────────────────

  /** Last transition (from → to via event). Null before first transition. */
  transition: Transition.nullable(),

  /** Error state. Non-null triggers ERROR event in guard evaluation. */
  error: ErrorInfo.nullable(),

  /** Session creation timestamp (set once by init()). */
  createdAt: z.string().datetime(),
});
export type SessionState = z.infer<typeof SessionState>;
