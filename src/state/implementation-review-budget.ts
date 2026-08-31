import { z } from 'zod';
import { DecisionIdentitySchema } from './evidence-identity.js';

export const ImplementationRework = z.object({
  rejectedDigest: z.string().min(1),
  // Hard Assurance Epoch: the review-budget state is authority — it must be
  // persisted explicitly, never defaulted from an absent value to `false`.
  exhausted: z.boolean(),
});

export const ImplementationReviewExtension = z
  .object({
    additionalIterations: z.number().int().positive().finite(),
    authorizedAt: z.string().datetime(),
    authorizedBy: DecisionIdentitySchema,
  })
  .readonly();
