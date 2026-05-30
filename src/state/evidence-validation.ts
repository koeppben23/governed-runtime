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
    /** Derived advisory repair guidance; never validation evidence authority. */
    derivedRepairGuidance: RepairGuidance.optional(),
  })
  .readonly();
export type ValidationResult = z.infer<typeof ValidationResult>;
