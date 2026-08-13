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
  ReviewRepositoryRevisionProvenance as ReviewRepositoryRevisionProvenanceSchema,
  ReviewVerdict,
} from './evidence-primitives.js';
import { DecisionIdentity } from './evidence-identity.js';
import { Finding } from './evidence-findings.js';
import { FrozenReviewSubject, ReviewSubjectScope } from './evidence-review-subject.js';
export {
  ArtifactSectionAnchor,
  ContentSubjectAnchor,
  Finding,
  FindingRelation,
  MarkdownSectionPath,
  RepositoryLocation,
  RepositoryLocationAnchor,
  RepositoryPathSchema,
  ReviewSubjectAnchor,
  SafeReviewUrlMetadata,
} from './evidence-findings.js';
export type { RepositoryPath } from './evidence-findings.js';
export {
  FrozenReviewSubject,
  RepositoryIdentity,
  LocalRepositoryIdentity,
  ReviewRepositoryIdentity,
  ReviewSubjectScope,
} from './evidence-review-subject.js';

export {
  FrozenRepositoryAuthority,
  FrozenRepositoryRevisionTarget,
  MAX_REPOSITORY_OBSERVATION_BYTES,
  ObservationCapability,
  RepositoryObservation,
  RepositoryObservationCapture,
  deriveRepositoryRevisionProvenance,
  hasFrozenRepositoryAuthority,
  resolveFrozenRevisionTarget,
  verifyFrozenRepositoryAuthority,
} from './evidence-review-authority.js';
import {
  FrozenRepositoryAuthority,
  ObservationCapability,
  RepositoryObservation,
} from './evidence-review-authority.js';
import {
  refineAssuranceDiscoveryCoherence,
  refineAssuranceProvenanceCoherence,
  refineAuthorityStructure,
  refineStandaloneSubject,
} from './evidence-review-refinements.js';

export { classifyRepositoryPath, type RepositoryPathClassification } from './repository-path.js';

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

export {
  RepositoryDiscoverySnapshot,
  ReviewAttemptDiscoveryContext,
} from './evidence-review-attempt-discovery.js';
import { ReviewAttemptDiscoveryContext } from './evidence-review-attempt-discovery.js';

/**
 * Canonical rejection classification persisted on a rejected review attempt.
 *
 * `output_*` reasons describe a non-bindable reviewer output whose defect can
 * plausibly be repaired by a fresh independent reviewer attempt against the
 * same frozen subject. Governance/execution reasons describe failures that a
 * new reviewer output cannot legitimately repair. Repairability itself is
 * classified in the enforcement layer (`REVIEW_ATTEMPT_REJECTION_POLICY`);
 * this enum only names the reasons structurally.
 */
export const ReviewAttemptRejectionReason = z.enum([
  'schema_invalid',
  'extraction_invalid',
  'attestation_invalid',
  'relation_invalid',
  'scope_invalid',
  'evidence_unavailable',
  'material_integrity_failed',
  'subject_mismatch',
  'consistency_invalid',
  'reviewer_unavailable',
  'task_failed',
]);
export type ReviewAttemptRejectionReason = z.infer<typeof ReviewAttemptRejectionReason>;

/**
 * Authority-bearing origin of a review attempt.
 *
 * Every attempt carries exactly one origin. `initial` marks the first attempt
 * minted with its obligation. `output_repair` marks a reissue authorized by
 * the obligation-level output-repair policy (see reissue-authority.ts).
 * `task_rearm` marks a re-arm driven by the reviewer Task lifecycle
 * (interruption or spent-attempt retry); it is budgeted by the enforcement
 * retry gate, NOT by the output-repair budget.
 *
 * Invariant: no non-initial attempt exists without an explicit origin.
 */
export const ReviewAttemptOrigin = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('initial') }).readonly(),
  z
    .object({
      kind: z.literal('output_repair'),
      predecessorAttemptId: z.string().uuid(),
      triggerReason: ReviewAttemptRejectionReason,
    })
    .readonly(),
  z
    .object({
      kind: z.literal('task_rearm'),
      predecessorAttemptId: z.string().uuid(),
      triggerReason: z.enum(['interrupted', 'rejected', 'stale', 'expired']),
    })
    .readonly(),
]);
export type ReviewAttemptOrigin = z.infer<typeof ReviewAttemptOrigin>;

/** Immutable normalized bytes delivered to a standalone review attempt. */
export const ReviewMaterial = z
  .object({
    content: z.string(),
    materialDigest: z.string().min(1),
  })
  .strict()
  .readonly();
