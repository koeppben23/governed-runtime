/**
 * @module telemetry/human-projection
 * @description Non-authoritative Human Projection UX telemetry subsystem.
 *
 * Downstream observer of typed presentation behavior. Never governance,
 * never proof, never policy, never workflow state.
 *
 * @version v1
 */

export type {
  HumanProjectionTelemetryEvent,
  HumanProjectionTelemetryEnvelope,
  PresentationRenderedEvent,
  ActionPresentedEvent,
  ActionInvokedEvent,
  ActionInvocationDisposition,
  DetailRequestedEvent,
} from './events.js';

export type { HumanProjectionTelemetrySink } from './sink.js';
export {
  getHumanProjectionTelemetrySink,
  setHumanProjectionTelemetrySink,
  resetHumanProjectionTelemetrySink,
  initHumanProjectionTelemetrySink,
} from './sink.js';

export { emitTelemetryEvent } from './emitter.js';
export type { TelemetryEventBody } from './emitter.js';
