import { z } from 'zod';

export const ImplementationRework = z.object({
  rejectedDigest: z.string().min(1),
  // Hard Assurance Epoch: the review-budget state is authority — it must be
  // persisted explicitly, never defaulted from an absent value to `false`.
  exhausted: z.boolean(),
});
