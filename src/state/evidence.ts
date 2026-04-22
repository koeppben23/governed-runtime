/**
 * @module evidence
 * @description All evidence and artifact types for the FlowGuard state model.
 *              Zod schemas — single source of truth for runtime validation and TypeScript types.
 *
 * Dependency: leaf module — no imports from other FlowGuard modules.
 *
 * @version v1
 */

import { z } from 'zod';

// ─── Closed Enums ─────────────────────────────────────────────────────────────

/**
 * Validation check identifier.
 *
 * Open string — profile registry validates at runtime which IDs are valid.
 * This replaces the closed z.enum() to support extensible profiles:
 * - Profiles register their check IDs (e.g., "test_quality", "rollback_safety")
 * - Custom profiles can add any check ID (e.g., "sast_scan", "license_check")
 * - Runtime validation happens at hydrate time (profile registry) and
 *   at validation time (submitted check IDs must be in activeChecks)
 *
 * Known base IDs (from baseline profile): "test_quality", "rollback_safety".
 */
export const CheckId = z.string().min(1);
export type CheckId = z.infer<typeof CheckId>;

/** User review verdict at a User Gate (approve, request changes, or reject). */
export const ReviewVerdict = z.enum(['approve', 'changes_requested', 'reject']);
export type ReviewVerdict = z.infer<typeof ReviewVerdict>;

/** Revision delta between iterations (digest comparison result). */
export const RevisionDelta = z.enum(['none', 'minor', 'major']);
export type RevisionDelta = z.infer<typeof RevisionDelta>;

/**
 * Self-review / impl-review loop verdict.
 * Only approve or changes_requested — no reject (that's a human-only action).
 */
export const LoopVerdict = z.enum(['approve', 'changes_requested']);
export type LoopVerdict = z.infer<typeof LoopVerdict>;

/** Safe opaque OpenCode session ID segment (e.g. `ses_...`). */
const OpenCodeSessionId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

// ─── Binding ──────────────────────────────────────────────────────────────────

/**
 * Workspace binding resolved during init().
 * Links an OpenCode session to a git worktree and workspace registry.
 * Populated by context.sessionID and context.worktree from the Custom Tool API.
 *
 * fingerprint: 24-hex repository fingerprint derived from the canonical remote
 * URL (or local path fallback). Used as the workspace directory name under
 * ~/.config/opencode/workspaces/{fingerprint}/. Deterministic and stable
 * across clones of the same remote.
 */
export const BindingInfo = z.object({
  // OpenCode session IDs are opaque non-UUID identifiers (e.g. "ses_260740c65ffe77...").
  sessionId: OpenCodeSessionId,
  worktree: z.string().min(1),
  fingerprint: z.string().regex(/^[0-9a-f]{24}$/),
  resolvedAt: z.string().datetime(),
});
export type BindingInfo = z.infer<typeof BindingInfo>;

// ─── Ticket ───────────────────────────────────────────────────────────────────

/** Evidence produced by /ticket — the user's task description. */
export const TicketEvidence = z.object({
  text: z.string().min(1),
  digest: z.string().min(1),
  source: z.enum(['user', 'external']),
  createdAt: z.string().datetime(),
});
export type TicketEvidence = z.infer<typeof TicketEvidence>;

// ─── Plan ─────────────────────────────────────────────────────────────────────

/** A single plan version (immutable snapshot). */
export const PlanEvidence = z.object({
  body: z.string().min(1),
  digest: z.string().min(1),
  sections: z.array(z.string()),
  createdAt: z.string().datetime(),
});
export type PlanEvidence = z.infer<typeof PlanEvidence>;

/**
 * Plan record with version history.
 * Compliance requirement for regulated environments (banks, DATEV):
 * every plan revision must be preserved for audit trail.
 *
 * - current: the active plan version
 * - history: all previous versions (newest first)
 */
export const PlanRecord = z.object({
  current: PlanEvidence,
  history: z.array(PlanEvidence),
});
export type PlanRecord = z.infer<typeof PlanRecord>;

// ─── Self-Review Loop ─────────────────────────────────────────────────────────

/**
 * State of the PLAN phase self-review loop.
 * Convergence: iteration >= maxIterations OR (revisionDelta === "none" AND verdict === "approve").
 * This is the "digest-stop" mechanism.
 */
export const SelfReviewLoop = z.object({
  iteration: z.number().int().nonnegative(),
  maxIterations: z.number().int().positive(),
  prevDigest: z.string().nullable(),
  currDigest: z.string().min(1),
  revisionDelta: RevisionDelta,
  verdict: LoopVerdict,
});
export type SelfReviewLoop = z.infer<typeof SelfReviewLoop>;

