/**
 * @module telemetry/human-projection/emitter
 * @description Best-effort telemetry emission helpers.
 *
 * Every emit function is non-blocking and must never replace, mask, or
 * alter the canonical FlowGuard result. Telemetry failure is silently
 * recorded to diagnostics but never surfaced as a workflow error.
 *
 * @version v1
 */

import { getHumanProjectionTelemetrySink } from './sink.js';
import type { HumanProjectionTelemetryEvent } from './events.js';

function uuid(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

/**
 * Emit a telemetry event best-effort.
 * Never throws to the caller — the caller's canonical result must remain
 * intact regardless of telemetry success or failure.
 */
export function emitTelemetryEvent(
  partialEvent: Record<string, unknown>,
  sessionId?: string,
  phase?: string,
): void {
  try {
    const sink = getHumanProjectionTelemetrySink();
    const full: HumanProjectionTelemetryEvent = {
      schemaVersion: 1,
      eventId: uuid(),
      occurredAt: now(),
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(phase !== undefined ? { phase } : {}),
      ...partialEvent,
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
