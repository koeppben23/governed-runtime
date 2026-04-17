/**
 * @module audit/types
 * @description Structured audit event types, kinds, and factory functions.
 *
 * The base AuditEvent schema (evidence.ts) stores generic `event` and `detail` fields.
 * This module adds semantic structure:
 * - Closed set of event kinds (transition, tool_call, error, lifecycle)
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
import type { Phase, Event } from '../state/schema';
import type { ReviewVerdict } from '../state/evidence';

// ─── Event Kind ───────────────────────────────────────────────────────────────

/**
 * Closed set of audit event kinds.
 * Each kind has a specific detail payload structure.
 */
export type AuditEventKind = 'transition' | 'tool_call' | 'error' | 'lifecycle' | 'decision';

// ─── Detail Payloads (typed, but stored as Record<string, unknown>) ──────────

/** Detail payload for transition events. */
export interface TransitionDetail {
  kind: 'transition';
  from: Phase;
  to: Phase;
  event: Event;
  /** Whether this transition was part of an autoAdvance chain. */
  autoAdvanced: boolean;
  /** Position in the autoAdvance chain (0-based). -1 if not auto-advanced. */
  chainIndex: number;
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
  | ToolCallDetail
  | ErrorDetail
  | LifecycleDetail
  | DecisionDetail;

// ─── Audit Event with Chain Hash ─────────────────────────────────────────────

/**
 * Extended audit event with hash chain fields.
 * These fields are added by the factory functions and stored in the JSONL trail.
 *
 * Hash chain integrity:
 * - `prevHash`: hash of the previous event (or "genesis" for the first event)
 * - `chainHash`: SHA-256(prevHash + JSON(this event without chainHash))
 * - To verify: recompute chainHash from prevHash + event data, compare
 */
export interface ChainedAuditEvent {
  readonly id: string;
  readonly sessionId: string;
  readonly phase: string;
  readonly event: string;
  readonly timestamp: string;
  readonly actor: string;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly prevHash: string;
  readonly chainHash: string;
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
  // Create a canonical representation: sorted keys, no whitespace
  const canonical = JSON.stringify(event, Object.keys(event).sort());
  const input = prevHash + canonical;
  return crypto.createHash('sha256').update(input, 'utf-8').digest('hex');
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

/**
 * Create a transition audit event.
 * One event per state machine transition. autoAdvance may produce multiple.
 */
export function createTransitionEvent(
  sessionId: string,
  phase: Phase,
  detail: Omit<TransitionDetail, 'kind'>,
  timestamp: string,
  prevHash: string,
): ChainedAuditEvent {
  const eventName = `transition:${detail.event}`;
  const base: Omit<ChainedAuditEvent, 'chainHash'> = {
    id: crypto.randomUUID(),
    sessionId,
    phase,
    event: eventName,
    timestamp,
    actor: 'machine',
    detail: toDetailRecord({ ...detail, kind: 'transition' }),
    prevHash,
  };
  return { ...base, chainHash: computeChainHash(prevHash, base) };
}

/**
 * Create a tool call audit event.
 * One event per FlowGuard tool invocation.
 */
export function createToolCallEvent(
  sessionId: string,
  phase: string,
  detail: Omit<ToolCallDetail, 'kind'>,
  timestamp: string,
  actor: string,
  prevHash: string,
): ChainedAuditEvent {
  const eventName = `tool_call:${detail.tool}`;
  const base: Omit<ChainedAuditEvent, 'chainHash'> = {
    id: crypto.randomUUID(),
    sessionId,
    phase,
    event: eventName,
    timestamp,
    actor,
    detail: toDetailRecord({ ...detail, kind: 'tool_call' }),
    prevHash,
  };
  return { ...base, chainHash: computeChainHash(prevHash, base) };
}

/**
 * Create an error audit event.
 * Emitted when the state machine enters an error state.
 */
export function createErrorEvent(
  sessionId: string,
  detail: Omit<ErrorDetail, 'kind'>,
  timestamp: string,
  prevHash: string,
): ChainedAuditEvent {
  const eventName = `error:${detail.code}`;
  const base: Omit<ChainedAuditEvent, 'chainHash'> = {
    id: crypto.randomUUID(),
    sessionId,
    phase: detail.errorPhase,
    event: eventName,
    timestamp,
    actor: 'machine',
    detail: toDetailRecord({ ...detail, kind: 'error' }),
    prevHash,
  };
  return { ...base, chainHash: computeChainHash(prevHash, base) };
}

/**
 * Create a lifecycle audit event.
 * Emitted on session creation, completion, or abortion.
 */
export function createLifecycleEvent(
  sessionId: string,
  detail: Omit<LifecycleDetail, 'kind'>,
  timestamp: string,
  actor: string,
  prevHash: string,
): ChainedAuditEvent {
  const eventName = `lifecycle:${detail.action}`;
  const base: Omit<ChainedAuditEvent, 'chainHash'> = {
    id: crypto.randomUUID(),
    sessionId,
    phase: detail.finalPhase,
    event: eventName,
    timestamp,
    actor,
    detail: toDetailRecord({ ...detail, kind: 'lifecycle' }),
    prevHash,
  };
  return { ...base, chainHash: computeChainHash(prevHash, base) };
}

/**
 * Create a decision receipt audit event.
 * One event per successful /review-decision execution.
 */
export function createDecisionEvent(
  sessionId: string,
  gatePhase: Phase,
  detail: Omit<DecisionDetail, 'kind' | 'gatePhase'>,
  timestamp: string,
  actor: string,
  prevHash: string,
): ChainedAuditEvent {
  const eventName = `decision:${detail.decisionId}`;
  const base: Omit<ChainedAuditEvent, 'chainHash'> = {
    id: crypto.randomUUID(),
    sessionId,
    phase: gatePhase,
    event: eventName,
    timestamp,
    actor,
    detail: toDetailRecord({ ...detail, gatePhase, kind: 'decision' }),
    prevHash,
  };
  return { ...base, chainHash: computeChainHash(prevHash, base) };
}

// ─── Arg Summarizer ───────────────────────────────────────────────────────────

/**
 * Summarize tool args for audit (no sensitive data).
 * Only includes keys and scalar values (strings truncated to 100 chars).
 * Objects/arrays are replaced with type indicator.
 */
export function summarizeArgs(args: Record<string, unknown>): Record<string, string> {
  const summary: Record<string, string> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === null || value === undefined) {
      summary[key] = 'null';
    } else if (typeof value === 'string') {
      summary[key] = value.length > 100 ? value.slice(0, 100) + '...' : value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      summary[key] = String(value);
    } else if (Array.isArray(value)) {
      summary[key] = `[Array(${value.length})]`;
    } else {
      summary[key] = '[Object]';
    }
  }
  return summary;
}
