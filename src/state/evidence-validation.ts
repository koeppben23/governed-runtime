/**
 * @module evidence-validation
 * @description Validation check result schema for the VALIDATION phase.
 *
 * v2: Execution-evidence-based validation. FlowGuard executes commands directly
 * and records cryptographic evidence (outputDigest, exitCode, executionMs).
 * Agent self-report is no longer accepted — only runtime execution evidence.
 *
 * @version v2
 */

import { z } from 'zod';
import { CheckId } from './evidence-primitives.js';
import {
  FullCheckScopeAttestationSchema,
  VerificationCandidateKindSchema,
} from './discovery-schemas.js';
import { ReportFormatId } from './discovery-schemas.js';
import { ProviderId, AssertionIdentity } from './assertion-identity.js';

export const RepairGuidanceCategory = z.enum([
  'typecheck',
  'lint',
  'test',
  'build',
  'format',
  'security',
  'coverage',
  'timeout',
]);
export type RepairGuidanceCategory = z.infer<typeof RepairGuidanceCategory>;

export const RepairGuidanceConfidence = z.enum(['high', 'medium', 'low']);
export type RepairGuidanceConfidence = z.infer<typeof RepairGuidanceConfidence>;

export const RepairGuidanceEvidenceExcerpt = z
  .object({
    stream: z.enum(['stdout', 'stderr']),
    excerpt: z.string().min(1),
  })
  .readonly();
export type RepairGuidanceEvidenceExcerpt = z.infer<typeof RepairGuidanceEvidenceExcerpt>;

export const RepairGuidanceLocation = z
  .object({
    file: z.string().min(1).nullable(),
    line: z.number().int().positive().nullable(),
    column: z.number().int().positive().nullable(),
  })
  .readonly();
export type RepairGuidanceLocation = z.infer<typeof RepairGuidanceLocation>;

export const RepairGuidance = z.discriminatedUnion('status', [
  z
    .object({
      kind: z.literal('derived_repair_guidance'),
      advisory: z.literal(true),
      source: z.literal('run_check_output'),
      status: z.literal('available'),
      category: RepairGuidanceCategory,
      confidence: RepairGuidanceConfidence,
      affectedLocations: z.array(RepairGuidanceLocation),
      evidence: z.array(RepairGuidanceEvidenceExcerpt),
      recommendedNextActions: z.array(z.string().min(1)),
      notVerified: z.array(z.string().min(1)),
    })
    .readonly(),
  z
    .object({
      kind: z.literal('derived_repair_guidance'),
      advisory: z.literal(true),
      source: z.literal('run_check_output'),
      status: z.literal('unavailable'),
      reason: z.enum(['passed', 'unparseable', 'insufficient_confidence']),
      evidence: z.array(RepairGuidanceEvidenceExcerpt),
      recommendedNextActions: z.array(z.string().min(1)),
      notVerified: z.array(z.string().min(1)),
    })
    .readonly(),
]);
export type RepairGuidance = z.infer<typeof RepairGuidance>;

/**
 * Result of a single validation check — produced by flowguard_run_check execution.
 *
 * Cryptographic evidence binding:
 * - outputDigest = sha256(stdout + stderr) computed at execution time
 * - exitCode = actual process exit code (0 = passed)
 * - executionMs = wall-clock duration
 * - startedAt = ISO timestamp when execution began
 *
 * No agent self-report: all fields are runtime-produced, not agent-supplied.
 */

export const ValidationOutcome = z.enum(['supported', 'inconclusive', 'blocked']);
export type ValidationOutcome = z.infer<typeof ValidationOutcome>;

// ─── Structured Assertion Evidence ───────────────────────────────────────────

export { ProviderId };

export const StructuredAssertionEvidence = z
  .object({
    /** Structured provider-scoped assertion identity. */
    assertion: AssertionIdentity,
    /** Provider that produced this assertion evidence. */
    providerId: ProviderId,
    /** Assertion-level status */
    status: z.enum(['passed', 'failed', 'errored', 'skipped']),
    /** Suite or package name */
    suiteName: z.string().min(1).optional(),
    /** Human-readable test name */
    testName: z.string().min(1),
    /** Workspace-relative source file */
    sourceFile: z.string().min(1).optional(),
    /** Duration in milliseconds */
    durationMs: z.number().nonnegative().optional(),
    /** Failure details (only for status='failed'; forbidden otherwise) */
    failure: z
      .object({
        type: z.string().optional(),
        message: z.string().optional(),
        detailDigest: z.string().min(1).optional(),
      })
      .optional(),
  })
  .strict()
  .refine(
    (data) => data.status === 'failed' || data.status === 'errored' || data.failure === undefined,
    {
      message: 'failure details only allowed when status is failed or errored',
    },
  )
  .refine((data) => data.providerId === data.assertion.providerId, {
    message: 'providerId must match assertion.providerId',
  })
  .readonly();
