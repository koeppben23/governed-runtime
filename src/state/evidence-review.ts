/**
 * @module evidence-review
 * @description Review findings, obligations, invocation evidence, assurance,
 *              completeness report, review decision, and peer review report schemas.
 *
 * @version v1
 */

import { z } from 'zod';
import { canonicalJsonStringify } from '../shared/canonical-json.js';
import { hashText } from '../shared/hashing.js';
import { REVIEW_REPORT_SCHEMA_ID } from './evidence-identifiers.js';
import { REVIEWER_SUBAGENT_TYPE } from '../shared/flowguard-identifiers.js';
import { RepositoryEvidenceFreeze } from './evidence-review-freeze.js';
import { ActorAssuranceSchema } from '../shared/actor-assurance.js';
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
import { PeerReviewCoverage } from './peer-review.js';
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
  refineAssuranceIdentityUniqueness,
  refineAssuranceInvocationLinkageCoherence,
  refineAssuranceProvenanceCoherence,
  refineAuthorityStructure,
  refineObligationRepositoryAuthorityCoherence,
  refineRepositoryEvidenceFreezeCoherence,
  refineReviewMaterialSubject,
  refinePeerReviewSubject,
} from './evidence-review-refinements.js';
import { refineReviewCycleCoherence } from './review-cycles.js';
import {
  refineAssuranceAttemptLineageCoherence,
  refineAssuranceDispatchCoherence,
  refineAssuranceInvocationDispatchLinkage,
} from './evidence-review-ledger-refinements.js';
export { classifyRepositoryPath, type RepositoryPathClassification } from './repository-path.js';

export const ReviewAttemptStatusValues = [
  'created',
  'rejected',
  'bound',
  'stale',
  'expired',
] as const;

const ReviewAttemptStatus = z.enum(ReviewAttemptStatusValues);
type ReviewAttemptStatus = z.infer<typeof ReviewAttemptStatus>;

export {
  RepositoryDiscoverySnapshot,
  ReviewAttemptDiscoveryContext,
} from './evidence-review-attempt-discovery.js';
import { ReviewAttemptDiscoveryContext } from './evidence-review-attempt-discovery.js';

/**
 * Canonical rejection classification persisted on a rejected review attempt.
 *
 * These reasons name structural reviewer-evidence failures; none of them
 * authorizes a repair reissue. A rejected attempt is terminal: the obligation
 * settles through the continuation authority, never through a fresh attempt on
 * the same obligation.
 */
export const ReviewAttemptRejectionReason = z.enum([
  'schema_invalid',
  'attestation_invalid',
  'relation_invalid',
  'scope_invalid',
  'evidence_unavailable',
  'material_integrity_failed',
  'subject_mismatch',
  'consistency_invalid',
  'reviewer_unavailable',
]);
export type ReviewAttemptRejectionReason = z.infer<typeof ReviewAttemptRejectionReason>;

/**
 * Authority-bearing origin of a review attempt.
 *
 * Every attempt carries exactly one origin. `initial` marks the first attempt
 * minted with its obligation. `dispatch_rearm` marks a transport-neutral
 * dispatch-recovery re-arm: the predecessor attempt was durably released to
 * the host without producing bindable evidence, so the originating command
 * re-arms a fresh append-only attempt on the SAME obligation. Every re-arm
 * draws on the shared frozen reviewer-attempt budget.
 *
 * Invariant: no non-initial attempt exists without an explicit origin.
 */
export const ReviewAttemptOrigin = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('initial') }).readonly(),
  z
    .object({
      kind: z.literal('dispatch_rearm'),
      predecessorAttemptId: z.string().uuid(),
      triggerReason: z.enum(['interrupted', 'spent']),
    })
    .readonly(),
]);
export type ReviewAttemptOrigin = z.infer<typeof ReviewAttemptOrigin>;

export const ReviewMaterial = z
  .object({
    content: z.string(),
    materialDigest: z.string().min(1),
    subjectDigest: z.string().min(1),
  })
  .strict()
  .readonly();
export type ReviewMaterial = z.infer<typeof ReviewMaterial>;

