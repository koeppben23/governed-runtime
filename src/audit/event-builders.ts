/**
 * @module audit/event-builders
 * @description Body builders and factory functions that produce valid
 * audit-chain.v3 events. Callers never hand-craft audit events.
 *
 * Every builder returns a semantic EventBody (no chainHash, no canonical
 * digest, no timestamp evidence); the `create*Event` factories finalize the
 * body with {@link finalizeWithTimestampEvidence}. All factories require
 * `prevHash` for chain integrity (set to "genesis" for the first event).
 *
 * @version v1
 */

import * as crypto from 'node:crypto';
import { hashDigestBytes } from '../shared/hashing.js';
import type { Phase } from '../state/schema.js';
import type { ActorInfo, TimestampEvidence } from '../state/evidence.js';
import {
  CURRENT_AUDIT_FORMAT_VERSION,
  ENFORCEMENT_DENIED_EVENT_NAME,
  STATE_WRITE_EVENT_NAME,
  finalizeWithTimestampEvidence,
  type ChainedAuditEvent,
  type EventBody,
} from './event-core.js';
import type {
  DecisionDetail,
  EnforcementDeniedDetail,
  ErrorDetail,
  LifecycleDetail,
  StateWriteDetail,
  ToolCallDetail,
  TransitionDetail,
  TypedDetail,
} from './event-details.js';

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

/** Shared body-input shape; the detail payload is specific to each body builder. */
interface AuditBodyInput<D> extends Omit<TransitionEventInput, 'timestampEvidence' | 'detail'> {
  readonly detail: D;
}

/** Input object for buildTransitionBody. */
export type TransitionBodyInput = AuditBodyInput<Omit<TransitionDetail, 'kind'>>;

/**
 * Build a transition event body (no chainHash, no canonical digest, no evidence).
 */
export function buildTransitionBody(input: TransitionBodyInput): EventBody {
  const { flowguardSessionId, hostSessionId, phase, detail, occurredAt, prevHash } = input;
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

/** Input object for buildStateWriteBody. */
export type StateWriteBodyInput = AuditBodyInput<Omit<StateWriteDetail, 'kind'>>;

/** Build a state-write event body from a durable outbox operation. */
export function buildStateWriteBody(input: StateWriteBodyInput): EventBody {
  const { flowguardSessionId, hostSessionId, phase, detail, occurredAt, prevHash } = input;
  return {
    id: detail.operationId,
    flowguardSessionId,
    ...(hostSessionId ? { hostSessionId } : {}),
    phase,
    event: STATE_WRITE_EVENT_NAME,
    occurredAt,
    actor: 'machine',
    auditFormatVersion: CURRENT_AUDIT_FORMAT_VERSION,
    detail: toDetailRecord({ ...detail, kind: 'state_write' }),
    prevHash,
  };
}

/** Input object for buildEnforcementDeniedBody. */
export type EnforcementDeniedBodyInput = AuditBodyInput<Omit<EnforcementDeniedDetail, 'kind'>>;

/** Build a denied-enforcement event body from the synchronous host hook. */
export function buildEnforcementDeniedBody(input: EnforcementDeniedBodyInput): EventBody {
  const { flowguardSessionId, hostSessionId, phase, detail, occurredAt, prevHash } = input;
  return {
    id: crypto.randomUUID(),
    flowguardSessionId,
    ...(hostSessionId ? { hostSessionId } : {}),
    phase,
    event: ENFORCEMENT_DENIED_EVENT_NAME,
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
  readonly hostSessionId?: string | undefined;
  readonly phase: Phase;
  readonly detail: Omit<TransitionDetail, 'kind'>;
  readonly occurredAt: string;
  readonly prevHash: string;
  readonly timestampEvidence?: TimestampEvidence | undefined;
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
    buildTransitionBody({
      flowguardSessionId: input.flowguardSessionId,
      hostSessionId: input.hostSessionId,
      phase: input.phase,
      detail: input.detail,
      occurredAt: input.occurredAt,
      prevHash: input.prevHash,
    }),
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

/** Input object for createErrorEvent. */
export interface ErrorEventInput {
  readonly flowguardSessionId: string;
  readonly hostSessionId?: string | undefined;
  readonly detail: Omit<ErrorDetail, 'kind'>;
  readonly occurredAt: string;
  readonly prevHash: string;
  readonly timestampEvidence?: TimestampEvidence | undefined;
}

/**
 * Create an error audit event.
 * Emitted when the state machine enters an error state.
 */
export function createErrorEvent(input: ErrorEventInput): ChainedAuditEvent {
  return finalizeWithTimestampEvidence(
    buildErrorBody(
      input.flowguardSessionId,
      input.hostSessionId,
      input.detail,
      input.occurredAt,
      input.prevHash,
    ),
    input.prevHash,
    input.timestampEvidence,
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
  const digest = hashDigestBytes(
    'sha256',
    Buffer.concat([namespaceBytes, Buffer.from(name, 'utf8')]),
  );
  const bytes = digest.subarray(0, 16);
  bytes[6] = (bytes.readUInt8(6) & 0x0f) | 0x80;
  bytes[8] = (bytes.readUInt8(8) & 0x3f) | 0x80;
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
