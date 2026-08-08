/**
 * @module evidence-review
 * @description Review findings, obligations, invocation evidence, assurance,
 *              completeness report, review decision, and standalone review report schemas.
 *
 * @version v1
 */

import { z } from 'zod';
import { REVIEWER_SUBAGENT_TYPE, REVIEW_REPORT_SCHEMA_ID } from './evidence-identifiers.js';
import { assuranceSchema } from './evidence-assurance-internal.js';
import {
  CheckId,
  ExternalReferenceSchema,
  InputOriginSchema,
  LoopVerdict,
  ReviewObligationType,
  ReviewObligationStatus,
  ReviewVerdict,
} from './evidence-primitives.js';
import { ActorInfoSchema, DecisionIdentity } from './evidence-identity.js';

// ─── Review Attempt (Invocation Envelope) ─────────────────────────────────────

export const ReviewAttemptStatusValues = [
  'created',
  'captured',
  'rejected',
  'bound',
  'stale',
  'expired',
] as const;

export const ReviewAttemptStatus = z.enum(ReviewAttemptStatusValues);
export type ReviewAttemptStatus = z.infer<typeof ReviewAttemptStatus>;

export const ReviewAttempt = z.object({
  attemptId: z.string().uuid(),
  obligationId: z.string().uuid(),
  obligationType: ReviewObligationType,
  subjectDigest: z.string().min(1),
  ordinal: z.number().int().nonnegative(),
  childSessionId: z.string().optional(),
  status: ReviewAttemptStatus,
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
});
export type ReviewAttempt = z.infer<typeof ReviewAttempt>;

// ─── Completeness Report ──────────────────────────────────────────────────────

export const EvidenceSlotStatusSchema = z.object({
  slot: z.string(),
  label: z.string(),
  required: z.boolean(),
  present: z.boolean(),
  status: z.enum(['complete', 'missing', 'not_yet_required', 'failed']),
  detail: z.string().optional(),
  artifactKind: z.string().optional(),
});

export const FourEyesStatusSchema = z.object({
  required: z.boolean(),
  satisfied: z.boolean(),
  initiatedBy: z.string(),
  decidedBy: z.string().nullable(),
  detail: z.string(),
});

export const CompletenessSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  complete: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
  notYetRequired: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});

export const CompletenessReportSchema = z.object({
  sessionId: z.string().uuid(),
  phase: z.string(),
  policyMode: z.string(),
  overallComplete: z.boolean(),
  slots: z.array(EvidenceSlotStatusSchema),
  fourEyes: FourEyesStatusSchema,
  summary: CompletenessSummarySchema,
});

// ─── Independent Review Findings ───────────────────────────────────────────────

/**
 * Single finding from an independent review.
 */
export const Finding = z
  .object({
    severity: z.enum(['critical', 'major', 'minor']),
    category: z.enum(['completeness', 'correctness', 'feasibility', 'risk', 'quality']),
    message: z.string(),
    location: z.string().optional(),
  })
  .readonly();
export type Finding = z.infer<typeof Finding>;

/** A deterministic Markdown heading path, including presentation-only text. */
export const MarkdownSectionPath = z
  .array(
    z.object({
      headingDepth: z.number().int().min(1).max(6),
      siblingIndex: z.number().int().positive(),
      headingText: z.string(),
    }),
  )
  .min(1)
  .readonly();
export type MarkdownSectionPath = z.infer<typeof MarkdownSectionPath>;

/** Digest-bound reference to a Plan or ADR section excerpt. */
export const PlanAdrSectionRef = z
  .object({
    kind: z.literal('plan_adr_section'),
    artifactKind: z.enum(['plan', 'adr']),
    artifactDigest: z.string().min(1),
    sectionPath: MarkdownSectionPath,
    excerptDigest: z.string().min(1),
  })
  .readonly();
export type PlanAdrSectionRef = z.infer<typeof PlanAdrSectionRef>;

