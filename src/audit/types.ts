/**
 * @module audit/types
 * @description Structured audit event types, kinds, and factory functions.
 *
 * The base AuditEvent schema (evidence.ts) stores generic `event` and `detail` fields.
 * This module adds semantic structure:
 * - Closed set of event kinds (transition, state_write, tool_call, error, lifecycle)
 * - Typed detail payloads per kind
 * - Factory functions that produce valid AuditEvent objects
 *
 * Design:
 * - The `event` field carries the kind discriminator (e.g., "transition:PLAN_READY")
 * - The `detail` field carries typed payload (cast to Record<string, unknown> for Zod)
 * - Factory functions ensure consistency — callers never hand-craft audit events
 * - All factories require `prevHash` for chain integrity (set to "genesis" for first event)
 *
 * Why not a Zod discriminated union?
 * The JSONL trail is forward-compatible: new event kinds must not break old readers.
 * Using a free-form `event` string + `detail` record keeps the base schema stable.
 * Type safety is enforced at creation time via these factory functions.
 *
 * @version v1
 */

import * as crypto from 'node:crypto';
import { hashText } from '../shared/hashing.js';
import type { Phase, Event } from '../state/schema.js';
import type { ReviewVerdict, TimestampEvidence } from '../state/evidence.js';
import { canonicalJsonStringify, computeCanonicalEventDigest } from './canonical-digest.js';

// P2b: Canonical ActorInfo and ActorVerificationMeta live in state/evidence.ts (Zod SSOT).
// Re-exported here for backward compatibility — all existing consumers continue to work.
import type { ActorInfo, ActorVerificationMeta } from '../state/evidence.js';
export type { ActorInfo, ActorVerificationMeta };

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

export type AuditFormatVersion = 'audit-chain.v3';

export const CURRENT_AUDIT_FORMAT_VERSION: AuditFormatVersion = 'audit-chain.v3';

// ─── Detail Payloads (typed, but stored as Record<string, unknown>) ──────────

/** Detail payload for transition events. */
export interface TransitionDetail {
  kind: 'transition';
  /** Durable state↔audit operation identity when emitted from the outbox. */
  operationId?: string;
  /** State-authority digests committed by the durable audit outbox. */
  preStateDigest?: string;
  mutationDigest?: string;
  postStateDigest?: string;
  from: Phase;
  to: Phase;
  event: Event;
  /** Whether this transition was part of an autoAdvance chain. */
  autoAdvanced: boolean;
  /** Position in the autoAdvance chain (0-based). -1 if not auto-advanced. */
  chainIndex: number;
}

/** Detail payload for a durable same-phase authority write. */
export interface StateWriteDetail {
  kind: 'state_write';
  operationId: string;
  preStateDigest: string;
  mutationDigest: string;
  postStateDigest: string;
}

/** Detail payload for a synchronously denied host-tool invocation. */
export interface EnforcementDeniedDetail {
  kind: 'enforcement_denied';
  tool: string;
  reasonCode: string;
  hostCallId: string;
  traceId: string;
  policyMode: string;
  enforcementLevel: 'synchronous' | 'hook_gated' | 'advisory';
}

/** Detail payload for tool call events. */
export interface ToolCallDetail {
  kind: 'tool_call';
  tool: string;
  /** Summarized args (no sensitive data — just keys and scalar values). */
  argsSummary: Record<string, string>;
  /** Whether the tool call succeeded. */
  success: boolean;
  /** Error message if failed. */
  errorMessage?: string;
  /** Stable FlowGuard reason code if the tool returned a structured block. */
  errorCode?: string;
  /** Number of transitions triggered by this tool call. */
  transitionCount: number;
}

/** Detail payload for error events. */
export interface ErrorDetail {
  kind: 'error';
  code: string;
  message: string;
  recoveryHint: string;
  /** The phase where the error occurred. */
  errorPhase: Phase;
}

