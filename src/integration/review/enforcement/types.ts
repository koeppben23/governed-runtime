/**
 * @module integration/review-enforcement-types
 * @description Types, interfaces, and constants for review enforcement.
 *
 * Extracted from review-enforcement.ts (FG-REL-038) for single-responsibility.
 * This module is the universal coupling point — all enforcement clusters
 * depend on these types. Keeping them in a dedicated leaf module prevents
 * circular imports and enables lightweight consumer imports.
 *
 * @version v1
 */

import { TOOL_FLOWGUARD_REVIEW } from '../../tool-names.js';
import type { ReviewableTool } from '../obligation-tools.js';
export type { ReviewableTool } from '../obligation-tools.js';

export type PendingReviewTool = ReviewableTool | typeof TOOL_FLOWGUARD_REVIEW;

/** Record of a completed subagent invocation. */
export interface SubagentRecord {
  /** Subagent session ID extracted from response, or null if extraction failed. */
  readonly sessionId: string | null;
  /** ISO 8601 timestamp when the Task call completed. */
  readonly completedAt: string;
  /**
   * Host-detected termination reason. When present, the subagent did not
   * complete normally and its output may be incomplete. Known values:
   * - `step_exhausted`: the subagent reached its step budget and was
   *   forcibly terminated; any findings are incomplete and must never be
   *   bound as complete review evidence.
   */
  readonly terminationReason?: 'step_exhausted';
}

/**
 * Content metadata captured from FlowGuard tool response.
 * Used by Level 3 (Prompt Integrity) to validate the Task call prompt.
 */
export interface ContentMeta {
  /** Expected iteration value parsed from the INDEPENDENT_REVIEW_REQUIRED message. */
  readonly expectedIteration: number;
  /** Expected planVersion value parsed from the message (null if not present). */
  readonly expectedPlanVersion: number | null;
}

/**
 * Key fields captured from the actual subagent response.
 * Used by Level 4 (Findings Integrity) to detect findings modification.
 */
export interface CapturedFindings {
  /** The overallVerdict from the subagent's ReviewFindings. */
  readonly overallVerdict: string;
  /** Count of blockingIssues from the subagent's ReviewFindings. */
  readonly blockingIssuesCount: number;
  /** The sessionId from reviewedBy, if present. */
  readonly sessionId: string | null;
  /** Complete parsed ReviewFindings object, when extraction succeeds. */
  readonly rawFindings?: Record<string, unknown> | null;
  /**
   * How the findings JSON was obtained from the reviewer's output (F8).
   * - clean_json: the entire Task output parsed as conforming JSON.
   * - recovered_block: findings recovered from an embedded/brace-balanced JSON
   *   block inside mixed model output. Reduced provenance confidence — the
   *   host downgrades review assurance to 'structured_recovered'.
   */
  readonly extractionMethod?: 'clean_json' | 'recovered_block';
}

