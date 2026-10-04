import { z } from 'zod';

export const ExportCompletionEvidence = z
  .object({
    id: z.string().uuid(),
    packageDigest: z.string().regex(/^[a-f0-9]{64}$/),
    purpose: z.enum(['auditor']),
    integrityCapability: z.enum(['verifiable']),
    createdAt: z.string().datetime(),
  })
  .readonly();
export type ExportCompletionEvidence = z.infer<typeof ExportCompletionEvidence>;
