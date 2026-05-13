/**
 * @module evidence-validation
 * @description Validation check result schema for the VALIDATION phase.
 *
 * @version v1
 */

import { z } from 'zod';
import { CheckId } from './evidence-primitives.js';

/** Result of a single validation check. P10a: evidence metadata for agent-reported results. */
export const ValidationResult = z
  .object({
    checkId: CheckId,
    passed: z.boolean(),
    detail: z.string(),
    executedAt: z.string().datetime(),
    /** How this check was executed. */
    evidenceType: z
      .enum(['command_output', 'ci_run', 'manual_review', 'external_reference'])
      .optional(),
    /** The command that was run (if evidenceType is command_output). */
    command: z.string().optional(),
    /** Summary of the evidence (e.g. test output, CI URL, review notes). */
    evidenceSummary: z.string().optional(),
  })
  .readonly();
export type ValidationResult = z.infer<typeof ValidationResult>;