/** Detail payload for lifecycle events. */
export interface LifecycleDetail {
  kind: 'lifecycle';
  action: 'session_created' | 'session_completed' | 'session_aborted';
  /** Final phase at lifecycle event. */
  finalPhase: Phase;
  /** Optional reason (e.g., abort reason). */
  reason?: string;
}

/** Detail payload for decision receipt events. */
export interface DecisionDetail {
  kind: 'decision';
  decisionId: string;
  decisionSequence: number;
  gatePhase: Phase;
  verdict: ReviewVerdict;
  rationale: string;
  decidedBy: string;
  decidedAt: string;
  fromPhase: Phase;
  toPhase: Phase;
  transitionEvent: Event;
  policyMode: string;
}

/** Union of all typed detail payloads. */
export type TypedDetail =
  | TransitionDetail
  | StateWriteDetail
  | EnforcementDeniedDetail
  | ToolCallDetail
  | ErrorDetail
  | LifecycleDetail
  | DecisionDetail;

// ─── Actor Identity ──────────────────────────────────────────────────────────
// P2b: ActorInfo and ActorVerificationMeta are canonically defined in
// state/evidence.ts (Zod schema SSOT). Imported and re-exported above.
// All factory functions, ChainedAuditEvent, and external consumers use
// the same canonical type — no drift possible.

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
  readonly hostSessionId?: string;
  readonly phase: string;
  readonly event: string;
  readonly auditSequence: number;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly actor: string;
  readonly auditFormatVersion: AuditFormatVersion;
  readonly actorInfo?: ActorInfo;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly prevHash: string;
  readonly chainHash: string;
  /** SHA-256 of event without timestampEvidence and chainHash. TSA anchoring. */
  readonly semanticEventDigest: string;
  /** Timestamp assurance evidence (NTP offset, TSA token, verification status). */
  readonly timestampEvidence?: TimestampEvidence;
  /**
   * Enforcement level active when this event was recorded.
   * Optional for backward compatibility: pre-HAI events omit this field.
   * @since v1.3.0 (HAI #242)
   */
  readonly enforcementLevel?: 'synchronous' | 'hook_gated' | 'advisory';
}

// ─── Genesis Constant ─────────────────────────────────────────────────────────

/** The prevHash value for the first event in a chain. */
export const GENESIS_HASH = 'genesis';

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

// ─── Detail Conversion ────────────────────────────────────────────────────────

/**
 * Type-safe conversion from typed detail payload to generic record.
 * Replaces dangerous `as unknown as Record<string, unknown>` double-casts.
 *
 * The function boundary enforces that only valid TypedDetail payloads are accepted.
 * The widening to Record<string, unknown> is safe because all TypedDetail property
 * values (string, boolean, number, Phase, Event) are subtypes of `unknown`.
 */
function toDetailRecord(detail: TypedDetail): Record<string, unknown> {
  // Iterative copy: zero casts, fully type-safe.
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    record[key] = value;
  }
  return record;
}

// ─── Factory Functions ────────────────────────────────────────────────────────

/** Body type used by build helpers — semantic fields only. */
export type EventBody = Omit<
  ChainedAuditEvent,
  'chainHash' | 'timestampEvidence' | 'auditSequence' | 'recordedAt' | 'semanticEventDigest'
>;

/**
 * Build a transition event body (no chainHash, no canonical digest, no evidence).
 */
// eslint-disable-next-line max-params -- positional factory API kept explicit for call-site auditability
export function buildTransitionBody(
  flowguardSessionId: string,
  hostSessionId: string | undefined,
  phase: Phase,
  detail: Omit<TransitionDetail, 'kind'>,
  occurredAt: string,
  prevHash: string,
): EventBody {
  return {
    id: detail.operationId ?? crypto.randomUUID(),
    flowguardSessionId,
    ...(hostSessionId ? { hostSessionId } : {}),
    phase,
    event: `transition:${detail.event}`,
    occurredAt,
    actor: 'machine',
    auditFormatVersion: CURRENT_AUDIT_FORMAT_VERSION,
    detail: toDetailRecord({ ...detail, kind: 'transition' }),
    prevHash,
  };
}