// ─── Validation ───────────────────────────────────────────────────────────────

/** Result of a single validation check. */
export const ValidationResult = z.object({
  checkId: CheckId,
  passed: z.boolean(),
  detail: z.string(),
  executedAt: z.string().datetime(),
});
export type ValidationResult = z.infer<typeof ValidationResult>;

// ─── Implementation ───────────────────────────────────────────────────────────

/** Evidence produced by /implement — what files were changed. */
export const ImplEvidence = z.object({
  changedFiles: z.array(z.string()),
  domainFiles: z.array(z.string()),
  digest: z.string().min(1),
  executedAt: z.string().datetime(),
});
export type ImplEvidence = z.infer<typeof ImplEvidence>;

// ─── Implementation Review ────────────────────────────────────────────────────

/**
 * Result of an implementation review iteration (IMPL_REVIEW phase).
 * Same convergence logic as SelfReviewLoop: digest-stop.
 */
export const ImplReviewResult = z.object({
  iteration: z.number().int().nonnegative(),
  maxIterations: z.number().int().positive(),
  prevDigest: z.string().nullable(),
  currDigest: z.string().min(1),
  revisionDelta: RevisionDelta,
  verdict: LoopVerdict,
  executedAt: z.string().datetime(),
});
export type ImplReviewResult = z.infer<typeof ImplReviewResult>;

// ─── Architecture Decision Record ─────────────────────────────────────────────

/** Status of an Architecture Decision Record. */
export const AdrStatus = z.enum(['proposed', 'accepted', 'deprecated']);
export type AdrStatus = z.infer<typeof AdrStatus>;

/**
 * Required MADR sections in the ADR text.
 * The adrText MUST contain these markdown headings for section validation.
 */
export const REQUIRED_ADR_SECTIONS = ['## Context', '## Decision', '## Consequences'] as const;

/**
 * Validate that an ADR text contains all required MADR sections.
 * Returns the list of missing section headings (empty = valid).
 */
export function validateAdrSections(adrText: string): string[] {
  return REQUIRED_ADR_SECTIONS.filter((heading) => !adrText.includes(heading));
}

/**
 * Architecture Decision Record (ADR) evidence.
 * Produced by the /architecture flow. Follows MADR format.
 *
 * The adrText is free-form Markdown that MUST contain:
 * - ## Context
 * - ## Decision
 * - ## Consequences
 */
export const ArchitectureDecision = z.object({
  /** ADR identifier (e.g., "ADR-1", "ADR-42"). */
  id: z.string().regex(/^ADR-\d+$/),
  /** Short title of the architecture decision. */
  title: z.string().min(1),
  /** Full ADR body in Markdown (MADR format with required sections). */
  adrText: z.string().min(1),
  /** Lifecycle status of the ADR. */
  status: AdrStatus,
  /** When the ADR was created. */
  createdAt: z.string().datetime(),
  /** SHA-256 digest of the adrText for integrity verification. */
  digest: z.string().min(1),
});
export type ArchitectureDecision = z.infer<typeof ArchitectureDecision>;

// ─── Review Decision ──────────────────────────────────────────────────────────

/** Human review decision at a User Gate (PLAN_REVIEW, EVIDENCE_REVIEW, or ARCH_REVIEW). */
export const ReviewDecision = z.object({
  verdict: ReviewVerdict,
  rationale: z.string(),
  decidedAt: z.string().datetime(),
  decidedBy: z.string().min(1),
});
export type ReviewDecision = z.infer<typeof ReviewDecision>;

// ─── Error ────────────────────────────────────────────────────────────────────

/** Fail-closed error state with recovery info. */
export const ErrorInfo = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  recoveryHint: z.string(),
  occurredAt: z.string().datetime(),
});
export type ErrorInfo = z.infer<typeof ErrorInfo>;

// ─── Policy Snapshot ──────────────────────────────────────────────────────────

/**
 * Immutable policy snapshot embedded in SessionState.
 *
 * Stores all FlowGuard-critical fields so auditors can verify which rules
 * governed a session — even after policy presets are updated.
 *
 * The hash is SHA-256 of the canonical JSON of the full GovernancePolicy.
 * Non-repudiation: hash matches → policy is authentic and unmodified.
 *
 * Lives in state layer (not config) because it is part of SessionState —
 * the innermost layer must not depend on outer layers.
 */
