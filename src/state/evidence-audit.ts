/**
 * @module evidence-audit
 * @description Audit event schema — tamper-evident JSONL audit trail entries with hash-chain linking.
 *
 * @version v2 — added canonicalEventDigest and timestampEvidence for TSA anchoring.
 */

import { z } from 'zod';
import { OpenCodeSessionId } from './evidence-assurance-internal.js';
import { ActorInfoSchema } from './evidence-identity.js';
import { TimestampEvidence } from './evidence-timestamp.js';

/**
 * Single audit event — appended to JSONL audit trail.
 * Phase is a plain string (forward-compatible: new phases don't break old logs).
 *
 * Hash chain fields (prevHash, chainHash) are optional for backward compatibility:
 * - Legacy events (pre-chain) omit these fields
 * - New events always include them
 * - The integrity verifier handles mixed trails gracefully
 *
 * Timestamp assurance fields (canonicalEventDigest, timestampEvidence) are optional:
 * - Legacy events (pre-#269) omit these fields
 * - Events without timestampEvidence are treated as status:'local' by verification
 * - canonicalEventDigest anchors TSA messageImprint
 *
 * Actor identity (P27):
 * - `actor`: Classification label — "human", "machine", or "system" (string)
 * - `actorInfo`: Optional structured identity (id, email, source). Present on
 *   human-influenced events (lifecycle, tool_call, decision). Absent on
 *   machine-only events (transition, error). When absent, JSON.stringify
 *   omits the field — chain hash stays identical for pre-P27 events.
 */
export const AuditEvent = z
  .object({
    id: z.string().uuid(),
    sessionId: OpenCodeSessionId,
    phase: z.string(),
    event: z.string(),
    timestamp: z.string().datetime(),
    actor: z.string(),
    detail: z.record(z.string(), z.unknown()),
    /** Resolved actor identity. Present on human-influenced events, absent on machine-only. */
    actorInfo: ActorInfoSchema.optional(),
    /** Hash of the previous event in the chain (or "genesis" for the first event). */
    prevHash: z.string().optional(),
    /** SHA-256(prevHash + canonical JSON of this event). Tamper-evident chain link. */
    chainHash: z.string().optional(),
    /** SHA-256 of event content without timestampEvidence and chainHash. For TSA anchoring. */
    canonicalEventDigest: z.string().optional(),
    /** Timestamp assurance evidence (NTP offset, TSA token, verification status). */
    timestampEvidence: TimestampEvidence.optional(),
  })
  .readonly();
export type AuditEvent = z.infer<typeof AuditEvent>;