export const ReviewAttempt = z
  .object({
    attemptId: z.string().uuid(),
    obligationId: z.string().uuid(),
    obligationType: ReviewObligationType,
    subjectDigest: z.string().min(1),
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
     * point; a rejected attempt is terminal and never authorizes a reissue.
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
     * sanctioned observation tool as routing only. Required for repository-
     * governed attempts and forbidden otherwise; the assurance boundary
     * enforces both directions.
     */
    observationCapability: ObservationCapability.optional(),
    /**
     * Authoritative, attempt-bound repository observations. Minted EXCLUSIVELY
     * by the parent replay after the reviewer child session is known; child-side
     * captures never become entries here directly. REQUIRED: attempts without
     * observations carry `[]`, never an absent field.
     */
    observations: z.array(RepositoryObservation).readonly(),
    createdAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
  })
  .strict()
  .readonly();
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
  decisionIdentity: DecisionIdentity.nullable(),
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
    actorAssurance: ActorAssuranceSchema.optional(),
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
export const ReviewFindingsObject = z
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
    /** Review challenges. REQUIRED: `[]` is the canonical "no challenges" form. */
    challenges: z.array(ReviewChallenge),
    /** Reviewer-only verdicts for prior implementation challenge resolutions. */
    challengeResolutionVerdicts: z.array(ChallengeResolutionVerdict).optional(),
  })
  .strict();
export const ReviewFindings = ReviewFindingsObject.readonly();
export type ReviewFindings = z.infer<typeof ReviewFindings>;

export function reviewFindingsDigests(findings: ReviewFindings | undefined): {
  findingsDigest: string | null;
  attestationDigest: string | null;
} {
  if (!findings) return { findingsDigest: null, attestationDigest: null };
  return {
    findingsDigest: hashText(canonicalJsonStringify(findings)),
    attestationDigest: findings.attestation
      ? hashText(canonicalJsonStringify(findings.attestation))
      : null,
  };
}

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
export const ReviewInputFingerprintVersion = z.literal('v2');
export type ReviewInputFingerprintVersion = z.infer<typeof ReviewInputFingerprintVersion>;

/** Human review-cycle identity; canonical schema and invariants live in `review-cycles.ts`. */
export { ReviewCycles } from './review-cycles.js';
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
    /**
     * Human-cycle identity of this obligation. The value is the owning loop's
     * active `ReviewCycles` counter at mint time:
     *
     * - peer review (`obligationType === 'review'`) → `null`: it has exactly
     *   one pass and no human convergence cycle.
     * - plan/architecture/implement → a positive integer. A human
     *   `changes_requested` decision at the owning gate starts a new cycle and
     *   restarts `iteration` at 1; `reviewCycle` is what keeps cycle N
     *   iteration 1 distinguishable from cycle N+1 iteration 1 in persisted
     *   evidence and audit.
     *
     * REQUIRED and never defaulted: absence is not a legal current shape.
     */
    reviewCycle: z.number().int().positive().nullable(),
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
     * reviewer invocation. The mint always materializes it (fail-closed 'core'
     * baseline without an explicit request), so absence is not a legal shape.
     */
    reviewProfile: ReviewProfile,
    /** Provenance of the frozen review profile (see ReviewProfileSource). */
    profileSource: ReviewProfileSource,
    /** Challenge coverage frozen from the runtime-computed minimum task class. REQUIRED — 0 is the explicit TRIVIAL value, never an implicit no-policy state. */
    requiredChallengeCount: z.number().int().min(0).max(2),
    /** The sole challenge evidence kind required for this obligation. */
    requiredChallengeKind: z.enum([
      'design_challenge',
      'implementation_challenge',
      'content_challenge',
    ]),
    challengePolicyVersion: z.literal('challenge-policy.v1'),
    /**
     * Digest of the subject artifact (plan, implementation, or reviewed content)
     * frozen at obligation creation. This is the host-authoritative identity of
     * what must be reviewed — never supplied by or echoed from the reviewer.
     * Used at binding time to prevent cross-artifact evidence attachment.
     * NOTE: `ReviewAttempt.subjectDigest` is REQUIRED, so an obligation without
     * a subject digest can never bind — the compiler, not a runtime bind
     * failure, surfaces any site that forgets to freeze the subject.
     */
    subjectDigest: z.string().min(1),
    /** Exact plan-claim declaration digest frozen before reviewer invocation. */
    claimDeclarationsDigest: z.string().min(1).optional(),
    /** Frozen reviewed bytes. REQUIRED: every current obligation carries its material. */
    reviewMaterial: ReviewMaterial,
    reviewSubject: FrozenReviewSubject.optional(),
    /**
     * Input-fingerprint generation. `v2` for peer review obligations;
     * absent for artifact flows (plan/architecture/implement) that do not
     * participate in input-fingerprint matching.
     */
    fingerprintVersion: ReviewInputFingerprintVersion.optional(),
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
     * snapshot of mutable runtime state. Absent for obligations whose flow
     * carried no frozen repository authority (e.g. an unavailable freeze).
     */
    repositoryAuthority: FrozenRepositoryAuthority.optional(),
    /** Durable plan/architecture repository-context freeze outcome (see {@link RepositoryEvidenceFreeze}); plan/architecture obligations MUST carry it — continuations, restarts, re-emits, archives, and forensics render the exact degradation cause. */
    repositoryEvidenceFreeze: RepositoryEvidenceFreeze.optional(),
    maxReviewerAttempts: z.number().int().min(0).max(5),
  })
  .strict()
  .superRefine(refinePeerReviewSubject)
  .superRefine(refineReviewMaterialSubject)
  .superRefine(refineReviewCycleCoherence)
  .superRefine(refineAuthorityStructure)
  .superRefine(refineObligationRepositoryAuthorityCoherence)
  .superRefine(refineRepositoryEvidenceFreezeCoherence);