/** Digest-bound reference to an implementation and its optional persisted diff. */
export const ImplementationRef = z
  .object({
    kind: z.literal('implementation'),
    implementationDigest: z.string().min(1),
    diffDigest: z.string().min(1).optional(),
  })
  .readonly();
export type ImplementationRef = z.infer<typeof ImplementationRef>;

/** Reference to an immutable validation-attempt authority record. */
export const ValidationAttemptRef = z
  .object({
    kind: z.literal('validation_attempt'),
    attemptId: z.string().uuid(),
  })
  .readonly();
export type ValidationAttemptRef = z.infer<typeof ValidationAttemptRef>;

/** Digest-bound reference to content reviewed outside a Plan, ADR, or implementation. */
export const ContentRef = z
  .object({
    kind: z.literal('content'),
    digest: z.string().min(1),
  })
  .readonly();
export type ContentRef = z.infer<typeof ContentRef>;

/** Typed evidence references permitted in a structured review challenge. */
export const ReviewChallengeEvidenceRef = z.discriminatedUnion('kind', [
  PlanAdrSectionRef,
  ImplementationRef,
  ValidationAttemptRef,
  ContentRef,
]);
export type ReviewChallengeEvidenceRef = z.infer<typeof ReviewChallengeEvidenceRef>;

/**
 * Reviewer-supplied correlation slug for a challenge.
 *
 * The reviewer never mints a challenge identity — the host does. This slug is
 * the reviewer's own handle for a challenge within a single payload; the host
 * maps it to the canonical `challengeId` during normalization and retains it so
 * the audit trail stays correlatable to the reviewer's original output.
 */
export const ChallengeClientReference = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/);

const ReviewChallengeBase = {
  challengeId: z.string().uuid(),
  obligationId: z.string().uuid(),
  clientReference: ChallengeClientReference.optional(),
  scenario: z.string().min(1),
  claim: z.string().min(1),
  locations: z.array(z.string().min(1)).min(1),
};

const DesignChallenge = z.object({
  ...ReviewChallengeBase,
  kind: z.literal('design_challenge'),
  evidenceRefs: z.array(PlanAdrSectionRef).min(1),
  outcome: z.enum(['supported', 'contradicted', 'not_verified']),
});

const ImplementationChallenge = z.object({
  ...ReviewChallengeBase,
  kind: z.literal('implementation_challenge'),
  evidenceRefs: z.array(z.union([ImplementationRef, ValidationAttemptRef])).min(1),
  outcome: z.enum(['pass', 'fail', 'not_verified']),
});

const ContentChallenge = z.object({
  ...ReviewChallengeBase,
  kind: z.literal('content_challenge'),
  evidenceRefs: z.array(ContentRef).min(1),
  outcome: z.enum(['supported', 'contradicted', 'not_verified']),
});

/**
 * An evidence-bound falsification attempt. This is advisory evidence only;
 * challenge requirement and resolution enforcement are deliberately separate.
 */
export const ReviewChallenge = z.discriminatedUnion('kind', [
  DesignChallenge.readonly(),
  ImplementationChallenge.readonly(),
  ContentChallenge.readonly(),
]);
export type ReviewChallenge = z.infer<typeof ReviewChallenge>;

// ─── Reviewer Challenge Input (non-authoritative, pre-normalization) ──────────

/**
 * The challenge shape a reviewer subagent is asked to produce.
 *
 * Derived from the canonical {@link ReviewChallenge} by omitting the
 * host-assigned `challengeId`, so the reviewer-facing contract and the binding
 * authority can never drift apart. A hand-maintained copy previously declared a
 * single flat `outcome` enum, which could not express an implementation
 * challenge (`pass` / `fail`) at all.
 *
 * This type documents the contract; the canonical {@link ReviewFindings} schema
 * remains the sole runtime gate at binding time.
 */
