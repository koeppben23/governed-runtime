/**
 * @module audit/event-core
 * @description Core audit-chain.v3 event schema: event kinds, the chained
 * event envelope, chain-hash computation, and timestamp-evidence finalization.
 *
 * Design:
 * - The `event` field carries the kind discriminator (e.g., "transition:PLAN_READY")
 * - The `detail` field carries typed payload (cast to Record<string, unknown> for Zod)
 * - All factories require `prevHash` for chain integrity (set to "genesis" for first event)
 *
 * Why not a Zod discriminated union?
 * The JSONL trail is forward-compatible: new event kinds must not break old readers.
 * Using a free-form `event` string + `detail` record keeps the base schema stable.
 * Type safety is enforced at creation time via the factory functions in
 * `audit/event-builders.ts`.
 *
 * @version v1
 */

import { hashText } from '../shared/hashing.js';
import type { ActorInfo, TimestampEvidence } from '../state/evidence.js';
import { canonicalJsonStringify, computeCanonicalEventDigest } from './canonical-digest.js';

// ─── Event Kind ───────────────────────────────────────────────────────────────

/**
 * Closed set of audit event kinds.
 * Each kind has a specific detail payload structure.
 *
 * AUDIT_EVENT_KINDS is the single authority; the type is derived from it.
 */
export const AUDIT_EVENT_KINDS = [
  'transition',
  'state_write',
  'enforcement_denied',
  'tool_call',
  'error',
  'lifecycle',
  'decision',
] as const;

export type AuditEventKind = (typeof AUDIT_EVENT_KINDS)[number];

/**
 * The two audit-chain.v3 event names that are not of the form `${kind}:...`.
 *
 * Every other kind names its events `${kind}:<suffix>`. These two do not, so
 * the emitting factories and any consumer that maps an event name back to its
 * kind must share one definition rather than re-encode the exception.
 */
export const STATE_WRITE_EVENT_NAME = 'state_write';
export const ENFORCEMENT_DENIED_EVENT_NAME = 'enforcement:denied';

export type AuditFormatVersion = 'audit-chain.v3';

export const CURRENT_AUDIT_FORMAT_VERSION: AuditFormatVersion = 'audit-chain.v3';

// ─── Audit Event with Chain Hash ─────────────────────────────────────────────

/**
 * Extended audit event with hash chain fields.
 * These fields are added by the factory functions and stored in the JSONL trail.
 *
 * Hash chain integrity:
 * - `prevHash`: hash of the previous event (or "genesis" for the first event)
 * - `chainHash`: SHA-256(prevHash + JSON(this event without chainHash))
 * - To verify: recompute chainHash from prevHash + event data, compare
 *
 * Actor identity (P27):
 * - `actor`: Classification label — "human", "machine", or "system" (backward-compat string)
 * - `actorInfo`: Optional structured identity (id, email, source). Present on
 *   human-influenced events (lifecycle, tool_call, decision). Absent on
 *   machine-only events (transition, error). When absent, JSON.stringify
 *   omits the field — chain hash stays identical for pre-P27 events.
 */
export interface ChainedAuditEvent {
  readonly id: string;
  /** FlowGuard session identity — the SAME FlowGuard UUID on every event class. */
  readonly flowguardSessionId: string;
  /** Host session identity (OpenCode session id), bound where host context exists. */
  readonly hostSessionId?: string | undefined;
  readonly phase: string;
  readonly event: string;
  readonly auditSequence: number;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly actor: string;
  readonly auditFormatVersion: AuditFormatVersion;
  readonly actorInfo?: ActorInfo | undefined;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly prevHash: string;
  readonly chainHash: string;
  /** SHA-256 of event without timestampEvidence and chainHash. TSA anchoring. */
  readonly semanticEventDigest: string;
  /** Timestamp assurance evidence (NTP offset, TSA token, verification status). */
  readonly timestampEvidence?: TimestampEvidence | undefined;
  /**
   * Enforcement level active when this event was recorded.
   * Optional: event classes not bound to a host enforcement decision omit it;
   * absence is not a legacy or migration signal (non-v3 trails are rejected).
   * @since v1.3.0 (HAI #242)
   */
  readonly enforcementLevel?: 'synchronous' | 'hook_gated' | 'advisory' | undefined;
}

