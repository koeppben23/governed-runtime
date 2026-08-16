/**
 * @module evidence-mutation
 * @description Immutable records of FlowGuard-observed mutation reports.
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
 * What is FlowGuard-computed vs. caller-supplied (do not conflate):
 * - COMPUTED by FlowGuard: `artifactDigest`, `projectionDigest`, and
 *   `implementationDigest` (derived from session state).
 * - SUPPLIED by the caller: `command`, `startedAt`, `completedAt`, `exitCode`.
 *   These describe a run FlowGuard did not observe and are not attested
 *   execution evidence.
 *
 * @version v1
 */

import { z } from 'zod';

/**
 * An immutable record of one FlowGuard-observed mutation report.
 *
 * - `implementationDigest` is bound to the session-state implementation at the
 *   time of recording — the tool MUST derive it from session state, never from
 *   caller input.
 * - `artifactDigest` is the SHA-256 of the raw report file on disk (tamper
 *   evidence over the exact artifact).
 * - `projectionDigest` is the SHA-256 of the canonical parsed subset that
 *   FlowGuard's evaluator consumes (provider result digest).
 * - `command`, `startedAt`, `completedAt` and `exitCode` are caller-supplied run
 *   metadata describing a process FlowGuard did not execute or observe.
 */
export const MutationAttempt = z
  .object({
    /** Stable attempt identifier. */
    attemptId: z.string().uuid(),
    /** Implementation revision the mutation was run against (from session state). */
    implementationDigest: z.string().min(1),
    /** CALLER-SUPPLIED command said to have produced the report (not executed by FlowGuard). */
    command: z.string().min(1),
    /** CALLER-SUPPLIED start timestamp of the mutation run (not observed by FlowGuard). */
    startedAt: z.string().datetime(),
    /** CALLER-SUPPLIED completion timestamp of the mutation run (not observed by FlowGuard). */
    completedAt: z.string().datetime(),
    /** CALLER-SUPPLIED exit code of the mutation command (not observed by FlowGuard). */
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
