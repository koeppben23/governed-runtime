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
  ChallengeResolution,
  CheckId,
  DecisionIdentitySchema,
  ErrorInfo,
  ImplEvidence,
  ImplReviewResult,
  MutationAttempt,
  PlanRecord,
  PolicySnapshotSchema,
  ReviewAssuranceState,
  ReviewDecision,
  ReviewFindings,
  SelfReviewLoop,
  TicketEvidence,
  ValidationAttempt,
  ValidationResult,
} from './evidence.js';
import {
  DiscoverySummarySchema,
  DetectedStackSchema,
  VerificationCandidatesSchema,
} from './discovery-schemas.js';
import { ProofGraphProjection } from './proofgraph.js';
import { ProofContract } from './proofgraph-contract.js';

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
 *   Reduced ceremony: IMPLEMENTATION → EVIDENCE_REVIEW only with explicit reducedCeremony evidence.
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
  'IMPL_VALIDATION',
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

// ─── Task Risk Classification ────────────────────────────────────────────────

/**
 * Agent-claimed task class. This is only an operator/agent claim, never the
 * runtime truth. The runtime computes a minimum class per gate check.
 */
export const TaskClass = z.enum(['TRIVIAL', 'STANDARD', 'HIGH-RISK']);
export type TaskClass = z.infer<typeof TaskClass>;

/** Runtime decision that implementation review ceremony was explicitly reduced. */
export const ReducedCeremonyDecision = z
  .object({
    profile: z.literal('reduced'),
    reason: z.string().min(1),
    claimedTaskClass: TaskClass,
    computedMinimumTaskClass: TaskClass,
    touchedSurfaces: z.array(z.string()),
    decidedAt: z.string().datetime(),
  })
  .readonly();
export type ReducedCeremonyDecision = z.infer<typeof ReducedCeremonyDecision>;

/** Persistent risk gate state. A blocked gate must stop the next mutating tool. */
export const RiskGate = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('clear'),
    lastDecisionId: z.string().min(1).optional(),
    clearedAt: z.string().datetime().optional(),
  }),
  z.object({
    status: z.literal('blocked'),
    code: z.string().min(1),
    message: z.string().min(1),
    blockedAt: z.string().datetime(),
    lastDecisionId: z.string().min(1),
  }),
]);
export type RiskGate = z.infer<typeof RiskGate>;

/**
 * Cached drift verdict (#399). Drift is assessed only at /hydrate to bound cost;
 * per-tool enforcement reads this cached value rather than re-running drift.
 * Any non-'clean' value is fail-closed-eligible under onDrift policy.
 */
export const DiscoveryDriftAssessment = z.enum([
  'clean',
  'drifted',
  'missing_discovery',
  'unavailable',
  'timeout',
  'not_checked',
]);
export type DiscoveryDriftAssessment = z.infer<typeof DiscoveryDriftAssessment>;

/** Discovery health gate reason codes (#399). */
export const DiscoveryHealthGateCode = z.enum([
  'DISCOVERY_HEALTH_UNAVAILABLE',
  'DISCOVERY_HEALTH_DEGRADED',
  'DISCOVERY_DRIFT_BLOCKED',
]);
export type DiscoveryHealthGateCode = z.infer<typeof DiscoveryHealthGateCode>;

/**
 * Persistent Discovery health gate (#399).
 *
 * Separates the gate DECISION (`status`) from cached drift EVIDENCE
 * (`lastDriftAssessment`). A blocked gate stops the next mutating tool.
 * The gate is cleared ONLY by reconcileDiscoveryHealthGate at /hydrate with
 * fresh healthy Discovery and bounded drift — never by /status or by a
 * subsequent unavailable re-read at the tool seam.
 */