export type StructuredAssertionEvidence = z.infer<typeof StructuredAssertionEvidence>;

export const AssertionExtractionSummary = z.object({
  assertionCount: z.number().int().nonnegative(),
  passedCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  erroredCount: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
  suiteInfrastructureError: z.boolean(),
});
export type AssertionExtractionSummary = z.infer<typeof AssertionExtractionSummary>;

export const AssertionExtractionReasonCode = z.enum([
  'report_missing',
  'report_empty',
  'report_ambiguous',
  'report_too_large',
  'path_rejected',
  'parse_failed',
  'provider_format_mismatch',
  'binding_format_unsupported',
  'identity_codec_missing',
  'invalid_local_id',
]);
export type AssertionExtractionReasonCode = z.infer<typeof AssertionExtractionReasonCode>;

export const AssertionBindingCapability = z.enum(['assertion', 'aggregate', 'check_only']);
export type AssertionBindingCapability = z.infer<typeof AssertionBindingCapability>;

const ExtractedAssertionResultSchema = z
  .object({
    status: z.literal('extracted'),
    attemptId: z.string().uuid(),
    providerId: ProviderId,
    format: ReportFormatId,
    bindingCapability: AssertionBindingCapability,
    reportDigests: z.array(z.string().min(1)).min(1),
    assertions: z.array(StructuredAssertionEvidence),
    summary: AssertionExtractionSummary,
  })
  .superRefine((data, ctx) => {
    if (data.bindingCapability === 'check_only' && data.assertions.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'check_only binding capability must not carry assertion-level evidence',
        path: ['bindingCapability'],
      });
    }
    if (
      data.bindingCapability === 'aggregate' &&
      (data.summary.suiteInfrastructureError ||
        data.summary.passedCount +
          data.summary.failedCount +
          data.summary.erroredCount +
          data.summary.skippedCount !==
          data.summary.assertionCount)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'aggregate evidence requires a complete provider-attested report summary',
        path: ['summary'],
      });
    }
    for (const [i, a] of data.assertions.entries()) {
      if (a.providerId !== data.providerId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `assertion providerId '${a.providerId}' does not match extraction providerId '${data.providerId}'`,
          path: ['assertions', i, 'providerId'],
        });
      }
    }
  });

export const AssertionExtractionResult = z.discriminatedUnion('status', [
  z.object({ status: z.literal('not_configured') }),
  z.object({
    status: z.literal('blocked'),
    attemptId: z.string().uuid(),
    reasonCode: AssertionExtractionReasonCode,
    reason: z.string().min(1),
  }),
  z.object({
    status: z.literal('inconclusive'),
    attemptId: z.string().uuid(),
    reasonCode: AssertionExtractionReasonCode,
    reason: z.string().min(1),
  }),
  ExtractedAssertionResultSchema,
]);
export type AssertionExtractionResult = z.infer<typeof AssertionExtractionResult>;

// ─── Validation Result ──────────────────────────────────────────────────────

export const ValidationResult = z
  .object({
    /** Which active check this result satisfies (derived from verificationCandidate kind). */
    checkId: CheckId,
    /** Whether the check passed (exitCode === 0). */
    passed: z.boolean(),
    /** Human-readable summary (auto-generated from execution). */
    detail: z.string(),
    /** ISO timestamp when execution started. */
    executedAt: z.string().datetime(),
    /** The verification kind that was executed. */
    kind: VerificationCandidateKindSchema,
    /** Exact verification candidate selected for this execution, when identified. */
    candidateId: z.string().min(1).optional(),
    /** The exact command that was run. */
    command: z.string().min(1),
    /** Process exit code. */
    exitCode: z.number().int(),
    /** Execution wall-clock duration in milliseconds. */
    executionMs: z.number().int().nonnegative(),
    /** sha256 hex digest of (stdout + stderr) — tamper-evident evidence binding. */
    outputDigest: z.string().regex(/^[a-f0-9]{64}$/),
    /** Whether the process was killed due to timeout. */
    timedOut: z.boolean(),
    /** Classified evidence outcome (check-level, not claim-level). */
    outcome: ValidationOutcome,
    /** Human-readable reason for the outcome classification. */
    classificationReason: z.string().min(1).optional(),
    /** Structured assertion extraction result (only for assertionCapability='structured'). */
    assertionExtraction: AssertionExtractionResult.optional(),
    /** Candidate scope attestation frozen when this command was executed. */
    fullCheckScopeAttestation: FullCheckScopeAttestationSchema.optional(),
    /** Derived advisory repair guidance; never validation evidence authority. */
    derivedRepairGuidance: RepairGuidance.optional(),
  })
  .readonly();
export type ValidationResult = z.infer<typeof ValidationResult>;

