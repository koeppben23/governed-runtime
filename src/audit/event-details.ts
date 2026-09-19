/**
 * @module audit/event-details
 * @description Typed detail payloads for every audit event kind.
 *
 * The base AuditEvent schema stores generic `event` and `detail` fields; this
 * module adds the semantic structure of the `detail` payload per kind. The
 * payloads are widened to `Record<string, unknown>` only at the factory
 * boundary (`audit/event-builders.ts`).
 *
 * @version v1
 */

import type { Phase, Event } from '../state/schema.js';
import type { ReviewVerdict } from '../state/evidence.js';
import type { DecisionIdentity } from '../state/evidence-identity.js';

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
  decisionIdentity: DecisionIdentity;
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
