/**
 * @module system-work
 * @description Persisted marker for canonical system-work operations.
 *
 * `VALIDATION` and `IMPL_VALIDATION` are `system_work` phases: the runtime, not
 * the user, owns the next step. The marker is written atomically with the
 * transition that enters such a phase, so a crash between the human decision
 * and the actual check execution is recoverable: the next session lifecycle
 * opportunity resumes the pending work instead of leaving a dead state with no
 * commands.
 *
 * Retry state: a technical outcome keeps the operation pending and records the
 * attempt count plus a `retryAfter` backoff, so lifecycle events can retry
 * without a tight loop. A new transition re-arms the operation with
 * `attempt: 0` and no backoff.
 *
 * @version v2
 */

import { z } from 'zod';

export const SystemWorkOperation = z
  .object({
    kind: z.literal('validation'),
    requestedAt: z.string().datetime(),
    /** Completed automatic attempts for this operation generation. */
    attempt: z.number().int().nonnegative(),
    /** Earliest ISO timestamp for the next automatic retry; null = immediately retryable. */
    retryAfter: z.string().datetime().nullable(),
  })
  .strict()
  .readonly();
export type SystemWorkOperation = z.infer<typeof SystemWorkOperation>;
