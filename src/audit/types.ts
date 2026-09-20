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
 * This module is the canonical import surface: the implementation is split along
 * cohesive boundaries into `event-core` (schema + hash + finalization),
 * `event-details` (typed payloads), and `event-builders` (body builders and
 * factories), and re-exported here so existing consumers keep one import path.
 *
 * @version v2
 */

// ─── Event Kind, Schema, Hash, Finalization ──────────────────────────────────

export {
  AUDIT_EVENT_KINDS,
  STATE_WRITE_EVENT_NAME,
  ENFORCEMENT_DENIED_EVENT_NAME,
  CURRENT_AUDIT_FORMAT_VERSION,
  GENESIS_HASH,
  computeChainHash,
  finalizeWithTimestampEvidence,
  type AuditEventKind,
  type AuditFormatVersion,
  type ChainedAuditEvent,
  type EventBody,
} from './event-core.js';

// ─── Typed Detail Payloads ────────────────────────────────────────────────────

export type {
  TransitionDetail,
  StateWriteDetail,
  EnforcementDeniedDetail,
  ToolCallDetail,
  ErrorDetail,
  LifecycleDetail,
  DecisionDetail,
  TypedDetail,
} from './event-details.js';

// ─── Body Builders & Factories ────────────────────────────────────────────────

export {
  buildTransitionBody,
  buildStateWriteBody,
  buildEnforcementDeniedBody,
  buildToolCallBody,
  buildErrorBody,
  buildLifecycleBody,
  buildDecisionBody,
  createTransitionEvent,
  createToolCallEvent,
  createErrorEvent,
  createLifecycleEvent,
  createDecisionEvent,
  completionLifecycleEventId,
  type TransitionBodyInput,
  type StateWriteBodyInput,
  type EnforcementDeniedBodyInput,
  type TransitionEventInput,
  type ToolCallEventInput,
  type ErrorEventInput,
  type LifecycleEventInput,
  type DecisionEventInput,
} from './event-builders.js';

// ─── Arg Summarizer ───────────────────────────────────────────────────────────

// Extracted to audit/arg-summary.ts (file-size budget); re-exported here so
// existing consumers keep importing from the canonical audit types module.
export { summarizeArgs } from './arg-summary.js';
