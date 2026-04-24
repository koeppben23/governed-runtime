/**
 * @module evidence
 * @description All evidence and artifact types for the FlowGuard state model.
 *              Zod schemas — single source of truth for runtime validation and TypeScript types.
 *
 * Dependency: imports identity schema for typed policy snapshot authority.
 *
 * @version v1
 */

import { z } from 'zod';
import { IdpConfigSchema } from '../identity/types.js';

/**
 * P34: Coerce P33 v0 'verified' to 'claim_validated'.
 * Any unknown value falls through to 'best_effort' (safe default for backward compat).
 */
function coerceAssurance(raw: unknown): 'best_effort' | 'claim_validated' | 'idp_verified' {
  if (raw === 'verified' || raw === 'claim_validated' || raw === 'idp_verified') {
    if (raw === 'verified') return 'claim_validated';
    return raw as 'claim_validated' | 'idp_verified';
  }
  return 'best_effort';
}

/**
 * Assurance value parser with P33 v0 backward compat.
 * "verified" passes through the union and is coerced to "claim_validated".
 * Unknown values fall back to "best_effort".
 */
function assuranceSchema() {
  return z
    .union([
      z.literal('verified'),
      z.literal('best_effort'),
      z.literal('claim_validated'),
      z.literal('idp_verified'),
    ])
    .transform((val) => coerceAssurance(val));
}

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

// ─── Independent Review Findings ──────────────────────────────────────────

/**
 * Single finding from an independent review.
 */
export const Finding = z.object({
  severity: z.enum(['critical', 'major', 'minor']),
  category: z.enum(['completeness', 'correctness', 'feasibility', 'risk', 'quality']),
  message: z.string(),
  location: z.string().optional(),
});
export type Finding = z.infer<typeof Finding>;

/**
 * Identity information for the review actor (subagent or self).
 * Provides provenance for independent review attribution.
 */
export const ReviewActorInfo = z.object({
  sessionId: z.string(),
  actorId: z.string().optional(),
  actorSource: z.enum(['env', 'git', 'claim', 'unknown']).optional(),
  actorAssurance: assuranceSchema().optional(),
});
export type ReviewActorInfo = z.infer<typeof ReviewActorInfo>;

/**
 * P35 strict independent-review attestation.
 * Binds findings to one obligation + mandate version/digest.
 */
export const ReviewAttestation = z.object({
  mandateDigest: z.string().min(1),
  criteriaVersion: z.string().min(1),
  toolObligationId: z.string().uuid(),
  iteration: z.number().int().nonnegative(),
  planVersion: z.number().int().positive(),
  reviewedBy: z.literal('flowguard-reviewer'),
});
export type ReviewAttestation = z.infer<typeof ReviewAttestation>;

/**
 * Structured findings from an independent review.
 * Enables read-only subagent review without direct state/file writes.
 */
export const ReviewFindings = z.object({
  iteration: z.number().int().nonnegative(),
  planVersion: z.number().int().positive(),
  reviewMode: z.enum(['subagent', 'self']),
  overallVerdict: LoopVerdict,
  blockingIssues: z.array(Finding),
  majorRisks: z.array(Finding),
  missingVerification: z.array(z.string()),
  scopeCreep: z.array(z.string()),
  unknowns: z.array(z.string()),
  reviewedBy: ReviewActorInfo,
  reviewedAt: z.string().datetime(),
  attestation: ReviewAttestation.optional(),
});
export type ReviewFindings = z.infer<typeof ReviewFindings>;

/** Independent review obligation type. */
export const ReviewObligationType = z.enum(['plan', 'implement']);
export type ReviewObligationType = z.infer<typeof ReviewObligationType>;

/** Strict review obligation state. */
export const ReviewObligationStatus = z.enum(['pending', 'fulfilled', 'consumed', 'blocked']);
export type ReviewObligationStatus = z.infer<typeof ReviewObligationStatus>;

/**
 * P35 strict obligation record.
 * Exactly one independent review invocation must fulfill each obligation.
 */
