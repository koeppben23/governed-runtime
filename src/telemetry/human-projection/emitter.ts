/**
 * @module telemetry/human-projection/emitter
 * @description Best-effort telemetry emission helpers.
 *
 * Every emit function is non-blocking and must never replace, mask, or
 * alter the canonical FlowGuard result. Telemetry failure is silently
 * recorded to diagnostics but never surfaced as a workflow error.
 *
 * The emitter assigns all envelope fields (schemaVersion, eventId,
 * occurredAt, sessionId, phase). Callers provide only the event-specific
 * body — they can never override host-authoritative envelope fields.
 *
 * @version v2
 */

import { getHumanProjectionTelemetrySink } from './sink.js';
import type {
  HumanProjectionTelemetryEvent,
  HumanProjectionTelemetryEnvelope,
  PresentationRenderedEvent,
  ActionPresentedEvent,
  ActionInvokedEvent,
  DetailRequestedEvent,
} from './events.js';

type PresentationRenderedBody = Omit<
  PresentationRenderedEvent,
  keyof HumanProjectionTelemetryEnvelope
>;
type ActionPresentedBody = Omit<ActionPresentedEvent, keyof HumanProjectionTelemetryEnvelope>;
type ActionInvokedBody = Omit<ActionInvokedEvent, keyof HumanProjectionTelemetryEnvelope>;
type DetailRequestedBody = Omit<DetailRequestedEvent, keyof HumanProjectionTelemetryEnvelope>;

/** Caller-provided event content — never includes envelope fields. */
export type TelemetryEventBody =
  PresentationRenderedBody | ActionPresentedBody | ActionInvokedBody | DetailRequestedBody;

function uuid(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

/**
 * Emit a telemetry event best-effort.
 *
 * The emitter assigns schemaVersion, eventId, occurredAt, sessionId, and
 * phase — the caller's body cannot override these host-authoritative fields.
 * Never throws; never replaces the canonical FlowGuard result.
 */
export function emitTelemetryEvent(
  body: TelemetryEventBody,
  sessionId?: string,
  phase?: string,
): void {
  try {
    const sink = getHumanProjectionTelemetrySink();
    const envelope: HumanProjectionTelemetryEnvelope = {
      schemaVersion: 1,
      eventId: uuid(),
      occurredAt: now(),
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(phase !== undefined ? { phase } : {}),
    };
    const full: HumanProjectionTelemetryEvent = {
      ...body,
      ...envelope,
    } as HumanProjectionTelemetryEvent;
    const result = sink.record(full);
    if (result instanceof Promise) {
      result.catch(() => {
        /* telemetry persistence failure — intentionally silent */
      });
    }
  } catch {
    /* telemetry failure is explicitly non-blocking */
  }
}
