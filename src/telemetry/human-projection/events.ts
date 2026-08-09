/**
 * @module telemetry/human-projection/events
 * @description Typed Human Projection telemetry event contracts.
 *
 * Every event observes rendered presentation behavior. Events are
 * non-authoritative downstream observations — they never participate
 * in governance, workflow, proof, approval, or policy decisions.
 *
 * Privacy invariant: event payloads must never contain repository content,
 * claim text, finding messages, user prompts, Markdown, or free-form
 * user-owned content. All dimensions are low-cardinality typed identifiers.
 *
 * @version v1
 */

import type { PresentationForm } from '../../presentation/model.js';
import type { PresentationDetailLevel } from '../../presentation/model.js';
import type { ActionIntent } from '../../presentation/action-intent.js';
import type { PresentationAction } from '../../presentation/model.js';

/** Shared envelope for all Human Projection telemetry events. */
export interface HumanProjectionTelemetryEnvelope {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly occurredAt: string;
  readonly sessionId?: string;
  readonly phase?: string;
}

/** A PresentationDocument was rendered to the user. */
export interface PresentationRenderedEvent extends HumanProjectionTelemetryEnvelope {
  readonly event: 'presentation_rendered';
  readonly documentKind: 'compact_card' | 'review_card' | 'diagnostic_card';
  readonly form?: PresentationForm;
  readonly detailLevel?: PresentationDetailLevel;
  readonly conclusionKind?: string;
}

/** A structured PresentationAction was shown to the user. */
export interface ActionPresentedEvent extends HumanProjectionTelemetryEnvelope {
  readonly event: 'action_presented';
  readonly intent?: ActionIntent;
  readonly visibility: PresentationAction['visibility'];
  readonly conclusionKind: 'next_action' | 'decision_required';
}

/** Action invocation disposition — mechanically precise. */
export type ActionInvocationDisposition = 'entered' | 'blocked' | 'failed';

/** A user/host invoked a tool corresponding to a FlowGuard action. */
export interface ActionInvokedEvent extends HumanProjectionTelemetryEnvelope {
  readonly event: 'action_invoked';
  readonly intent?: ActionIntent;
  readonly disposition: ActionInvocationDisposition;
}

/** The user transitioned to a different surface detail level. */
export interface DetailRequestedEvent extends HumanProjectionTelemetryEnvelope {
  readonly event: 'detail_requested';
  readonly from: PresentationDetailLevel;
  readonly to: PresentationDetailLevel;
  readonly surface: 'status' | 'why' | 'review';
}

/** All Human Projection telemetry events. */
export type HumanProjectionTelemetryEvent =
  PresentationRenderedEvent | ActionPresentedEvent | ActionInvokedEvent | DetailRequestedEvent;
