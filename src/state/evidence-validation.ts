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
import { VerificationCandidateKindSchema } from './discovery-schemas.js';
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

export const AssertionExtractionResult = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('not_configured'),
  }),
  z.object({
    status: z.literal('blocked'),
    attemptId: z.string().uuid(),
    reason: z.string().min(1),
  }),
  z.object({
    status: z.literal('inconclusive'),
    attemptId: z.string().uuid(),
    reason: z.string().min(1),
  }),
  z.object({
    status: z.literal('extracted'),
    attemptId: z.string().uuid(),
    format: ReportFormatId,
    reportDigests: z.array(z.string().min(1)).min(1),
    assertions: z.array(StructuredAssertionEvidence),
    summary: AssertionExtractionSummary,
  }),
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
    /** Derived advisory repair guidance; never validation evidence authority. */
    derivedRepairGuidance: RepairGuidance.optional(),
  })
  .readonly();
export type ValidationResult = z.infer<typeof ValidationResult>;

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
      result: ValidationResult,
    })
    .strict()
    .readonly(),
  z
    .object({
      attemptId: z.string().uuid(),
      scope: z.literal('implementation'),
      implementationDigest: z.string().min(1),
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