/** Per-tool pending review state. */
export interface PendingReview {
  /** Which tool signaled the review requirement. */
  readonly tool: PendingReviewTool;
  /** ISO 8601 timestamp when the requirement was signaled. */
  readonly requestedAt: string;
  /** The host-authoritative attempt ID created alongside the obligation. */
  attemptId: string | null;
  /** The obligation ID the attempt was created for. */
  obligationId: string | null;
  /** Whether a Task call to flowguard-reviewer has been made (Level 1). */
  subagentCalled: boolean;
  /** Record of the actual subagent call, if made (Level 2). */
  subagentRecord: SubagentRecord | null;
  /** Content metadata for prompt integrity validation (Level 3). */
  contentMeta: ContentMeta | null;
  /**
   * Trailing marker of the canonical reviewer prompt FlowGuard emitted, when it
   * emitted one.
   *
   * The host-issued prompt contains frozen review material below this line.
   * Recording the marker lets enforcement verify that the canonical prompt
   * includes a reviewable artifact rather than only an instruction block.
   */
  canonicalPromptAnchor: string | null;
  /** SHA-256 of the complete host-issued reviewer prompt. */
  expectedPromptDigest: string | null;
  /** Exact host-issued prompt bytes. Never derive execution provenance from model args. */
  canonicalPrompt?: string | null;
  /** Actual findings from the subagent response (Level 4). */
  capturedFindings: CapturedFindings | null;
  /** Number of times the reviewer was re-invoked for this obligation. */
  retryCount: number;
  /**
   * Host-issued attestation constants (mandateDigest/criteriaVersion) captured
   * from the review-requirement signal (requiredReviewAttestation, top-level
   * for /review or under reviewInvocation for plan/implement/architecture).
   *
   * Storage-form optional for fixture compatibility only; semantics are
   * enforced in enforcement.ts: a bindable pending (obligationId != null) MUST
   * carry them. A bindable pending without them is a structural host-context
   * defect (see `enforcementFailure`), never a reviewer-output failure.
   */
  hostAttestationConstants?: {
    readonly mandateDigest: string;
    readonly criteriaVersion: string;
  } | null;
  /**
   * Structural host-context defect detected at the signal→pending transition
   * (trackRequiredReview) or, as defense-in-depth, at the capture transition.
   * NOT a reviewer-output failure — a reviewer invocation can never repair it,
   * so such pendings are excluded from re-arm/repair and block reviewer
   * dispatch explicitly (HOST_REVIEW_CONTEXT_UNAVAILABLE) BEFORE the first
   * Task runs.
   *
   * - 'host_attestation_constants_missing': the REVIEW_REQUIRED signal named an
   *   obligation but carried no requiredReviewAttestation constants.
   * - 'host_review_obligation_missing': the REVIEW_REQUIRED signal carried no
   *   obligation identity at all, although every canonical emitter creates the
   *   obligation before emitting the signal.
   */
  enforcementFailure?:
    'host_attestation_constants_missing' | 'host_review_obligation_missing' | null;
  /**
   * Reviewer-actionable issues from the most recent failed capture, computed
   * against the host-normalized canonical candidate — the same
   * `prepareReviewerFindingsForValidation` authority the bind gate uses.
   * Used to generate the canonical retry prompt so the reviewer can fix
   * specific errors instead of guessing. Never set for structural
   * host-context defects.
   */
  lastSchemaErrors: readonly string[] | null;
  /**
   * Whether a fresh canonical repair prompt (from flowguard_review) is
   * required before the next reviewer Task invocation. Set to true when
   * the reviewer produces schema-invalid output.
   */
  repairPromptRequired: boolean;
  /**
   * SHA256 digest of the exact canonical repair prompt issued by
   * flowguard_review. Set when handleHostTaskPolicy generates a retry
   * prompt. enforceBeforeSubagentCall validates this digest against the
   * task prompt to prove the prompt was issued by FlowGuard, not
   * fabricated by the parent.
   */
  expectedRepairPromptDigest: string | null;
}

/** Session-level enforcement state. */
export interface SessionEnforcementState {
  /** Pending reviews keyed by tool name. */
  readonly pendingReviews: Map<PendingReviewTool, PendingReview>;
  /** Host-owned before/after Task transport binding, keyed by the host call ID. */
  readonly executedTaskPrompts: Map<string, ExecutedTaskPrompt>;
}

/** Exact prompt bytes injected by the host for one Task execution. */
export interface ExecutedTaskPrompt {
  readonly callId: string;
  readonly obligationId: string;
  readonly attemptId: string;
  readonly canonicalPrompt: string;
  readonly canonicalPromptDigest: string;
  readonly modelPromptDigest: string | null;
  readonly createdAt: string;
}

/**
 * Optional context from the plugin hook for session ID resolution.
 *
 * Tier 1: `metadata.sessionID` — authoritative, from the task tool runtime.
 * Tier 2: Text extraction from the reviewer's output (existing behavior).
 * Tier 3: `derived:call:${callID}` — synthetic, guaranteed unique.
 */
export interface TaskToolContext {
  /** Metadata from the task tool output (may contain child sessionID). */
  readonly metadata?: Record<string, unknown>;
  /** Tool call ID — unique per invocation, used for Tier 3 synthetic ID. */
  readonly callID?: string;
}

/** Result of an enforcement check. */
export type EnforcementResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: string; readonly reason: string };

// ─── Constants ───────────────────────────────────────────────────────────────

/** The prefix that FlowGuard tools use to signal subagent review is required. */
export const REVIEW_REQUIRED_PREFIX = 'INDEPENDENT_REVIEW_REQUIRED';

/**
 * Canonical host signal for a reviewer Task requirement. Emitters attach the
 * obligation and attempt IDs alongside this signal; enforcement owns tracking
 * those IDs as the Task-binding authority.
 */
