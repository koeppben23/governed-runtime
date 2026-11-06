/**
 * @module telemetry/human-projection/sink
 * @description Telemetry sink abstraction and no-op default.
 *
 * Instrumentation code interacts only with this interface. The
 * default no-op sink ensures telemetry-disabled is behaviorally
 * invisible.
 *
 * @version v1
 */

import type { HumanProjectionTelemetryEvent } from './events.js';

export interface HumanProjectionTelemetrySink {
  record(event: HumanProjectionTelemetryEvent): void | Promise<void>;
}

/** No-op sink: telemetry disabled → zero behavioral impact. */
const NOOP_SINK: HumanProjectionTelemetrySink = {
  record(): void {
    /* intentionally empty — telemetry is disabled */
  },
};

let currentSink: HumanProjectionTelemetrySink = NOOP_SINK;

/** Get the currently active telemetry sink. */
export function getHumanProjectionTelemetrySink(): HumanProjectionTelemetrySink {
  return currentSink;
}

/** Set the active telemetry sink. Pass NOOP_SINK to disable. */
export function setHumanProjectionTelemetrySink(sink: HumanProjectionTelemetrySink): void {
  currentSink = sink;
}

/** Reset to the default no-op sink (e.g. on config change or session close). */
export function resetHumanProjectionTelemetrySink(): void {
  currentSink = NOOP_SINK;
}