export const ReviewerChallengeInput = z.discriminatedUnion('kind', [
  DesignChallenge.omit({ challengeId: true }).readonly(),
  ImplementationChallenge.omit({ challengeId: true }).readonly(),
  ContentChallenge.omit({ challengeId: true }).readonly(),
]);
export type ReviewerChallengeInput = z.infer<typeof ReviewerChallengeInput>;

/**
 * Advisory evidence that an implementation challenge was addressed by the
 * current implementation and its immutable post-implementation checks.
 * Resolution remains deliberately separate from review acceptance policy.
 */
export const ChallengeResolution = z
  .object({
    challengeId: z.string().uuid(),
    implementationDigest: z.string().min(1),
    validationAttemptIds: z.array(z.string().uuid()).min(1),
    resolvedAt: z.string().datetime(),
    /** Author evidence is a proposal only; it never resolves a challenge. */
    author: ActorInfoSchema.optional(),
  })
  .readonly();
export type ChallengeResolution = z.infer<typeof ChallengeResolution>;

/** An independent reviewer's verdict on a prior implementation challenge resolution. */
export const ChallengeResolutionVerdict = z
  .object({
    challengeId: z.string().uuid(),
    verdict: z.enum(['resolved', 'still_failing', 'not_verified']),
  })
  .readonly();
export type ChallengeResolutionVerdict = z.infer<typeof ChallengeResolutionVerdict>;

/**
 * Identity information for the review actor (subagent or self).
 * Provides provenance for independent review attribution.
 */
export const ReviewActorInfo = z
  .object({
    sessionId: z.string(),
    actorId: z.string().optional(),
    actorSource: z.enum(['env', 'git', 'claim', 'unknown']).optional(),
    actorAssurance: assuranceSchema().optional(),
  })
  .readonly();
export type ReviewActorInfo = z.infer<typeof ReviewActorInfo>;

/**
 * P35 strict independent-review attestation.
 * Binds findings to one obligation + mandate version/digest.
 *
 * `toolObligationId` identifies the ReviewObligation this attestation is
 * bound to. All reviewable flows (/plan, /architecture, /implement,
 * /review) create a ReviewObligation before subagent invocation, so the
 * UUID is always available.
 * validateStrictAttestation (review-assurance.ts) and plugin-orchestrator.ts
 * compare this field against the expected obligationId.
 */
export const ReviewAttestation = z
  .object({
    mandateDigest: z.string().min(1),
    criteriaVersion: z.string().min(1),
    toolObligationId: z.string().uuid(),
    iteration: z.number().int().nonnegative(),
    planVersion: z.number().int().positive(),
    reviewedBy: z.literal(REVIEWER_SUBAGENT_TYPE),
  })
  .readonly();
export type ReviewAttestation = z.infer<typeof ReviewAttestation>;

/**
 * Structured findings from an independent review.
 * Enables read-only subagent review without direct state/file writes.
 *
 * Provenance authority contract (F8):
 * `reviewedAt` and `reviewedBy` are host-authoritative fields. In host-task
 * capture mode the host overwrites them at binding time with the real
 * invocation timestamp and resolved child-session identity (see
 * normalizeHostTaskFindings in evidence-binding.ts). A model MUST NOT be
 * treated as an authority for the review execution time or reviewer identity.
 * The reviewer's own (untrusted) claims are preserved separately in
 * `reviewerClaimedAt` / `reviewerClaimedBy` for diagnostics only; they never
 * override the host-stamped canonical values.
 */
export const ReviewFindings = z
  .object({
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
    /**
     * Untrusted reviewer-claimed execution time, retained for diagnostics only.
     * Populated by the host from the model's original `reviewedAt` when that
     * value is overwritten with the host-authoritative timestamp. Never audit
     * authority. (F8)
     */
    reviewerClaimedAt: z.string().optional(),
    /**
     * Untrusted reviewer-claimed identity, retained for diagnostics only.
     * Populated by the host from the model's original `reviewedBy` when that
     * value is overwritten with the resolved child-session identity. Never
     * audit authority. (F8)
     */
    reviewerClaimedBy: ReviewActorInfo.optional(),
    attestation: ReviewAttestation.optional(),
    /** Optional for findings persisted before challenge capture was introduced. */
    challenges: z.array(ReviewChallenge).optional(),
    /** Reviewer-only verdicts for prior implementation challenge resolutions. */
    challengeResolutionVerdicts: z.array(ChallengeResolutionVerdict).optional(),
  })
  .readonly();
