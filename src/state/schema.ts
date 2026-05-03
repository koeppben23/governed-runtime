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

import { z } from 'zod';
import {
  ActorInfoSchema,
  ArchitectureDecision,
  BindingInfo,
  CheckId,
  DecisionIdentitySchema,
  ErrorInfo,
  ImplEvidence,
  ImplReviewResult,
  PlanRecord,
  PolicySnapshotSchema,
  ReviewAssuranceState,
  ReviewDecision,
  ReviewFindings,
  SelfReviewLoop,
  TicketEvidence,
  ValidationResult,
} from './evidence.js';
import {
  DiscoverySummarySchema,
  DetectedStackSchema,
  VerificationCandidatesSchema,
} from './discovery-schemas.js';

// ─── Phase ────────────────────────────────────────────────────────────────────

/**
 * The 14 FlowGuard phases across 3 standalone flows.
 * init() is a function (bootstrap, workspace, binding, discovery) — not a phase.
 *
 * After /hydrate, the session starts at READY — a routing phase
 * where the user selects one of 3 standalone flows:
 *
 * Ticket flow (full development lifecycle):
 *   READY → TICKET → PLAN → PLAN_REVIEW → VALIDATION → IMPLEMENTATION → IMPL_REVIEW → EVIDENCE_REVIEW → COMPLETE
 *
 * Architecture flow (ADR creation):
 *   READY → ARCHITECTURE → ARCH_REVIEW → ARCH_COMPLETE
 *
 * Review flow (compliance report):
 *   READY → REVIEW → REVIEW_COMPLETE
 *
 * Backward transitions:
 *   PLAN_REVIEW --changes_requested--> PLAN
 *   PLAN_REVIEW --reject--> TICKET
 *   EVIDENCE_REVIEW --changes_requested--> IMPLEMENTATION
 *   EVIDENCE_REVIEW --reject--> TICKET
 *   ARCH_REVIEW --changes_requested--> ARCHITECTURE
 *   ARCH_REVIEW --reject--> READY
 */
export const Phase = z.enum([
  'READY',
  'TICKET',
  'PLAN',
  'PLAN_REVIEW',
  'VALIDATION',
  'IMPLEMENTATION',
  'IMPL_REVIEW',
  'EVIDENCE_REVIEW',
  'COMPLETE',
  'ARCHITECTURE',
  'ARCH_REVIEW',
  'ARCH_COMPLETE',
  'REVIEW',
  'REVIEW_COMPLETE',
]);
export type Phase = z.infer<typeof Phase>;

// ─── Event ────────────────────────────────────────────────────────────────────

/**
 * Machine-internal events that drive transitions.
 * Commands are user inputs; events are what the machine acts on.
 * Mapping: command → rail → state mutation → evaluate() → event → transition.
 */
