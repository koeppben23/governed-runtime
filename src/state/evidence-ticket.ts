/**
 * @module evidence-ticket
 * @description Ticket evidence schema — the user's task description produced by /ticket.
 *
 * @version v1
 */

import { z } from 'zod';
import { ExternalReferenceSchema, InputOriginSchema } from './evidence-primitives.js';

/** Evidence produced by /ticket — the user's task description. */
export const TicketEvidence = z
  .object({
    text: z.string().min(1),
    digest: z.string().min(1),
    source: z.enum(['user', 'external']),
    createdAt: z.string().datetime(),
    inputOrigin: InputOriginSchema.optional(),
    references: z.array(ExternalReferenceSchema).optional(),
  })
  .readonly();
export type TicketEvidence = z.infer<typeof TicketEvidence>;