export type ReviewFindings = z.infer<typeof ReviewFindings>;

// ─── Review Obligations and Invocation Evidence ────────────────────────────────

/**
 * Mandatory review coverage profile frozen into an obligation.
 *
 * Mirrors the canonical `ReviewProfile` in src/config/policy-types.ts. It is
 * duplicated as a Zod enum here (not imported) because the state layer must not
 * import from the config layer (see module-boundary rules). The two definitions
 * are kept in lockstep by review-profile-parity tests.
 *
 * - 'core' — the mandatory, non-optional baseline (never 'off').
 * - 'full' — reserved for Wave 2 (#730); never auto-selected in this wave.
 */
export const ReviewProfile = z.enum(['core', 'full']);
export type ReviewProfile = z.infer<typeof ReviewProfile>;

/**
 * Provenance of the frozen review profile. Forward-compatible: Wave 2 (#730)
 * extends this with 'runtime_required_full', 'explicit_full_request', and
 * 'inherited_plan_full'. In the current wave only 'policy_default' is produced.
 */
export const ReviewProfileSource = z.enum([
  'policy_default',
  'runtime_required_full',
  'explicit_full_request',
  'inherited_plan_full',
]);
export type ReviewProfileSource = z.infer<typeof ReviewProfileSource>;
export const ReviewInputFingerprintVersion = z.enum(['v1', 'v2']);
export type ReviewInputFingerprintVersion = z.infer<typeof ReviewInputFingerprintVersion>;

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
  /**
   * Mandatory review coverage profile frozen at obligation creation, before any
   * reviewer invocation. Optional for backward compatibility with obligations
   * persisted before this field existed; consumers treat a missing value as the
   * fail-closed 'core' baseline.
   */
  reviewProfile: ReviewProfile.optional(),
  /** Provenance of the frozen review profile (see ReviewProfileSource). */
  profileSource: ReviewProfileSource.optional(),
  /** Challenge coverage frozen from the runtime-computed minimum task class. */
  requiredChallengeCount: z.number().int().min(0).max(2).optional(),
  /** The sole challenge evidence kind required for this obligation. */
  requiredChallengeKind: z
    .enum(['design_challenge', 'implementation_challenge', 'content_challenge'])
    .optional(),
  challengePolicyVersion: z.literal('challenge-policy.v1').optional(),
  /**
   * Digest of the subject artifact (plan, implementation, or reviewed content)
   * frozen at obligation creation. This is the host-authoritative identity of
   * what must be reviewed — never supplied by or echoed from the reviewer.
   * Used at binding time to prevent cross-artifact evidence attachment.
   *
   * NOTE: `ReviewAttempt.subjectDigest` is REQUIRED and binding compares the two
   * for equality, so an obligation without a subject digest can never bind.
   * Required here as well, so the compiler — not a runtime bind failure —
   * surfaces any site that forgets to freeze the subject.
   */
  subjectDigest: z.string().min(1),
  /** Missing means the legacy v1 fingerprint algorithm. */
  fingerprintVersion: ReviewInputFingerprintVersion.optional(),
  /**
   * Ordered attempt IDs associated with this obligation.
   * Each reviewer Task invocation creates a new attempt; the latest attempt at
   * the highest ordinal is the authoritative one for binding.
   */
  attemptIds: z.array(z.string().uuid()).optional(),
  /** Optional metadata, e.g. input fingerprint for standalone /review obligations. */
  metadata: z.record(z.string(), z.unknown()).optional(),
  /**
   * Frozen file scope for this obligation.
   *
   * `kind: 'files'`     — concrete set of file paths the reviewer was issued.
   * `kind: 'not_applicable'` — review context has no file scope (ADR, plan text,
   *    architecture section).
   * `kind: 'unavailable'` — scope could not be resolved for a file-backed review.
   *
   * Absence of the field (legacy obligations persisted before this type) is
   * treated as `unavailable`; consumers fail closed.
   */
  reviewedFileScope: z
    .discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('files'),
          paths: z.array(z.string().min(1)).readonly(),
        })
        .readonly(),
      z
        .object({
          kind: z.literal('not_applicable'),
          reason: z.string().min(1),
        })
        .readonly(),
      z
        .object({
          kind: z.literal('unavailable'),
          reason: z.string().min(1),
        })
        .readonly(),
    ])
    .optional(),
});
export type ReviewObligation = z.infer<typeof ReviewObligation>;