/**
 * Host-observed session-state continuity of one runtime-executed validation
 * attempt.
 *
 * Both values are cryptographic observations, never agent input: the digest
 * observed when the execution surface was frozen (before the command ran) and
 * the digest of the state re-read under the session write lock immediately
 * before this attempt was persisted. `stateChangedDuringExecution` is derived
 * from the pair at projection time — it is deliberately not persisted as a
 * second authority.
 *
 * `committedStateDigest` is intentionally not part of this record: the attempt
 * is itself part of the committed state, so persisting it here would create a
 * recursive self-binding.
 */
export const ValidationExecutionObservation = z
  .object({
    executionObservedStateDigest: z.string().regex(/^[a-f0-9]{64}$/),
    preCommitStateDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .readonly();
export type ValidationExecutionObservation = z.infer<typeof ValidationExecutionObservation>;

/**
 * Immutable record of one runtime-executed validation attempt.
 *
 * The scope binds baseline validation to the approved plan and post-implementation
 * validation to the implementation evidence that was under test.
 */
export const ValidationAttempt = z.discriminatedUnion('scope', [
  z
    .object({
      attemptId: z.string().uuid(),
      scope: z.literal('baseline'),
      planDigest: z.string().min(1),
      executionObservation: ValidationExecutionObservation,
      result: ValidationResult,
    })
    .strict()
    .readonly(),
  z
    .object({
      attemptId: z.string().uuid(),
      scope: z.literal('implementation'),
      implementationDigest: z.string().min(1),
      executionObservation: ValidationExecutionObservation,
      result: ValidationResult,
    })
    .strict()
    .readonly(),
]);
export type ValidationAttempt = z.infer<typeof ValidationAttempt>;

/**
 * Whether a validation result represents an EXECUTION error (the check could not
 * be run to a verdict) rather than a genuine check FAILURE (the check ran and the
 * code did not pass). Execution errors are:
 *  - a timeout (the executor kills the process; exitCode 124), or
 *  - the command could not be executed at all (not found; exitCode 127).
 *
 * F5: execution errors must NOT be treated like a failing check. A failing check
 * routes VALIDATION → PLAN (the plan is deficient) and clears the approved plan,
 * whereas an execution error is an infrastructure/transient condition that should
 * keep the session in VALIDATION for a retry WITHOUT invalidating plan approval.
 */
export function isExecutionError(result: {
  readonly timedOut: boolean;
  readonly exitCode: number;
}): boolean {
  return result.timedOut || result.exitCode === 124 || result.exitCode === 127;
}

/**
 * Canonical validation disposition — the single classification the machine,
 * the rails, and the system-work recovery contract use to decide what a check
 * result means.
 *
 * - `supported`        — the check ran and the artifact passed.
 * - `artifact_failure` — the check ran to a verdict and the artifact failed.
 *   ONLY this disposition may trigger the governed backward transition
 *   (VALIDATION → PLAN / IMPL_VALIDATION → IMPLEMENTATION) and consume the
 *   pending system work.
 * - `technical_block`  — the check could not be run to a trustworthy verdict:
 *   timeout / not-found execution errors, a blocked outcome (subject drift
 *   during execution, suite infrastructure errors, missing assertion
 *   configuration), or an inconclusive assertion extraction. The phase must
 *   stay and the pending system work must remain retryable.
 */
export type ValidationDisposition = 'supported' | 'artifact_failure' | 'technical_block';

export function classifyValidationDisposition(result: {
  readonly passed: boolean;
  readonly outcome: ValidationOutcome;
  readonly timedOut: boolean;
  readonly exitCode: number;
  readonly assertionExtraction?: { readonly status: string };
}): ValidationDisposition {
  if (result.passed && result.outcome === 'supported') return 'supported';
  // A blocked outcome means the check could not produce a trustworthy verdict:
  // timeout, subject drift during execution, suite infrastructure error, or an
  // execution with no output at all.
  if (result.outcome === 'blocked') return 'technical_block';
  if (isExecutionError(result)) return 'technical_block';
  // An inconclusive assertion extraction (missing/unparseable/ambiguous report,
  // provider format mismatch, ...) is lack of trustworthy evidence — not proof
  // that the artifact failed.
  if (result.assertionExtraction?.status === 'inconclusive') return 'technical_block';
  // `inconclusive` with a trustworthy extraction is the genuine failure verdict:
  // the check ran and produced output for a non-passing artifact (e.g. exit 1).
  return 'artifact_failure';
}

/** Convenience predicate for the technical branch of the classification. */
export function isTechnicalValidationBlock(result: {
  readonly passed: boolean;
  readonly outcome: ValidationOutcome;
  readonly timedOut: boolean;
  readonly exitCode: number;
  readonly assertionExtraction?: { readonly status: string };
}): boolean {
  return classifyValidationDisposition(result) === 'technical_block';
}
