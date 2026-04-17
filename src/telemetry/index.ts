/**
 * @module telemetry
 * @description OpenTelemetry instrumentation for FlowGuard.
 *
 * Design:
 * - OTEL SDK is initialized ONCE at module load when OTEL_EXPORTER_OTLP_ENDPOINT is set.
 * - The tracer wraps key operations (workspace, audit, discovery, archive).
 * - When no OTEL endpoint is configured, the SDK is never loaded (zero overhead).
 * - All span operations are no-ops when no active span context exists.
 *
 * Enterprise integration:
 *   Set OTEL_EXPORTER_OTLP_ENDPOINT=https://your-collector:4318
 *   Set OTEL_SERVICE_NAME=flowguard
 *   Set OTEL_RESOURCE_ATTRIBUTES=deployment.environment=production
 *
 * @version v1
 */

import { createRequire } from 'node:module';
import type { Tracer, Span, SpanStatusCode } from '@opentelemetry/api';

const _require = createRequire(import.meta.url);

export type { Span, SpanStatusCode };

let tracer: Tracer | null = null;
let sdkInitialized = false;

/**
 * Initialize the OpenTelemetry SDK.
 *
 * Called automatically on first access if OTEL_EXPORTER_OTLP_ENDPOINT is set.
 * Safe to call multiple times (idempotent).
 */
async function ensureInitialized(): Promise<void> {
  if (sdkInitialized) return;

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return;

  try {
    const [{ trace }, { OTLPTraceExporter }, { getNodeAutoInstrumentations }, { NodeSDK }] =
      await Promise.all([
        import('@opentelemetry/api'),
        import('@opentelemetry/exporter-trace-otlp-http'),
        import('@opentelemetry/auto-instrumentations-node'),
        import('@opentelemetry/sdk-node'),
      ]);

    const serviceName = process.env.OTEL_SERVICE_NAME ?? 'flowguard';

    const sdk = new NodeSDK({
      serviceName,
      traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
      instrumentations: [
        getNodeAutoInstrumentations({
          '@opentelemetry/instrumentation-fs': { enabled: false },
        }),
      ],
    });

    sdk.start();
    sdkInitialized = true;
    tracer = trace.getTracer(serviceName, '1.0.0');
  } catch {
    sdkInitialized = true;
  }
}

/**
 * Get the FlowGuard tracer.
 *
 * Returns a noop tracer when OTEL is not configured.
 */
async function getTracer(): Promise<Tracer> {
  await ensureInitialized();
  if (tracer) return tracer;

  const { trace } = await import('@opentelemetry/api');
  return trace.getTracer('flowguard', '1.0.0');
}

/**
 * Create a span wrapping an async operation.
 *
 * Attributes:
 *   - flowguard.operation: operation name
 *   - flowguard.fingerprint: workspace fingerprint (if provided)
 *   - flowguard.session_id: session ID (if provided)
 *
 * @param operation - Semantic operation name (e.g. "workspace.readState").
 * @param fn - Async function to wrap.
 * @param attrs - Optional span attributes.
 */
export async function withSpan<T>(
  operation: string,
  fn: () => Promise<T>,
  attrs?: Record<string, string | number | boolean>,
): Promise<T> {
  const t = await getTracer();
  return t.startActiveSpan(
    operation,
    { attributes: buildAttributes(operation, attrs) },
    async (span: Span) => {
      try {
        const result = await fn();
        span.setStatus({ code: 1 satisfies SpanStatusCode });
        return result;
      } catch (err) {
        span.setStatus({
          code: 2 satisfies SpanStatusCode,
          message: err instanceof Error ? err.message : String(err),
        });
        span.recordException(err instanceof Error ? err : new Error(String(err)));
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

/**
 * Create a span wrapping a sync operation.
 *
 * @param operation - Semantic operation name.
 * @param fn - Sync function to wrap.
 * @param attrs - Optional span attributes.
 */
export function withSpanSync<T>(
  operation: string,
  fn: () => T,
  attrs?: Record<string, string | number | boolean>,
): T {
  let span: Span | undefined;

  try {
    const t = getTracerSync();
    span = t.startSpan(operation, { attributes: buildAttributes(operation, attrs) });
  } catch {
    // Noop tracer — no SDK loaded
  }

  try {
    const result = fn();
    if (span) span.setStatus({ code: 1 satisfies SpanStatusCode });
    return result;
  } catch (err) {
    if (span) {
      span.setStatus({
        code: 2 satisfies SpanStatusCode,
        message: err instanceof Error ? err.message : String(err),
      });
      span.recordException(err instanceof Error ? err : new Error(String(err)));
    }
    throw err;
  } finally {
    if (span) span.end();
  }
}

function getTracerSync(): Tracer {
  if (tracer) return tracer;
  const { trace } = _require('@opentelemetry/api');
  return trace.getTracer('flowguard', '1.0.0');
}

function buildAttributes(
  operation: string,
  extra?: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  return {
    'flowguard.operation': operation,
    ...extra,
  };
}

/**
 * Add a fingerprint attribute to the current span (if active).
 *
 * @param fingerprint - Workspace fingerprint.
 */
export function addFingerprint(fingerprint: string): void {
  const span = getActiveSpan();
  if (span) span.setAttribute('flowguard.fingerprint', fingerprint);
}

/**
 * Add a session ID attribute to the current span (if active).
 *
 * @param sessionId - Session ID.
 */
export function addSessionId(sessionId: string): void {
  const span = getActiveSpan();
  if (span) span.setAttribute('flowguard.session_id', sessionId);
}

/**
 * Add a policy mode attribute to the current span (if active).
 *
 * @param mode - Policy mode.
 */
export function addPolicyMode(mode: string): void {
  const span = getActiveSpan();
  if (span) span.setAttribute('flowguard.policy_mode', mode);
}

/** Get the currently active span, if any. */
function getActiveSpan(): Span | null {
  try {
    const { trace } = _require('@opentelemetry/api');
    return trace.getActiveSpan() ?? null;
  } catch {
    return null;
  }
}