/** Build a state-write event body from a durable outbox operation. */
// eslint-disable-next-line max-params -- positional factory API kept explicit for call-site auditability
export function buildStateWriteBody(
  flowguardSessionId: string,
  hostSessionId: string | undefined,
  phase: Phase,
  detail: Omit<StateWriteDetail, 'kind'>,
  occurredAt: string,
  prevHash: string,
): EventBody {
  return {
    id: detail.operationId,
    flowguardSessionId,
    ...(hostSessionId ? { hostSessionId } : {}),
    phase,
    event: 'state_write',
    occurredAt,
    actor: 'machine',
    auditFormatVersion: CURRENT_AUDIT_FORMAT_VERSION,
    detail: toDetailRecord({ ...detail, kind: 'state_write' }),
    prevHash,
  };
}

/** Build a denied-enforcement event body from the synchronous host hook. */
// eslint-disable-next-line max-params -- positional factory API kept explicit for call-site auditability
export function buildEnforcementDeniedBody(
  flowguardSessionId: string,
  hostSessionId: string | undefined,
  phase: Phase,
  detail: Omit<EnforcementDeniedDetail, 'kind'>,
  occurredAt: string,
  prevHash: string,
): EventBody {
  return {
    id: crypto.randomUUID(),
    flowguardSessionId,
    ...(hostSessionId ? { hostSessionId } : {}),
    phase,
    event: 'enforcement:denied',
    occurredAt,
    actor: 'machine',
    auditFormatVersion: CURRENT_AUDIT_FORMAT_VERSION,
    enforcementLevel: detail.enforcementLevel,
    detail: toDetailRecord({ ...detail, kind: 'enforcement_denied' }),
    prevHash,
  };
}

/**
 * Input object for createTransitionEvent.
 */
export interface TransitionEventInput {
  readonly flowguardSessionId: string;
  readonly hostSessionId?: string;
  readonly phase: Phase;
  readonly detail: Omit<TransitionDetail, 'kind'>;
  readonly occurredAt: string;
  readonly prevHash: string;
  readonly timestampEvidence?: TimestampEvidence;
}

/**
 * Create a transition audit event.
 * One event per state machine transition. autoAdvance may produce multiple.
 */
export function createTransitionEvent(
  ...args:
    | [input: TransitionEventInput]
    | [
        flowguardSessionId: string,
        phase: Phase,
        detail: Omit<TransitionDetail, 'kind'>,
        occurredAt: string,
        prevHash: string,
        timestampEvidence?: TimestampEvidence,
        hostSessionId?: string,
      ]
): ChainedAuditEvent {
  const input = normalizeTransitionEventInput(args);
  return finalizeWithTimestampEvidence(
    buildTransitionBody(
      input.flowguardSessionId,
      input.hostSessionId,
      input.phase,
      input.detail,
      input.occurredAt,
      input.prevHash,
    ),
    input.prevHash,
    input.timestampEvidence,
  );
}

function normalizeTransitionEventInput(
  args:
    | [input: TransitionEventInput]
    | [
        flowguardSessionId: string,
        phase: Phase,
        detail: Omit<TransitionDetail, 'kind'>,
        occurredAt: string,
        prevHash: string,
        timestampEvidence?: TimestampEvidence,
        hostSessionId?: string,
      ],
): TransitionEventInput {
  if (args.length === 1) return args[0];
  const [
    flowguardSessionId,
    phase,
    detail,
    occurredAt,
    prevHash,
    timestampEvidence,
    hostSessionId,
  ] = args;
  return {
    flowguardSessionId,
    hostSessionId,
    phase,
    detail,
    occurredAt,
    prevHash,
    timestampEvidence,
  };
}

/**
 * Input object for createToolCallEvent.
 */
export interface ToolCallEventInput {
  readonly flowguardSessionId: string;
  readonly hostSessionId?: string;
  readonly phase: string;
  readonly detail: Omit<ToolCallDetail, 'kind'>;
  readonly occurredAt: string;
  readonly actor: string;
  readonly prevHash: string;
  readonly actorInfo?: ActorInfo;
  readonly timestampEvidence?: TimestampEvidence;
}