export const ReviewObligation = z.object({
  obligationId: z.string().uuid(),
  obligationType: ReviewObligationType,
  iteration: z.number().int().nonnegative(),
  planVersion: z.number().int().positive(),
  criteriaVersion: z.string().min(1),
  mandateDigest: z.string().min(1),
  createdAt: z.string().datetime(),
  pluginHandshakeAt: z.string().datetime().nullable(),
  status: ReviewObligationStatus,
  invocationId: z.string().uuid().nullable(),
  blockedCode: z.string().nullable(),
  fulfilledAt: z.string().datetime().nullable(),
  consumedAt: z.string().datetime().nullable(),
});
export type ReviewObligation = z.infer<typeof ReviewObligation>;

/** P35 strict invocation evidence record. */
export const ReviewInvocationEvidence = z.object({
  invocationId: z.string().uuid(),
  obligationId: z.string().uuid(),
  obligationType: ReviewObligationType,
  parentSessionId: z.string().min(1),
  childSessionId: z.string().min(1),
  agentType: z.literal('flowguard-reviewer'),
  promptHash: z.string().min(1),
  mandateDigest: z.string().min(1),
  criteriaVersion: z.string().min(1),
  findingsHash: z.string().min(1),
  invokedAt: z.string().datetime(),
  fulfilledAt: z.string().datetime(),
  consumedByObligationId: z.string().uuid().nullable(),
});
export type ReviewInvocationEvidence = z.infer<typeof ReviewInvocationEvidence>;

/** Persistent strict review assurance state. */
export const ReviewAssuranceState = z.object({
  obligations: z.array(ReviewObligation),
  invocations: z.array(ReviewInvocationEvidence),
});
export type ReviewAssuranceState = z.infer<typeof ReviewAssuranceState>;

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
 * - reviewFindings: independent review findings per iteration (parallel, NOT mixed)
 *
 * Architecture invariant: plan.history = author artifacts, plan.reviewFindings = reviewer artifacts
 */