export type ReviewMaterial = z.infer<typeof ReviewMaterial>;

export const ReviewAttempt = z.object({
  attemptId: z.string().uuid(),
  obligationId: z.string().uuid(),
  obligationType: ReviewObligationType,
  subjectDigest: z.string().min(1),
  /** Immutable material supplied to the reviewer for standalone content reviews. */
  reviewMaterial: ReviewMaterial.optional(),
  ordinal: z.number().int().nonnegative(),
  childSessionId: z.string().optional(),
  status: ReviewAttemptStatus,
  /**
   * Authority-bearing origin. REQUIRED: every attempt names how it came into
   * existence; attempts without an origin cannot be parsed.
   */
  origin: ReviewAttemptOrigin,
  /**
   * Structured reason for a `rejected` status. Persisted at the rejection
   * point; the output-repair gate refuses reissues without an explicit,
   * canonically repairable reason.
   */
  rejectionReason: ReviewAttemptRejectionReason.optional(),
  /**
   * Attempt-bound repository Discovery context, resolved BEFORE the attempt is
   * minted. REQUIRED: `repository` for standalone repository reviews,
   * `not_applicable` otherwise.
   */
  repositoryDiscovery: ReviewAttemptDiscoveryContext,
  /**
   * Opaque host-minted observation capability bound to exactly this attempt.
   * Transported to the reviewer via the canonical prompt; echoed by the
   * sanctioned observation tool as routing only. Optional for attempts
   * persisted before the frozen-repository-authority generation.
   */
  observationCapability: ObservationCapability.optional(),
  /**
   * Authoritative, attempt-bound repository observations. Minted EXCLUSIVELY
   * by the parent replay after the reviewer child session is known; child-side
   * captures never become entries here directly. Optional for attempts
   * persisted before the frozen-repository-authority generation.
   */
  observations: z.array(RepositoryObservation).readonly().optional(),
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

export {
  PlanAdrSectionRef,
  ImplementationRef,
  ValidationAttemptRef,
  ContentRef,
  ReviewChallengeEvidenceRef,
  ChallengeClientReference,
  REVIEW_CHALLENGE_OUTCOMES,
  ReviewChallenge,
  ReviewerChallengeInput,
  ChallengeResolution,
  ChallengeResolutionVerdict,
} from './evidence-review-challenge.js';
import { ReviewChallenge, ChallengeResolutionVerdict } from './evidence-review-challenge.js';

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
  .strict()
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
  .strict()
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
  .strict()
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

export { ReviewRepositoryRevisionProvenance } from './evidence-primitives.js';

/**
 * P35 strict obligation record.
 * Exactly one independent review invocation must fulfill each obligation.
 */
export const ReviewObligation = z
  .object({
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
    /** Present for standalone content reviews and authoritative for their attempts. */
    reviewSubject: FrozenReviewSubject.optional(),
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
    /** Frozen subject coverage. A review without a subject is not bindable. */
    reviewSubjectScope: ReviewSubjectScope,
    repositoryRevisionProvenance: ReviewRepositoryRevisionProvenanceSchema.optional(),
    /**
     * Frozen repository authority for repository-governed obligations.
     *
     * `candidate_pair` — implementation reviews (pre-mutation frozen base +
     * content-addressed worktree candidate head).
     * `context` — plan/architecture reviews (single frozen repository context;
     * only `revision:'head'` resolves against it).
     *
     * Absence means the obligation has NO repository evidence authority;
     * repository evidence must surface as `evidence_unavailable`, never as a
     * snapshot of mutable runtime state. Optional for obligations persisted
     * before the frozen-repository-authority generation.
     */
    repositoryAuthority: FrozenRepositoryAuthority.optional(),
    /**
     * Obligation-level output-repair budget, frozen from the resolved policy
     * snapshot at obligation creation. Counts `output_repair` attempts only;
     * task-lifecycle re-arms are budgeted by the enforcement retry gate.
     * Required: reissue authorization reads this frozen value — never the
     * live config — so a later policy change cannot re-open a settled
     * obligation's repair window.
     */
    maxReviewerOutputRepairAttempts: z.number().int().min(0).max(5),
  })
  .superRefine(refineStandaloneSubject)
  .superRefine(refineAuthorityStructure);
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
 *
 * `assuranceSchemaVersion` is a REQUIRED hard version literal. The
 * `review-assurance.v2` form introduced authority-bearing attempt origins and
 * frozen output-repair budgets. The `review-assurance.v4` form additionally
 * binds a host-owned repository Discovery snapshot to every attempt at mint
 * time. The `review-assurance.v4` form introduces frozen repository authority
 * (`ReviewObligation.repositoryAuthority`), opaque attempt-bound observation
 * capabilities, and attempt-owned authoritative observations. States persisted
 * under older forms MUST fail parsing — there is deliberately no defaulting
 * path for authority-bearing fields. The single sanctioned transition is the
 * shape-only v3→v4 read migration in the persistence adapter, which adds NO
 * authority information that was not already present.
 *
 * Cross-record invariant: an attempt's `repositoryDiscovery` variant must
 * structurally match its owning obligation's frozen repository authority. A
 * repository-governed obligation with a `not_applicable` attempt — or a
 * non-repository-governed obligation with a `repository` snapshot attempt — is
 * an invalid state, not a prompt-rendering concern.
 */
export const ReviewAssuranceState = z
  .object({
    assuranceSchemaVersion: z.literal('review-assurance.v4'),
    obligations: z.array(ReviewObligation),
    invocations: z.array(ReviewInvocationEvidence),
    attempts: z.array(ReviewAttempt),
  })
  .superRefine(refineAssuranceDiscoveryCoherence)
  .superRefine(refineAssuranceProvenanceCoherence)
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

export const ReviewReportSeverity = z.enum(['info', 'warning', 'error']);
export type ReviewReportSeverity = z.infer<typeof ReviewReportSeverity>;

const MaterialReviewReportFinding = z
  .object({
    source: z.literal('material_finding'),
    reportSeverity: ReviewReportSeverity,
    finding: Finding,
  })
  .strict()
  .readonly();

const MechanicalReviewReportFinding = z
  .object({
    source: z.literal('mechanical'),
    reportSeverity: ReviewReportSeverity,
    category: z.string(),
    message: z.string(),
  })
  .strict()
  .readonly();

const MissingVerificationReviewReportFinding = z
  .object({
    source: z.literal('missing_verification'),
    reportSeverity: ReviewReportSeverity,
    category: z.string(),
    message: z.string(),
  })
  .strict()
  .readonly();

const ScopeCreepReviewReportFinding = z
  .object({
    source: z.literal('scope_creep'),
    reportSeverity: ReviewReportSeverity,
    category: z.string(),
    message: z.string(),
  })
  .strict()
  .readonly();

const UnknownReviewReportFinding = z
  .object({
    source: z.literal('unknown'),
    reportSeverity: ReviewReportSeverity,
    category: z.string(),
    message: z.string(),
  })
  .strict()
  .readonly();

const ChallengeReviewReportFinding = z
  .object({
    source: z.literal('challenge'),
    reportSeverity: ReviewReportSeverity,
    category: z.string(),
    message: z.string(),
    location: z.string().optional(),
  })
  .strict()
  .readonly();

export const ReviewReportFinding = z
  .discriminatedUnion('source', [
    MaterialReviewReportFinding,
    MechanicalReviewReportFinding,
    MissingVerificationReviewReportFinding,
    ScopeCreepReviewReportFinding,
    UnknownReviewReportFinding,
    ChallengeReviewReportFinding,
  ])
  .readonly();
export type ReviewReportFinding = z.infer<typeof ReviewReportFinding>;

const LifecycleReviewReportFinding = z
  .discriminatedUnion('source', [
    MechanicalReviewReportFinding,
    MissingVerificationReviewReportFinding,
    ScopeCreepReviewReportFinding,
    UnknownReviewReportFinding,
    ChallengeReviewReportFinding,
  ])
  .readonly();

const ReviewReportBase = {
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
  overallStatus: z.enum(['clean', 'warnings', 'issues']),
  completeness: CompletenessReportSchema,
  inputOrigin: InputOriginSchema.optional(),
  references: z.array(ExternalReferenceSchema).optional(),
};

const LifecycleReviewReport = z
  .object({
    ...ReviewReportBase,
    reviewKind: z.literal('lifecycle_review'),
    findings: z.array(LifecycleReviewReportFinding),
  })
  .strict()
  .readonly();

const ContentReviewReport = z
  .object({
    ...ReviewReportBase,
    reviewKind: z.literal('content_review'),
    reviewSubject: FrozenReviewSubject,
    findings: z.array(ReviewReportFinding),
  })
  .strict()
  .readonly();

export const ReviewReport = z
  .discriminatedUnion('reviewKind', [ContentReviewReport, LifecycleReviewReport])
  .readonly();
export type ReviewReport = z.infer<typeof ReviewReport>;
