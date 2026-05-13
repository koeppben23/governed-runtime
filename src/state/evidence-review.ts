/**
 * @module evidence-review
 * @description Review findings, obligations, invocation evidence, assurance,
 *              completeness report, review decision, and standalone review report schemas.
 *
 * @version v1
 */

import { z } from 'zod';
import { REVIEWER_SUBAGENT_TYPE, REVIEW_REPORT_SCHEMA_ID } from '../shared/flowguard-identifiers.js';
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
import { DecisionIdentity } from './evidence-identity.js';

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
    attestation: ReviewAttestation.optional(),
  })
  .readonly();
export type ReviewFindings = z.infer<typeof ReviewFindings>;

// ─── Review Obligations and Invocation Evidence ────────────────────────────────

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
  /** Optional metadata, e.g. input fingerprint for standalone /review obligations. */
  metadata: z.record(z.string(), z.unknown()).optional(),
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
    /** How the reviewer was invoked: host-visible Task tool, SDK, or manual attested. */
    invocationMode: z.enum(['host_subagent_task', 'sdk_session_prompt', 'manual_attested']),
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
    /** Review-output assurance tier, distinct from actor identity assurance. */
    reviewAssuranceLevel: z
      .enum(['structured_high', 'text_compat_lower'])
      .default('structured_high'),
    /** JSON extraction strategy used for text compatibility mode only. */
    extractionMethod: z.enum(['direct_json', 'json_fence', 'outermost_braces']).optional(),
    /** Original model capability error that caused text compatibility mode. */
    modelCapabilityError: z.string().optional(),
  })
  .readonly();
export type ReviewInvocationEvidence = z.infer<typeof ReviewInvocationEvidence>;

/** Persistent strict review assurance state. */
export const ReviewAssuranceState = z
  .object({
    obligations: z.array(ReviewObligation),
    invocations: z.array(ReviewInvocationEvidence),
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