export type ReviewObligation = z.infer<typeof ReviewObligation>;

// `ReviewInvocationEvidence` schema lives in `evidence-review-invocation.ts`;
// imported for the assurance schema and re-exported for the historical surface.
import { ReviewInvocationEvidence } from './evidence-review-invocation.js';
export { ReviewInvocationEvidence } from './evidence-review-invocation.js';

/**
 * Durable reviewer-dispatch ledger entry. Persisted BEFORE the host releases a
 * reviewer Task so a crash between Before and After can never be mistaken for
 * a never-dispatched attempt:
 *
 *   authorized      — dispatch persisted, host Task released, no After yet.
 *                     An attempt with an `authorized` record has unknown
 *                     outcome and must never be re-used as first-dispatch.
 *   completed       — the After consumed the execution record for this call.
 *   outcome_unknown — a re-arm superseded this dispatch; the attempt is
 *                     historical and its late completion can never bind.
 */
export const ReviewDispatchStatus = z.enum(['authorized', 'completed', 'outcome_unknown']);
export type ReviewDispatchStatus = z.infer<typeof ReviewDispatchStatus>;

export const ReviewDispatchRecord = z
  .object({
    dispatchId: z.string().uuid(),
    attemptId: z.string().uuid(),
    obligationId: z.string().uuid(),
    hostCallId: z.string().min(1),
    canonicalPromptDigest: z.string().regex(/^[a-f0-9]{64}$/),
    dispatchAuthorizedAt: z.string().datetime(),
    dispatchStatus: ReviewDispatchStatus,
    completedAt: z.string().datetime().optional(),
  })
  .strict()
  .readonly();
export type ReviewDispatchRecord = z.infer<typeof ReviewDispatchRecord>;

/**
 * Canonical hard-cutover literal for the review-assurance authority generation.
 * Every accepted current-generation `ReviewAssuranceState` MUST carry an
 * explicit durable dispatch ledger (`dispatches`); absence of that ledger is an
 * incompatible state shape, never equivalent to an empty ledger.
 */
export const REVIEW_ASSURANCE_SCHEMA_VERSION = 'review-assurance.v6' as const;

