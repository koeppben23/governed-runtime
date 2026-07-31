/**
 * @module evidence-mutation
 * @description Immutable FlowGuard-attested mutation evidence records.
 *
 * A `MutationAttempt` is the canonical audit-bound record of a recorded mutation
 * run. It is produced by the `flowguard_record_mutation_evidence` tool and
 * persisted in session state. Claims reference it via `MutationAttemptRef`
 * (evidence), never as governing authority.
 *
 * The raw mutation report is an EXTERNAL artifact produced by Stryker or a
 * similar mutation tool. FlowGuard does not execute mutation runs; it observes,
 * validates, and records them. A freely-editable filesystem envelope without a
 * corresponding `MutationAttempt` is NOT_VERIFIED evidence.
 *
 * @version v1
 */

import { z } from 'zod';

/**
 * An immutable record of one FlowGuard-attested mutation report observation.
 *
 * - `implementationDigest` is bound to the session-state implementation at the
 *   time of recording — the tool MUST derive it from session state, never from
 *   caller input.
 * - `artifactDigest` is the SHA-256 of the raw report file on disk (tamper
 *   evidence over the exact artifact).
 * - `projectionDigest` is the SHA-256 of the canonical parsed subset that
 *   FlowGuard's evaluator consumes (provider result digest).
 */
export const MutationAttempt = z
  .object({
    /** Stable attempt identifier. */
    attemptId: z.string().uuid(),
    /** Implementation revision the mutation was run against (from session state). */
    implementationDigest: z.string().min(1),
    /** Exact command that produced the report (recorded for reproducibility). */
    command: z.string().min(1),
    /** ISO-8601 timestamp when the mutation run started. */
    startedAt: z.string().datetime(),
    /** ISO-8601 timestamp when the mutation run completed. */
    completedAt: z.string().datetime(),
    /** Exit code of the mutation command. */
    exitCode: z.number().int(),
    /** SHA-256 of the raw mutation report file (artifact integrity). */
    artifactDigest: z.string().regex(/^[a-f0-9]{64}$/),
    /** SHA-256 of the canonical projection consumed by the evaluator. */
    projectionDigest: z.string().regex(/^[a-f0-9]{64}$/),
    /** Repository-relative path to the saved report. */
    reportPath: z.string().min(1),
    /** Provider version stamped on this evidence record. */
    providerVersion: z.string().min(1),
  })
  .strict()
  .readonly();
export type MutationAttempt = z.infer<typeof MutationAttempt>;