export function formatReviewRequiredSignal(iteration: number, planVersion: number): string {
  return `${REVIEW_REQUIRED_PREFIX}: iteration=${iteration}, planVersion=${planVersion}`;
}

/**
 * Opening of the trailing line of the canonical reviewer prompt, which tells the
 * agent to append the artifact below it.
 *
 * Shared contract between the emitter (renderReviewerTaskPrompt) and the checker
 * (enforceBeforeSubagentCall), which locates it to verify that something was
 * actually appended. Held here for the same reason as REVIEW_REQUIRED_PREFIX:
 * emitter and enforcement must never drift apart.
 */
export const CANONICAL_PROMPT_APPEND_MARKER = 'Append the';

/** The subagent type name for the FlowGuard reviewer. */
export { REVIEWER_SUBAGENT_TYPE } from '../../tool-names.js';

/**
 * Minimum prompt length for subagent calls (Level 3).
 * A real review prompt must include plan/implementation text, ticket context,
 * iteration, and planVersion. 200 characters is a generous floor that catches
 * empty or trivially short prompts.
 */
export const MIN_SUBAGENT_PROMPT_LENGTH = 200;

/**
 * Machine-readable outcome of a host-task bind attempt.
 * Used for diagnostic logging — NOT a governance reason code.
 */
export type HostTaskBindOutcome =
  | 'bound'
  | 'no_matched_record'
  | 'no_child_session'
  | 'no_obligation_type'
  | 'no_findings'
  | 'extraction_invalid'
  | 'no_matching_obligation'
  | 'field_mismatch'
  | 'duplicate_evidence'
  | 'schema_invalid'
  | 'client_reference_invalid'
  | 'challenge_contract_violation'
  | 'challenge_evidence_unknown'
  | 'findings_incoherent'
  | 'review_finding_out_of_scope'
  | 'review_finding_scope_unverifiable'
  | 'repository_evidence_unbound'
  | 'subject_mismatch'
  | 'stale_attempt'
  | 'idempotent_bound'
  | 'idempotent_rejected'
  | 'unknown_attempt';

// ─── Phase-Separated Capture Pipeline Outcomes ─────────────────────────────────

/** Outcome of the capture phase (did the Task tool produce output?). */
export type CaptureOutcome = 'captured' | 'capture_failed';

/** Outcome of the extraction phase (could JSON be recovered from the output?). */
export type ExtractionOutcome =
  'exact_payload' | 'recovered_payload' | 'payload_not_found' | 'payload_ambiguous';

/** Outcome of the validation phase (did the payload pass schema + identity checks?). */
export type ValidationOutcome = 'valid' | 'schema_invalid' | 'client_reference_invalid';

/** Assurance level for the capture quality. */
export type CaptureAssurance = 'exact_json' | 'structured_recovered';

/**
 * Aggregated result for a single review attempt across all phases.
 *
 * Phases execute in order: Capture → Extraction → Validation → Binding.
 * Each phase only populates when the previous phase succeeded.
 */
export interface ReviewAttemptResult {
  readonly attemptId: string;
  readonly captureOutcome: CaptureOutcome;
  readonly extractionOutcome?: ExtractionOutcome;
  readonly validationOutcome?: ValidationOutcome;
  readonly bindOutcome?: HostTaskBindOutcome;
  readonly captureAssurance?: CaptureAssurance;
  readonly reasonCode?: string;
  readonly diagnostics?: Record<string, unknown>;
}

/**
 * Structured result from buildHostTaskEvidence.
 *
 * Always includes a machine-readable `bindOutcome` and a serializable
 * `diagnostic` object so the caller can log exactly why binding succeeded
 * or failed without re-inspecting internal state.
 */
export interface HostTaskBindResult {
  /** Created evidence, or null if binding failed. */
  evidence: import('../../../state/evidence.js').ReviewInvocationEvidence | null;
  /** Machine-readable bind outcome for logging. */
  bindOutcome: HostTaskBindOutcome;
  /** Structured diagnostic metadata (safe to JSON.stringify). */
  diagnostic: Record<string, unknown>;
  /** The review attempt that was resolved/created during binding (for persistence). */
  attempt?: import('../../../state/evidence.js').ReviewAttempt;
}
