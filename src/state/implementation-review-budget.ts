import { z } from 'zod';
import { DecisionIdentitySchema } from './evidence-identity.js';

export const ImplementationRework = z.object({
  rejectedDigest: z.string().min(1),
  exhausted: z.boolean().default(false),
});

export const ImplementationReviewExtension = z
  .object({
    additionalIterations: z.number().int().positive().finite(),
    authorizedAt: z.string().datetime(),
    authorizedBy: DecisionIdentitySchema,
  })
  .readonly();