/**
 * Create a tool call audit event.
 * One event per FlowGuard tool invocation.
 */
/**
 * Build a tool call event body (no chainHash, no canonical digest, no evidence).
 */
export function buildToolCallBody(input: Omit<ToolCallEventInput, 'timestampEvidence'>): EventBody {
  const {
    flowguardSessionId,
    hostSessionId,
    phase,
    detail,
    occurredAt,
    actor,
    prevHash,
    actorInfo,
  } = input;
  return {
    id: crypto.randomUUID(),
    flowguardSessionId,
    ...(hostSessionId ? { hostSessionId } : {}),
    phase,
    event: `tool_call:${detail.tool}`,
    occurredAt,
    actor,
    auditFormatVersion: CURRENT_AUDIT_FORMAT_VERSION,
    ...(actorInfo ? { actorInfo } : {}),
    detail: toDetailRecord({ ...detail, kind: 'tool_call' }),
    prevHash,
  };
}

/**
 * Create a tool call audit event.
 * One event per FlowGuard tool invocation.
 */
export function createToolCallEvent(input: ToolCallEventInput): ChainedAuditEvent {
  return finalizeWithTimestampEvidence(
    buildToolCallBody(input),
    input.prevHash,
    input.timestampEvidence,
  );
}

/**
 * Create an error audit event.
 * Emitted when the state machine enters an error state.
 */
/**
 * Build an error event body (no chainHash, no canonical digest, no evidence).
 */
export function buildErrorBody(
  flowguardSessionId: string,
  hostSessionId: string | undefined,
  detail: Omit<ErrorDetail, 'kind'>,
  occurredAt: string,
  prevHash: string,
): EventBody {
  return {
    id: crypto.randomUUID(),
    flowguardSessionId,
    ...(hostSessionId ? { hostSessionId } : {}),
    phase: detail.errorPhase,
    event: `error:${detail.code}`,
    occurredAt,
    actor: 'machine',
    auditFormatVersion: CURRENT_AUDIT_FORMAT_VERSION,
    detail: toDetailRecord({ ...detail, kind: 'error' }),
    prevHash,
  };
}

/**
 * Create an error audit event.
 * Emitted when the state machine enters an error state.
 */
// eslint-disable-next-line max-params -- positional factory API kept explicit for call-site auditability
export function createErrorEvent(
  flowguardSessionId: string,
  hostSessionId: string | undefined,
  detail: Omit<ErrorDetail, 'kind'>,
  occurredAt: string,
  prevHash: string,
  timestampEvidence?: TimestampEvidence,
): ChainedAuditEvent {
  return finalizeWithTimestampEvidence(
    buildErrorBody(flowguardSessionId, hostSessionId, detail, occurredAt, prevHash),
    prevHash,
    timestampEvidence,
  );
}

/**
 * Input object for createLifecycleEvent.
 */
export interface LifecycleEventInput {
  /** Stable commit identity for retry-safe lifecycle events. */
  readonly id?: string;
  readonly flowguardSessionId: string;
  readonly hostSessionId?: string;
  readonly detail: Omit<LifecycleDetail, 'kind'>;
  readonly occurredAt: string;
  readonly actor: string;
  readonly prevHash: string;
  readonly actorInfo?: ActorInfo;
  readonly timestampEvidence?: TimestampEvidence;
}

/**
 * Create a lifecycle audit event.
 * Emitted on session creation, completion, or abortion.
 */
/**
 * Build a lifecycle event body (no chainHash, no canonical digest, no evidence).
 */
export function buildLifecycleBody(
  input: Omit<LifecycleEventInput, 'timestampEvidence'>,
): EventBody {
  const { id, flowguardSessionId, hostSessionId, detail, occurredAt, actor, prevHash, actorInfo } =
    input;
  return {
    id: id ?? crypto.randomUUID(),
    flowguardSessionId,
    ...(hostSessionId ? { hostSessionId } : {}),
    phase: detail.finalPhase,
    event: `lifecycle:${detail.action}`,
    occurredAt,
    actor,
    auditFormatVersion: CURRENT_AUDIT_FORMAT_VERSION,
    ...(actorInfo ? { actorInfo } : {}),
    detail: toDetailRecord({ ...detail, kind: 'lifecycle' }),
    prevHash,
  };
}