export const PlanRecord = z.object({
  current: PlanEvidence,
  history: z.array(PlanEvidence),
  reviewFindings: z.array(ReviewFindings).optional(),
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

// ─── Decision Identity ────────────────────────────────────────────────────────

/**
 * Structured identity for decision attribution (P30/P33/P34).
 * Extends ActorInfo with assurance level for regulated contexts.
 *
 * P34: actorAssurance now uses three-tier model:
 * - best_effort: operator-provided, no third-party verification
 * - claim_validated: schema + expiry validated from local claim file
 * - idp_verified: cryptographic IdP verification (future P35)
 *
 * Backward compat: 'verified' from P33 v0 is coerced to 'claim_validated'.
 */
export const DecisionIdentity = z.object({
  actorId: z.string().min(1),
  actorEmail: z.string().nullable(),
  actorDisplayName: z.string().nullable().optional(),
  actorSource: z.enum(['env', 'git', 'claim', 'oidc', 'unknown']),
  actorAssurance: assuranceSchema().default('best_effort'),
});
export type DecisionIdentity = z.infer<typeof DecisionIdentity>;

// ─── Review Decision ──────────────────────────────────────────────────────────

/**
 * Human review decision at a User Gate (PLAN_REVIEW, EVIDENCE_REVIEW, or ARCH_REVIEW).
 *
 * P30: Includes structured decisionIdentity for regulated approval attribution.
 * The decidedBy field remains for backward compatibility; decisionIdentity
 * provides full provenance for audit and four-eyes proof.
 */
export const ReviewDecision = z.object({
  verdict: ReviewVerdict,
  rationale: z.string(),
  decidedAt: z.string().datetime(),
  decidedBy: z.string().min(1),
  decisionIdentity: DecisionIdentity.optional(),
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
  /** Applied policy source (P29): explicit, central, repo, or default. */
  source: z.enum(['explicit', 'central', 'repo', 'default']).optional(),
  /** Effective gate behavior after mode resolution. */
  effectiveGateBehavior: z.enum(['auto_approve', 'human_gated']),
  /** Why requested mode was degraded (if applicable). */
  degradedReason: z.string().optional(),
  /** Why source precedence selected/overrode a mode (P29). */
  resolutionReason: z.string().optional(),
  /** Central minimum mode that constrained resolution (P29). */
  centralMinimumMode: z.enum(['solo', 'team', 'regulated']).optional(),
  /** Digest of the central policy bundle used at hydrate time (P29). */
  policyDigest: z.string().optional(),
  /** Version string from central policy bundle (P29). */
  policyVersion: z.string().optional(),
  /** Redacted policy path hint from central policy bundle (P29). */
  policyPathHint: z.string().optional(),

  // ── Governance-critical fields (frozen copy) ───────────────
  requireHumanGates: z.boolean(),
  maxSelfReviewIterations: z.number().int().positive(),
  maxImplReviewIterations: z.number().int().positive(),
  allowSelfApproval: z.boolean(),
  /**
   * P34: Minimum required actor assurance for regulated approval decisions.
   * Supersedes requireVerifiedActorsForApproval at session resolution time.
   * 'best_effort' | 'claim_validated' | 'idp_verified'
   */
  minimumActorAssuranceForApproval: z
    .enum(['best_effort', 'claim_validated', 'idp_verified'])
    .default('best_effort'),
  /**
   * P33 (deprecated): Whether regulated approvals require verified actor identity.
   * Preserved for backward compat with existing sessions. Prefer minimumActorAssuranceForApproval.
   */
  requireVerifiedActorsForApproval: z.boolean().default(false),
  /**
   * P35a/P35b1/P35b2: IdP configuration for static keys or JWKS authority.
   * Frozen at hydrate time. When set, allows idp_verified actors via FLOWGUARD_ACTOR_TOKEN_PATH.
   */
  identityProvider: IdpConfigSchema.optional(),
  /**
   * P35a: IdP verification mode ('optional' or 'required').
   * Controls whether IdP verification failure blocks session creation.
   */
  identityProviderMode: z.enum(['optional', 'required']).default('optional'),
  /**
   * Self-review configuration for independent review.
   * Frozen at hydrate time. Controls subagent-based review behavior.
   */
  selfReview: z
    .object({
      subagentEnabled: z.boolean(),
      fallbackToSelf: z.boolean(),
      strictEnforcement: z.boolean().default(false),
    })
    .optional(),
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
 * Actor verification metadata for IdP-verified actors (P35a).
 * Provides provenance information about the IdP verification:
 * - Which issuer and audience were verified
 * - Which key was used for signature verification
 * - When the verification occurred
 */
export const ActorVerificationMetaSchema = z.object({
  issuer: z.string(),
  audience: z.array(z.string()),
  keyId: z.string(),
  algorithm: z.string(),
  verifiedAt: z.string().datetime(),
});
export type ActorVerificationMeta = z.infer<typeof ActorVerificationMetaSchema>;

/**
 * Resolved operator identity for audit attribution (P27/P34/P35a).
 *
 * Three-tier assurance model:
 * - best_effort: operator-provided, no third-party verification (env/git/unknown)
 * - claim_validated: schema + expiry validated from local claim file (claim source)
 * - idp_verified: cryptographic IdP verification (oidc source, P35a)
 *
 * P35a adds verificationMeta for idp_verified actors to provide IdP provenance.
 *
 * P34 design doc: docs/actor-assurance-architecture.md
 */
export const ActorInfoSchema = z.object({
  id: z.string().min(1),
  email: z.string().nullable(),
  displayName: z.string().nullable().optional(),
  source: z.enum(['env', 'git', 'claim', 'oidc', 'unknown']),
  assurance: assuranceSchema().default('best_effort'),
  verificationMeta: ActorVerificationMetaSchema.optional(),
});
export type ActorInfo = z.infer<typeof ActorInfoSchema>;

/**
 * Schema version of DecisionIdentity for state imports.
 */
export const DecisionIdentitySchema = DecisionIdentity;

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