// ─── Genesis Constant ─────────────────────────────────────────────────────────

/** The prevHash value for the first event in a chain. */
export const GENESIS_HASH = 'genesis';

// ─── Event Body ───────────────────────────────────────────────────────────────

/** Body type used by build helpers — semantic fields only. */
export type EventBody = Omit<
  ChainedAuditEvent,
  'chainHash' | 'timestampEvidence' | 'auditSequence' | 'recordedAt' | 'semanticEventDigest'
>;

// ─── Hash Computation ─────────────────────────────────────────────────────────

/**
 * Compute the chain hash for an event.
 * Hash = SHA-256(prevHash + canonical JSON of event without chainHash).
 *
 * Canonical JSON: keys sorted alphabetically, no whitespace.
 * This ensures deterministic hashing regardless of object key insertion order.
 */
export function computeChainHash(
  prevHash: string,
  event: Omit<ChainedAuditEvent, 'chainHash'>,
): string {
  const canonical = canonicalJsonStringify(event);
  const input = `audit-chain.v3:${prevHash}:${canonical}`;
  return hashText(input);
}

/**
 * Finalize an event body with optional timestamp evidence.
 *
 * Two-digest architecture:
 * 1. canonicalEventDigest = SHA-256(event body WITHOUT evidence, chainHash, digest)
 *    Uses preComputedDigest if provided (from external TSA resolution path),
 *    otherwise computes it internally.
 * 2. If evidence provided: attaches canonicalEventDigest + timestampEvidence.
 *    Ensures tsa.messageImprint matches canonicalEventDigest when TSA data exists.
 * 3. chainHash = SHA-256(prevHash + full event WITHOUT chainHash).
 *
 * @param body - Event body without chainHash, canonicalEventDigest, or timestampEvidence.
 * @param prevHash - Hash of the previous event (or GENESIS_HASH).
 * @param timestampEvidence - Optional timestamp assurance evidence.
 * @param preComputedDigest - Optional pre-computed canonical digest. Must match
 *   computeCanonicalEventDigest(body). Required when evidence was resolved externally.
 */
export function finalizeWithTimestampEvidence(
  body: EventBody,
  prevHash: string,
  timestampEvidence?: TimestampEvidence,
  preComputedDigest?: string,
): ChainedAuditEvent {
  const semanticEventDigest = preComputedDigest ?? computeCanonicalEventDigest(body);
  // Positional fields are provisional here: the append authority re-stamps
  // auditSequence, recordedAt, and semanticEventDigest under the audit write
  // lock when the event is persisted. These values keep the standalone
  // ChainedAuditEvent well-formed without claiming chain position.
  const finalized: Omit<ChainedAuditEvent, 'chainHash'> = {
    ...body,
    auditSequence: 0,
    recordedAt: body.occurredAt,
    semanticEventDigest,
  };
  if (!timestampEvidence) {
    return { ...finalized, chainHash: computeChainHash(prevHash, finalized) };
  }
  const canonicalDigest = semanticEventDigest;
  const evidence: TimestampEvidence = timestampEvidence.tsa
    ? {
        ...timestampEvidence,
        tsa: {
          ...timestampEvidence.tsa,
          messageImprint: canonicalDigest,
          digestAlgorithm: timestampEvidence.tsa.digestAlgorithm ?? 'sha256',
        },
      }
    : timestampEvidence;
  const base: Omit<ChainedAuditEvent, 'chainHash'> = {
    ...finalized,
    timestampEvidence: evidence,
  };
  return { ...base, chainHash: computeChainHash(prevHash, base) };
}