export const PolicySnapshotSchema = z.object({
  /**
   * The effective policy mode at session creation time.
   * This is the result of resolvePolicyWithContext(requestedMode) —
   * may differ from requestedMode when team-ci degrades without CI.
   * Use requestedMode to see what was originally requested.
   */
  mode: z.string(),
  /** SHA-256 hash of the canonical JSON of the full GovernancePolicy. */
  hash: z.string(),
  /** When the policy was resolved and frozen. */
  resolvedAt: z.string().datetime(),
  /** Original requested policy mode at hydrate time. */
  requestedMode: z.string(),
  /** Effective gate behavior after mode resolution. */
  effectiveGateBehavior: z.enum(['auto_approve', 'human_gated']),
  /** Why requested mode was degraded (if applicable). */
  degradedReason: z.string().optional(),

  // ── Governance-critical fields (frozen copy) ───────────────
  requireHumanGates: z.boolean(),
  maxSelfReviewIterations: z.number().int().positive(),
  maxImplReviewIterations: z.number().int().positive(),
  allowSelfApproval: z.boolean(),
  audit: z.object({
    emitTransitions: z.boolean(),
    emitToolCalls: z.boolean(),
    enableChainHash: z.boolean(),
  }),
  /**
   * Actor classification map — frozen copy from policy preset.
   * Maps tool names to actor labels for the audit trail.
   * Tools not listed default to "system" at runtime.
   */
  actorClassification: z.record(z.string(), z.string()),
});
export type PolicySnapshot = z.infer<typeof PolicySnapshotSchema>;

// ─── Actor Identity ───────────────────────────────────────────────────────────

/**
 * Resolved operator identity for audit attribution (P27).
 *
 * Best-effort identity — NOT a cryptographic authentication claim.
 * The `source` field makes the identity origin transparent:
 * - `env`:     Operator-provided via FLOWGUARD_ACTOR_ID / FLOWGUARD_ACTOR_EMAIL
 * - `git`:     Derived from `git config user.name` / `git config user.email`
 * - `unknown`: Neither env nor git identity available
 *
 * Resolved once at hydrate time, immutable for the session lifecycle.
 */
export const ActorInfoSchema = z.object({
  id: z.string().min(1),
  email: z.string().nullable(),
  source: z.enum(['env', 'git', 'unknown']),
});
export type ActorInfoSchema = z.infer<typeof ActorInfoSchema>;

// ─── Audit Event ──────────────────────────────────────────────────────────────

/**
 * Single audit event — appended to JSONL audit trail.
 * Phase is a plain string (forward-compatible: new phases don't break old logs).
 *
 * Hash chain fields (prevHash, chainHash) are optional for backward compatibility:
 * - Legacy events (pre-chain) omit these fields
 * - New events always include them
 * - The integrity verifier handles mixed trails gracefully
 *
 * Actor identity (P27):
 * - `actor`: Classification label — "human", "machine", or "system" (string)
 * - `actorInfo`: Optional structured identity (id, email, source). Present on
 *   human-influenced events (lifecycle, tool_call, decision). Absent on
 *   machine-only events (transition, error). When absent, JSON.stringify
 *   omits the field — chain hash stays identical for pre-P27 events.
 */
export const AuditEvent = z.object({
  id: z.string().uuid(),
  // OpenCode session IDs are opaque non-UUID identifiers (e.g. "ses_260740c65ffe77...").
  sessionId: OpenCodeSessionId,
  phase: z.string(),
  event: z.string(),
  timestamp: z.string().datetime(),
  actor: z.string(),
  detail: z.record(z.unknown()),
  /** Resolved actor identity. Present on human-influenced events, absent on machine-only. */
  actorInfo: ActorInfoSchema.optional(),
  /** Hash of the previous event in the chain (or "genesis" for the first event). */
  prevHash: z.string().optional(),
  /** SHA-256(prevHash + canonical JSON of this event). Tamper-evident chain link. */
  chainHash: z.string().optional(),
});
export type AuditEvent = z.infer<typeof AuditEvent>;

// ─── Review Report (Standalone Compliance Artifact) ───────────────────────────

/**
 * Standalone review report — written as a separate file, NOT embedded in state.
 * Own schema version for independent evolution.
 * Generated by /review (read-only, always available).
 */
export const ReviewReport = z.object({
  schemaVersion: z.literal('flowguard-review-report.v1'),
  sessionId: z.string().uuid(),
  generatedAt: z.string().datetime(),
  phase: z.string(),
  planDigest: z.string().nullable(),
  implDigest: z.string().nullable(),
  validationSummary: z.array(
    z.object({
      checkId: CheckId,
      passed: z.boolean(),
      detail: z.string(),
    }),
  ),
  findings: z.array(
    z.object({
      severity: z.enum(['info', 'warning', 'error']),
      category: z.string(),
      message: z.string(),
    }),
  ),
  overallStatus: z.enum(['clean', 'warnings', 'issues']),
});
export type ReviewReport = z.infer<typeof ReviewReport>;