/** P35 strict invocation evidence record. */
export const ReviewInvocationEvidence = z
  .object({
    invocationId: z.string().uuid(),
    obligationId: z.string().uuid(),
    obligationType: ReviewObligationType,
    parentSessionId: z.string().min(1),
    childSessionId: z.string().min(1),
    agentType: z.literal(REVIEWER_SUBAGENT_TYPE),
    /** Persisted attempt identity. Populated at binding time from the host-authoritative
     *  attempt. Optional for legacy records; absent lineage MUST be treated as a hard
     *  blocker (attempt_lineage_unavailable) by any status-mutating path. */
    attemptId: z.string().uuid().optional(),
    /** How the reviewer was invoked: host-visible Task tool, SDK, manual attested, or
     *  manual attested corroborated by a FlowGuard-captured host hook (native_subagent_attested). */
    invocationMode: z.enum([
      'host_subagent_task',
      'sdk_session_prompt',
      'manual_attested',
      'native_subagent_attested',
    ]),
    /** Whether this invocation produced a host-visible child session in the OpenCode GUI. */
    hostVisible: z.boolean(),
    promptHash: z.string().min(1),
    mandateDigest: z.string().min(1),
    criteriaVersion: z.string().min(1),
    findingsHash: z.string().min(1),
    invokedAt: z.string().datetime(),
    fulfilledAt: z.string().datetime().nullable(),
    consumedByObligationId: z.string().uuid().nullable(),
    /** Captured verdict from the reviewer's actual output (host-task authoritative). */
    capturedVerdict: z.string().optional(),
    /** Complete raw findings captured by the plugin from the reviewer's output (host-task only).
     *  Enables evidence-based findings resolution: the tool reads findings directly from
     *  invocation evidence, eliminating agent-side reconstruction of the ReviewFindings object. */
    capturedRawFindings: z.record(z.string(), z.unknown()).optional(),
    /** Evidence source: host-orchestrated or agent-submitted-attested. */
    source: z.enum(['host-orchestrated', 'agent-submitted-attested']).optional(),
    /** Reviewer output transport used to obtain the findings. */
    reviewOutputMode: z.enum(['structured_output', 'text_compat']).default('structured_output'),
    /** True only when OpenCode SDK structured_output was present and used. */
    structuredOutputUsed: z.boolean().default(true),
    /** Review-output assurance tier, distinct from actor identity assurance.
     *  - structured_high: reviewer output parsed as clean, schema-conforming JSON.
     *  - structured_recovered: findings recovered from an embedded/brace-balanced
     *    JSON block in mixed model output; extraction succeeded but the response
     *    was not a clean structured payload, so provenance confidence is reduced. (F8)
     *  - text_compat_lower: text-compatibility extraction path. */
    reviewAssuranceLevel: z
      .enum(['structured_high', 'structured_recovered', 'text_compat_lower'])
      .default('structured_high'),
    /** JSON extraction strategy used for text compatibility mode only. */
    extractionMethod: z.enum(['direct_json', 'json_fence', 'outermost_braces']).optional(),
    /** Original model capability error that caused text compatibility mode. */
    modelCapabilityError: z.string().optional(),
    /** Host-captured corroboration (native_subagent_attested only).
     *  Populated from a FlowGuard hook (SubagentStop / PostToolUse) that fired inside the
     *  reviewer subagent. These fields are the independent host witness that the review tool
     *  was invoked from within a genuine `flowguard-reviewer` subagent, not the main thread. */
    hostCapturedAgentId: z.string().min(1).optional(),
    hostCapturedAgentType: z.literal(REVIEWER_SUBAGENT_TYPE).optional(),
    hostCaptureSource: z.enum(['subagent_stop_hook', 'post_tool_use_hook']).optional(),
    /** Resolved full head commit SHA (branch reviews only). */
    resolvedBranchSha: z
      .string()
      .regex(/^[0-9a-f]{40,64}$/i)
      .nullable()
      .optional(),
    /** Resolved full base commit SHA (branch reviews only). */
    resolvedBaseSha: z
      .string()
      .regex(/^[0-9a-f]{40,64}$/i)
      .nullable()
      .optional(),
    /** SHA-256 digest of the extracted/reviewed content (branch reviews only). */
    reviewedContentDigest: z
      .string()
      .regex(/^[0-9a-f]{64}$/i)
      .nullable()
      .optional(),
  })
  .readonly();