/**
 * Persistent strict review assurance state.
 *
 * `attempts` is REQUIRED, not optional. Binding resolves a callback against a
 * pre-recorded invocation attempt, so an assurance state without an attempts
 * array would make every obligation permanently unbindable while looking valid.
 *
 * `dispatches` is the append-only reviewer-dispatch ledger (see
 * `state/review-dispatch.ts`). It is REQUIRED and authority-bearing: its
 * absence must never be interpreted as "no dispatch occurred", so the field may
 * not be optional and may not default. Every controlled writer explicitly
 * persists it (an empty ledger is `dispatches: []`).
 *
 * `assuranceSchemaVersion` is a REQUIRED hard version literal: v2 introduced
 * authority-bearing attempt origins and frozen reviewer-attempt budgets; v3 bound
 * host-owned repository Discovery snapshots to attempts; v4 introduced frozen
 * repository authority, observation capabilities, and attempt-owned
 * observations; v5 makes observations representation-typed; v6 makes the
 * reviewer-dispatch ledger a required authority. States persisted under older
 * forms MUST fail parsing — there is deliberately no defaulting path for
 * authority-bearing fields, and no read migration across authority-bearing
 * generations. A `review-assurance.v5` state is NOT current, even if it
 * fabricates a `dispatches` field: the generation literal decides.
 *
 * Cross-record invariants: an attempt's `repositoryDiscovery` variant must
 * structurally match its owning obligation's frozen repository authority, and
 * an obligation's canonical linkage must be a COHERENT relation — the linked
 * invocation must back-reference the same obligation id AND type (CE2).
 */
export const ReviewAssuranceState = z
  .object({
    assuranceSchemaVersion: z.literal(REVIEW_ASSURANCE_SCHEMA_VERSION),
    obligations: z.array(ReviewObligation),
    invocations: z.array(ReviewInvocationEvidence),
    attempts: z.array(ReviewAttempt),
    dispatches: z.array(ReviewDispatchRecord),
  })
  .strict()
  .superRefine(refineAssuranceIdentityUniqueness)
  .superRefine(refineAssuranceDiscoveryCoherence)
  .superRefine(refineAssuranceProvenanceCoherence)
  .superRefine(refineAssuranceAttemptLineageCoherence)
  .superRefine(refineAssuranceDispatchCoherence)
  .superRefine(refineAssuranceInvocationLinkageCoherence)
  .superRefine(refineAssuranceInvocationDispatchLinkage)
  .readonly();
export type ReviewAssuranceState = z.infer<typeof ReviewAssuranceState>;

// ─── Review Decision ──────────────────────────────────────────────────────────

/**
 * Human review decision at a User Gate (PLAN_REVIEW, EVIDENCE_REVIEW, or ARCH_REVIEW).
 *
 * P30: `decisionIdentity` is the sole decision attribution authority. It carries
 * the full structured provenance (actor id, email, source, assurance) required
 * for audit and four-eyes proof; there is no separate identity string.
 */
export const ReviewDecision = z
  .object({
    verdict: ReviewVerdict,
    rationale: z.string(),
    decidedAt: z.string().datetime(),
    decisionIdentity: DecisionIdentity,
  })
  .strict()
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

const ReviewReportCommonBase = {
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
  inputOrigin: InputOriginSchema.optional(),
  references: z.array(ExternalReferenceSchema).optional(),
};

const ReviewReportBase = {
  ...ReviewReportCommonBase,
  peerReviewCoverage: PeerReviewCoverage,
};

const LifecycleReviewReport = z
  .object({
    ...ReviewReportBase,
    reviewKind: z.literal('lifecycle_review'),
    findings: z.array(LifecycleReviewReportFinding),
  })
  .strict();

const ContentReviewReport = z
  .object({
    ...ReviewReportBase,
    reviewKind: z.literal('content_review'),
    reviewSubject: FrozenReviewSubject,
    findings: z.array(ReviewReportFinding),
  })
  .strict();

export const ReviewReportDraft = z
  .discriminatedUnion('reviewKind', [
    ContentReviewReport.omit({ peerReviewCoverage: true }),
    LifecycleReviewReport.omit({ peerReviewCoverage: true }),
  ])
  .readonly();
export type ReviewReportDraft = z.infer<typeof ReviewReportDraft>;

export const ReviewReport = z
  .discriminatedUnion('reviewKind', [ContentReviewReport, LifecycleReviewReport])
  .readonly();
export type ReviewReport = z.infer<typeof ReviewReport>;