/** Fixed namespace reserved for deterministic FlowGuard lifecycle commit IDs. */
const FLOWGUARD_LIFECYCLE_UUID_NAMESPACE = 'd0e4b3a5-33e9-4fab-a851-08a9a9b0d58e';

/**
 * Return the retry-stable commit identity for one terminal transition.
 *
 * UUIDv8 keeps the ID schema-compatible while binding it to the immutable
 * FlowGuard session identity and durable transition operation identity.
 */
export function completionLifecycleEventId(
  flowguardSessionId: string,
  terminalOperationId: string,
): string {
  return uuidV8Sha256(
    `lifecycle:session_completed:${flowguardSessionId}:${terminalOperationId}`,
    FLOWGUARD_LIFECYCLE_UUID_NAMESPACE,
  );
}

/**
 * Derive a custom UUIDv8 from a namespace and name using SHA-256.
 *
 * UUIDv5 is SHA-1 by definition; UUIDv8 reserves this format for the
 * SHA-256 name-based derivation used by FlowGuard.
 */
function uuidV8Sha256(name: string, namespace: string): string {
  const namespaceBytes = Buffer.from(namespace.replaceAll('-', ''), 'hex');
  const digest = crypto.createHash('sha256').update(namespaceBytes).update(name, 'utf8').digest();
  const bytes = digest.subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Create a lifecycle audit event.
 * Emitted on session creation, completion, or abortion.
 */
export function createLifecycleEvent(input: LifecycleEventInput): ChainedAuditEvent {
  return finalizeWithTimestampEvidence(
    buildLifecycleBody(input),
    input.prevHash,
    input.timestampEvidence,
  );
}

/**
 * Input object for createDecisionEvent.
 */
export interface DecisionEventInput {
  readonly flowguardSessionId: string;
  readonly hostSessionId?: string;
  readonly gatePhase: Phase;
  readonly detail: Omit<DecisionDetail, 'kind' | 'gatePhase'>;
  readonly occurredAt: string;
  readonly actor: string;
  readonly prevHash: string;
  readonly actorInfo?: ActorInfo;
  readonly timestampEvidence?: TimestampEvidence;
}

/**
 * Create a decision receipt audit event.
 * One event per successful /review-decision execution.
 */
/**
 * Build a decision event body (no chainHash, no canonical digest, no evidence).
 */
export function buildDecisionBody(input: Omit<DecisionEventInput, 'timestampEvidence'>): EventBody {
  const {
    flowguardSessionId,
    hostSessionId,
    gatePhase,
    detail,
    occurredAt,
    actor,
    prevHash,
    actorInfo,
  } = input;
  return {
    id: crypto.randomUUID(),
    flowguardSessionId,
    ...(hostSessionId ? { hostSessionId } : {}),
    phase: gatePhase,
    event: `decision:${detail.decisionId}`,
    occurredAt,
    actor,
    auditFormatVersion: CURRENT_AUDIT_FORMAT_VERSION,
    ...(actorInfo ? { actorInfo } : {}),
    detail: toDetailRecord({ ...detail, gatePhase, kind: 'decision' }),
    prevHash,
  };
}

/**
 * Create a decision receipt audit event.
 * One event per successful /review-decision execution.
 */
export function createDecisionEvent(input: DecisionEventInput): ChainedAuditEvent {
  return finalizeWithTimestampEvidence(
    buildDecisionBody(input),
    input.prevHash,
    input.timestampEvidence,
  );
}

// ─── Arg Summarizer ───────────────────────────────────────────────────────────

// Extracted to audit/arg-summary.ts (file-size budget); re-exported here so
// existing consumers keep importing from the canonical audit types module.
export { summarizeArgs } from './arg-summary.js';
