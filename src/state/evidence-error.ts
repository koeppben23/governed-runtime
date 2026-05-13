/**
 * @module evidence-error
 * @description Fail-closed error state schema for FlowGuard sessions.
 *
 * @version v1
 */

import { z } from 'zod';

export const ErrorInfo = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    recoveryHint: z.string(),
    occurredAt: z.string().datetime(),
  })
  .readonly();
export type ErrorInfo = z.infer<typeof ErrorInfo>;