export type ReviewInvocationEvidence = z.infer<typeof ReviewInvocationEvidence>;

/**
 * Persistent strict review assurance state.
 *
 * `attempts` is REQUIRED, not optional. Binding resolves a callback against a
 * pre-recorded invocation attempt, so an assurance state without an attempts
 * array would make every obligation permanently unbindable while looking valid.
 * Requiring the array makes that state unrepresentable and fails fast at the
 * schema boundary instead of silently at binding time.
 */
export const ReviewAssuranceState = z
  .object({
    obligations: z.array(ReviewObligation),
    invocations: z.array(ReviewInvocationEvidence),
    attempts: z.array(ReviewAttempt),
  })
  .readonly();
export type ReviewAssuranceState = z.infer<typeof ReviewAssuranceState>;

// ─── Review Decision ──────────────────────────────────────────────────────────

/**
 * Human review decision at a User Gate (PLAN_REVIEW, EVIDENCE_REVIEW, or ARCH_REVIEW).
 *
 * P30: Includes structured decisionIdentity for regulated approval attribution.
 * The decidedBy field remains for backward compatibility; decisionIdentity
 * provides full provenance for audit and four-eyes proof.
 */
export const ReviewDecision = z
  .object({
    verdict: ReviewVerdict,
    rationale: z.string(),
    decidedAt: z.string().datetime(),
    decidedBy: z.string().min(1),
    decisionIdentity: DecisionIdentity.optional(),
  })
  .readonly();
export type ReviewDecision = z.infer<typeof ReviewDecision>;

// ─── Review Report (Standalone Compliance Artifact) ────────────────────────────

/**
 * Standalone review report — written as a separate file, NOT embedded in state.
 * Own schema version for independent evolution.
 * Generated by /review (read-only, always available).
 *
 * Includes the evidence completeness matrix as a canonical field.
 * The ExtendedReviewReport interface is removed in PR-C; completeness lives in the base schema.
 */
export const ReviewReport = z.object({
  kind: z.never().optional(),
  schemaVersion: z.literal(REVIEW_REPORT_SCHEMA_ID),
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
      location: z.string().optional(),
    }),
  ),
  overallStatus: z.enum(['clean', 'warnings', 'issues']),
  completeness: CompletenessReportSchema,
  inputOrigin: InputOriginSchema.optional(),
  references: z.array(ExternalReferenceSchema).optional(),
});
export type ReviewReport = z.infer<typeof ReviewReport>;
