/**
 * @module logging/otlp-sink
 * @description OTLP log exporter sink for FlowGuard diagnostic logs.
 *
 * Exports structured FlowGuard log entries via OpenTelemetry Logs API
 * to a configured OTLP endpoint (HTTP). Uses an isolated LoggerProvider
 * to avoid mutating global OpenTelemetry state.
 *
 * Design:
 * - Lazy init on first write — zero cost when disabled.
 * - Isolated LoggerProvider + BatchLogRecordProcessor + OTLPLogExporter.
 * - Severity mapping: debug→TRACE, info→INFO, warn→WARN, error→ERROR.
 * - Attributes include service, level, traceId, sessionId, and redacted
 *   extra_json.
 * - Export failures are non-blocking and reported via onFailure callback.
 * - The sink always resolves — no Promise rejections to createLogger.
 *
 * Dependencies (lazy dynamic-import; listed as optionalDependencies so they are
 * not required for default/offline operation):
 *   @opentelemetry/sdk-logs
 *   @opentelemetry/exporter-logs-otlp-http
 *
 * FlowGuard operational logs are diagnostic only. They are not audit evidence
 * and are not part of the governance SSOT.
 *
 * @version v1
 */

import type { LogEntry, LogSink } from './logger.js';
import { sanitizeDiagnosticString } from './redact.js';

interface OtlpLogger {
  emit(record: {
    severityNumber: number;
    severityText: LogEntry['level'];
    body: string;
    attributes: Record<string, string>;
  }): void;
}

interface OtlpProvider {
  getLogger(name: string, version?: string): OtlpLogger;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

type LoggerProviderConstructor = new (config: { processors: unknown[] }) => OtlpProvider;

type BatchLogRecordProcessorConstructor = new (exporter: unknown) => unknown;
type OtlpLogExporterConstructor = new (config: { url: string }) => unknown;

interface SdkLogsModule {
  LoggerProvider: LoggerProviderConstructor;
  BatchLogRecordProcessor: BatchLogRecordProcessorConstructor;
}

interface OtlpExporterModule {
  OTLPLogExporter: OtlpLogExporterConstructor;
}

type OtlpModuleImporter = (specifier: string) => Promise<unknown>;

const SEVERITY_MAP: Record<string, number> = {
  debug: 1, // TRACE
  info: 9, // INFO
  warn: 13, // WARN
  error: 17, // ERROR
};

/** OTLP log exporter sink options. */
export interface OtlpSinkOptions {
  /** OTLP endpoint URL. Required — caller must validate. */
  endpoint: string;
  /** Called on emit or lazy-init errors detectable at the sink boundary.
   *  Batch export failures are handled internally by the OTEL SDK and
   *  are NOT observable through this callback in this slice. */
  onFailure?: (error: unknown) => void;
  /** @internal dynamic import override for deterministic tests. */
  _import?: OtlpModuleImporter;
}

/**
 * OTLP sink handle: the sink function plus a reachable lifecycle surface.
 *
 * `flush()` forces the BatchLogRecordProcessor to export buffered records.
 * `shutdown()` flushes and releases the provider + its internal timer.
 * Both are idempotent and always resolve (errors are reported via onFailure).
 */
export interface OtlpSinkHandle {
  sink: LogSink;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

/** Mutable state shared by the OTLP sink's module-scope helpers. */
interface OtlpSinkState {
  readonly endpoint: string;
  readonly onFailure: OtlpSinkOptions['onFailure'];
  readonly importModule: OtlpModuleImporter;
  initialized: boolean;
  initErrLogged: boolean;
  shutdown: boolean;
  // Lazy-initialised OTEL references. The provider is RETAINED (not discarded)
  // so flush()/shutdown() can reach BatchLogRecordProcessor — otherwise batched
  // records are silently lost on process exit and the timer leaks.
  provider: OtlpProvider | null;
  logger: OtlpLogger | null;
}

async function ensureOtlpLogger(state: OtlpSinkState): Promise<boolean> {
  if (state.initialized) return state.logger !== null;
  state.initialized = true;
  if (state.shutdown) return false;

  try {
    const [sdkLogsMod, exporterMod] = (await Promise.all([
      state.importModule('@opentelemetry/sdk-logs'),
      state.importModule('@opentelemetry/exporter-logs-otlp-http'),
    ])) as [SdkLogsModule, OtlpExporterModule];

    const { LoggerProvider, BatchLogRecordProcessor } = sdkLogsMod;
    const { OTLPLogExporter } = exporterMod;

    state.provider = new LoggerProvider({
      processors: [new BatchLogRecordProcessor(new OTLPLogExporter({ url: state.endpoint }))],
    });

    state.logger = state.provider.getLogger('flowguard', '1.0.0');

    return true;
  } catch (err) {
    if (!state.initErrLogged) {
      state.initErrLogged = true;
      process.stderr.write(
        `[FlowGuard] OTLP log export init failed: ` +
          `${sanitizeDiagnosticString(err instanceof Error ? err.message : String(err))}\n`,
      );
    }
    return false;
  }
}

function mapSeverity(level: LogEntry['level']): number {
  return SEVERITY_MAP[level] ?? 9; // default: INFO
}

function emitOtlpEntry(logger: OtlpLogger, entry: LogEntry): void {
  logger.emit({
    severityNumber: mapSeverity(entry.level),
    severityText: entry.level,
    body: sanitizeDiagnosticString(entry.message),
    attributes: {
      'flowguard.service': entry.service,
      'flowguard.level': entry.level,
      'flowguard.traceId': entry.traceId ?? '',
      'flowguard.sessionId': entry.sessionId ?? '',
      'flowguard.extra_json': sanitizeDiagnosticString(JSON.stringify(entry.extra ?? {})),
    },
  });
}

async function flushOtlpProvider(state: OtlpSinkState): Promise<void> {
  if (!state.provider) return;
  try {
    await state.provider.forceFlush();
  } catch (err) {
    state.onFailure?.(err);
  }
}

async function shutdownOtlpProvider(state: OtlpSinkState): Promise<void> {
  if (state.shutdown) return;
  state.shutdown = true;
  if (!state.provider) return;
  try {
    await state.provider.shutdown();
  } catch (err) {
    state.onFailure?.(err);
  } finally {
    state.provider = null;
    state.logger = null;
  }
}

/**
 * Create an OTLP log exporter sink.
 *
 * Lazy-initialises the OpenTelemetry Logs SDK on the first write.
 * Uses an isolated LoggerProvider — does not call setGlobalLoggerProvider().
 *
 * @param options - Endpoint and optional callbacks.
 * @returns OtlpSinkHandle: the sink (always resolves) plus flush/shutdown.
 */
export function createOtlpLogSink(options: OtlpSinkOptions): OtlpSinkHandle {
  const state: OtlpSinkState = {
    endpoint: options.endpoint,
    onFailure: options.onFailure,
    importModule: options._import ?? ((specifier: string) => import(specifier) as Promise<unknown>),
    initialized: false,
    initErrLogged: false,
    shutdown: false,
    provider: null,
    logger: null,
  };

  const sink: LogSink = async (entry: LogEntry): Promise<void> => {
    if (state.shutdown) return;
    const ok = await ensureOtlpLogger(state);
    const logger = state.logger;
    if (!ok || !logger) return;

    try {
      emitOtlpEntry(logger, entry);
    } catch (err) {
      state.onFailure?.(err);
    }
  };

  return {
    sink,
    async flush(): Promise<void> {
      await flushOtlpProvider(state);
    },
    async shutdown(): Promise<void> {
      await shutdownOtlpProvider(state);
    },
  };
}
