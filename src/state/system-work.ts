/**
 * @module system-work
 * @description Persisted marker for canonical system-work operations.
 *
 * `VALIDATION` and `IMPL_VALIDATION` are `system_work` phases: the runtime, not
 * the user, owns the next step. The marker is written atomically with the
 * transition that enters such a phase, so a crash between the human decision
 * and the actual check execution is recoverable: the next runtime contact
 * resumes the pending work instead of leaving a dead state with no command.
 *
 * @version v1
 */

import { z } from 'zod';

export const SystemWorkOperation = z
  .object({
    kind: z.literal('validation'),
    requestedAt: z.string().datetime(),
  })
  .strict()
  .readonly();
export type SystemWorkOperation = z.infer<typeof SystemWorkOperation>;