export const DiscoveryHealthGate = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('clear'),
    clearedAt: z.string().datetime().optional(),
    lastDriftAssessment: DiscoveryDriftAssessment.optional(),
  }),
  z.object({
    status: z.literal('blocked'),
    code: DiscoveryHealthGateCode,
    message: z.string().min(1),
    blockedAt: z.string().datetime(),
    lastDriftAssessment: DiscoveryDriftAssessment.optional(),
  }),
]);
export type DiscoveryHealthGate = z.infer<typeof DiscoveryHealthGate>;

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

  // VALIDATION execution error (timeout / command-not-found): retry, do NOT re-plan
  'CHECK_ERRORED',

  // IMPLEMENTATION → IMPL_REVIEW
  'IMPL_COMPLETE',

  // IMPLEMENTATION → EVIDENCE_REVIEW when policy-gated reduced ceremony is proven
  'REDUCED_CEREMONY',

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

  /** Agent/operator risk-classification claim. Not runtime authority. */
  claimedTaskClass: TaskClass.optional(),

  /** Persistent runtime risk gate block state for mutating host tools. */
  riskGate: RiskGate.optional(),

  /** Persistent Discovery health gate block state for mutating host tools (#399). */
  discoveryHealthGate: DiscoveryHealthGate.optional(),

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

  /**
   * Append-only execution ledger. Unlike the current per-check projections above,
   * this preserves every successful validation-result persistence for audit.
   */
  validationAttempts: z.array(ValidationAttempt).default([]),

  /**
   * Append-only mutation-attempt ledger (#762). Records every FlowGuard-attested
   * mutation report observation, with implementation binding, artifact/projection
   * digests, and reproducibility metadata. Produced by flowguard_record_mutation_evidence.
   */
  mutationAttempts: z.array(MutationAttempt).default([]),

  /** Advisory challenge-resolution evidence; defaults for legacy sessions. */
  challengeResolutions: z.array(ChallengeResolution).default([]),

  /**
   * Post-implementation validation check results (IMPL_VALIDATION phase). Kept
   * separate from `validation` (the pre-implementation baseline run) so the audit
   * trail retains both the baseline and the re-run of checks against the fixed code.
   * Defaulted to [] for backward compatibility with pre-IMPL_VALIDATION sessions.
   */
  implValidation: z.array(ValidationResult).default([]),

  /** Implementation evidence from /implement. */
  implementation: ImplEvidence.nullable(),

  /** Explicit runtime evidence for reducing implementation-review ceremony. */
  reducedCeremony: ReducedCeremonyDecision.nullable().default(null),

  /** Implementation review iteration result (IMPL_REVIEW phase, digest-stop). */
  implReview: ImplReviewResult.nullable(),

  /** Independent review findings for /implement (parallel, NOT mixed with ImplEvidence). */
  implReviewFindings: z.array(ReviewFindings).optional(),

  /** Independent review findings for standalone /review, retained append-only for audit. */
  standaloneReviewFindings: z.array(ReviewFindings).optional(),

  /** P35 strict independent-review obligations and invocation evidence. */
  reviewAssurance: ReviewAssuranceState.optional(),

  /** Human review decision at PLAN_REVIEW, EVIDENCE_REVIEW, or ARCH_REVIEW. */
  reviewDecision: ReviewDecision.nullable(),

  /** Absolute path to the generated review report file (REVIEW phase, P8b). */
  reviewReportPath: z.string().nullable().default(null),

  /**
   * Thin ProofGraph contract declaration (advisory; #762).
   *
   * Declaration-only: names the claims a change asserts and their approved
   * sources. Additive/`.optional()`; never a runtime authority. The evaluator
   * derives `proofGraph` from these claims plus executed evidence.
   */
  proofContract: ProofContract.optional(),

  /**
   * Compact ProofGraph projection (advisory; #762).
   *
   * Additive and `.optional()` for backward compatibility: sessions created
   * before ProofGraph have no projection, and its absence is treated as "no
   * graph". It never gates a workflow on its own — blocking eligibility is a
   * policy-layer decision. Large provider artifacts live outside session state.
   */
  proofGraph: ProofGraphProjection.optional(),

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
   * Derived from verificationCandidates at hydrate-time (unique kinds).
   * Empty if no verification commands were discovered.
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

  /**
   * Pre-implementation worktree baseline (P-baseline).
   *
   * Snapshot of files already dirty at session start (hydrate), used by
   * flowguard_implement to scope recorded evidence to files the task actually
   * changed — pre-existing dirty files (e.g. a stale opencode.json) are
   * subtracted so they are not attributed to the implementation or used to
   * raise the risk floor.
   *
   * `.optional()` for backward compatibility (no schema version bump): legacy
   * sessions and sessions hydrated by an older plugin have no baseline. When
   * absent, implement does NOT subtract (it records the full worktree exactly
   * as before) and surfaces `baselineScoping: "unavailable"` — it never hides
   * evidence. Null is treated identically to absent.
   */
  implementationBaseline: z
    .object({
      /**
       * Files dirty at capture time, each with the git blob hash of its content
       * at session start. A pre-dirty file is scoped out of implementation
       * evidence ONLY if its current hash still matches — so a file the task
       * actually modified (hash changed) is never hidden. `hash` is null for a
       * path that was unreadable/deleted at capture time.
       */
      dirtyFiles: z.array(
        z.object({
          path: z.string(),
          hash: z.string().nullable(),
        }),
      ),
      /** ISO-8601 capture timestamp (hydrate time). */
      capturedAt: z.string().datetime(),
    })
    .nullable()
    .optional(),

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
   * Regulated clean completions use this as their evidence lifecycle. Manual
   * exports also record their latest result for operator status projections.
   *
   * - `pending`  — archive creation in progress
   * - `created`  — archive created, verification pending
   * - `verified` — archive created and verification passed
   * - `not_verifiable` — redacted sharing archive intentionally excludes raw evidence
   * - `failed`   — archive creation or verification failed
   *
   * Invariant: a regulated clean completion is verified only by its mandatory
   * raw-evidence archive; optional later sharing exports never replace that state.
   *
   * Added in P26 — .optional() for backward compatibility (no schema version bump).
   */
  archiveStatus: z
    .enum(['pending', 'created', 'verified', 'not_verifiable', 'failed'])
    .nullable()
    .optional(),
});
export type SessionState = z.infer<typeof SessionState>;
