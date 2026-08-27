/**
 * @module evidence-audit
 * @description Audit event schema — tamper-evident JSONL audit trail entries with hash-chain linking.
 *
 * @version v3 — Assurance epoch audit envelope.
 */

import { z } from 'zod';
import { OpenCodeSessionId } from './evidence-assurance-internal.js';
import { ActorInfoSchema } from './evidence-identity.js';
import { TimestampEvidence } from './evidence-timestamp.js';

/**
 * Single audit event — appended to JSONL audit trail.
 * Phase is a plain string (forward-compatible: new phases don't break old logs).
 *
 * All persisted events use the single audit-chain.v3 format. Legacy records
 * are rejected at every persistence and verification boundary.
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
    auditFormatVersion: z.literal('audit-chain.v3'),
    auditSequence: z.number().int().positive(),
    occurredAt: z.string().datetime(),
    recordedAt: z.string().datetime(),
    actor: z.string(),
    detail: z.record(z.string(), z.unknown()),
    /** Resolved actor identity. Present on human-influenced events, absent on machine-only. */
    actorInfo: ActorInfoSchema.optional(),
    /** Hash of the previous event in the chain (or "genesis" for the first event). */
    prevHash: z.string().regex(/^[a-f0-9]{64}$|^genesis$/),
    semanticEventDigest: z.string().regex(/^[a-f0-9]{64}$/),
    /** SHA-256 of the versioned, position-bound audit record. */
    chainHash: z.string().regex(/^[a-f0-9]{64}$/),
    /** Timestamp assurance evidence (NTP offset, TSA token, verification status). */
    timestampEvidence: TimestampEvidence.optional(),
    /**
     * Enforcement level active when this event was recorded.
     * Indicates the strength of governance enforcement at the time of the decision.
     * - synchronous: guaranteed block (in-process throw or exit-code-2)
     * - hook_gated: hook can block but model may have theoretical workaround paths
     * - advisory: best-effort, no hard block mechanism
     *
     * Optional for backward compatibility: pre-HAI events omit this field.
     * @since v1.3.0 (HAI #242)
     */
    enforcementLevel: z.enum(['synchronous', 'hook_gated', 'advisory']).optional(),
  })
  .strict()
  .readonly();
export type AuditEvent = z.infer<typeof AuditEvent>;

/**
 * Producer-side audit event body: every semantic field minus the positional
 * and hash fields that only the append authority may stamp under the audit
 * write lock (auditFormatVersion, auditSequence, recordedAt,
 * semanticEventDigest, prevHash, chainHash). Supplying any of them up front
 * would let a producer forge chain position, sequence authority, or record
 * time — so they are not part of the accepted input at all.
 */
export const AuditEventBodySchema = AuditEvent.unwrap()
  .omit({
    auditFormatVersion: true,
    auditSequence: true,
    recordedAt: true,
    semanticEventDigest: true,
    prevHash: true,
    chainHash: true,
  })
  // Producers may pass pre-finalized events (e.g. the plugin path). Any
  // producer-supplied positional/hash field is silently dropped here and
  // re-stamped by the append authority — never trusted, never persisted.
  .loose();

/** Producer-side audit event body: semantic fields minus append-stamped authority fields. */
export type AuditEventBody = Omit<
  AuditEvent,
  | 'auditFormatVersion'
  | 'auditSequence'
  | 'recordedAt'
  | 'semanticEventDigest'
  | 'prevHash'
  | 'chainHash'
>;