export const Event = z.enum([
  // READY → flow selection
  'TICKET_SELECTED',
  'ARCHITECTURE_SELECTED',
  'REVIEW_SELECTED',

  // TICKET → PLAN
  'PLAN_READY',

  // PLAN self-review loop
  'SELF_REVIEW_MET',
  'SELF_REVIEW_PENDING',

  // User Gate decisions (PLAN_REVIEW, EVIDENCE_REVIEW, ARCH_REVIEW)
  'APPROVE',
  'CHANGES_REQUESTED',
  'REJECT',

  // VALIDATION
  'ALL_PASSED',
  'CHECK_FAILED',

  // IMPLEMENTATION → IMPL_REVIEW
  'IMPL_COMPLETE',

  // IMPL_REVIEW loop
  'REVIEW_MET',
  'REVIEW_PENDING',

  // REVIEW flow → REVIEW_COMPLETE
  'REVIEW_DONE',

  // Error recovery (non-user-gate, non-terminal phases)
  'ERROR',

  // Emergency escape — bypasses topology, used only by /abort rail
  'ABORT',
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
 * The complete FlowGuard session state.
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
  schemaVersion: z.literal('v1'),

  /** Current FlowGuard phase. */
  phase: Phase,

  /** Workspace binding (OpenCode session <-> git worktree). */
  binding: BindingInfo,

  // ── Evidence Slots ──────────────────────────────────────────

  /** Ticket/task evidence from /ticket. */
  ticket: TicketEvidence.nullable(),

  /** Architecture Decision Record from /architecture. */
  architecture: ArchitectureDecision.nullable(),

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

  /** Independent review findings for /implement (parallel, NOT mixed with ImplEvidence). */
  implReviewFindings: z.array(ReviewFindings).optional(),

  /** P35 strict independent-review obligations and invocation evidence. */
  reviewAssurance: ReviewAssuranceState.optional(),

  /** Human review decision at PLAN_REVIEW, EVIDENCE_REVIEW, or ARCH_REVIEW. */
  reviewDecision: ReviewDecision.nullable(),

  /** Absolute path to the generated review report file (REVIEW phase, P8b). */
  reviewReportPath: z.string().nullable().default(null),

  /** Next auto-generated ADR sequence number for /architecture. */
  nextAdrNumber: z.number().int().positive(),

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
   * Records which FlowGuard rules governed this session.
   * The hash provides non-repudiation for auditors.
   */
  policySnapshot: PolicySnapshotSchema,

  /**
   * Identity of the session initiator (author).
   * Set once at hydrate time, never mutated.
   * Used for regulated approval four-eyes enforcement:
   * initiatedBy !== reviewDecision.decidedBy (approve path).
   *
   * P30: For regulated sessions, this MUST be a known actor identity,
   * not the technical session ID. Use initiatedByIdentity for full provenance.
   */
  initiatedBy: z.string().min(1),

  /**
   * Structured initiator identity for regulated approval (P30).
   * Persists actor identity at session creation for four-eyes proof.
   * Required for regulated mode.
   */
  initiatedByIdentity: DecisionIdentitySchema.optional(),

  /**
   * Resolved actor identity at hydrate time (P27).
   * Best-effort operator identity — NOT an authentication claim.
   * Absent when no actor identity was resolved; null is not a valid state value.
   */
  actorInfo: ActorInfoSchema.optional(),

  // ── Discovery ───────────────────────────────────────────────

  /**
   * SHA-256 digest of the DiscoveryResult at session creation time.
   * Used for drift detection: if the workspace discovery changes,
   * this digest will no longer match the current discovery.json.
   * Null for sessions created before Phase 5 (discovery system).
   */
  discoveryDigest: z.string().nullable().optional(),

  /**
   * Lightweight discovery summary for quick consumption by Plan/Review/Implement.
   * NOT the full DiscoveryResult — just the most useful fields.
   * Null for sessions created before Phase 5 (discovery system).
   */
  discoverySummary: DiscoverySummarySchema.nullable().optional(),

  /**
   * Compact detected stack evidence for surfacing in flowguard_status.
   *
   * Derived evidence — NOT SSOT. The authoritative stack data lives in
   * DiscoveryResult.stack. This is a compact projection of all detected
   * stack items (versioned and unversioned), sorted deterministically
   * by category then id.
   *
   * Null when no items were detected or for pre-discovery sessions.
   */
  detectedStack: DetectedStackSchema.nullable().optional(),

  /**
   * Advisory verification command candidates derived from stack + manifest evidence.
   *
   * Derived evidence — NOT SSOT. These candidates are planning hints only and
   * MUST NOT be treated as executed checks.
   */
  verificationCandidates: VerificationCandidatesSchema.optional(),

  // ── Metadata ────────────────────────────────────────────────

  /** Last transition (from → to via event). Null before first transition. */
  transition: Transition.nullable(),

  /** Error state. Non-null triggers ERROR event in guard evaluation. */
  error: ErrorInfo.nullable(),

  /** Session creation timestamp (set once by init()). */
  createdAt: z.string().datetime(),

  /**
   * Archive lifecycle status for completed sessions.
   *
   * Only set for regulated clean completions (EVIDENCE_REVIEW → APPROVE → COMPLETE).
   * Non-regulated sessions and aborted sessions do not set this field.
   *
   * - `pending`  — archive creation in progress
   * - `created`  — archive created, verification pending
   * - `verified` — archive created and verification passed
   * - `failed`   — archive creation or verification failed
   *
   * Invariant: `phase === 'COMPLETE' && policySnapshot.mode === 'regulated'
   *            && !error && archiveStatus !== 'verified'` = NOT a clean regulated completion.
   *
   * Added in P26 — .optional() for backward compatibility (no schema version bump).
   */
  archiveStatus: z.enum(['pending', 'created', 'verified', 'failed']).nullable().optional(),
});
export type SessionState = z.infer<typeof SessionState>;
