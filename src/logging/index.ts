/**
 * @module logging
 * @description Barrel export for FlowGuard logging.
 *
 * @version v2
 */

export {
  type FlowGuardLogger,
  type HealthAwareLogger,
  type DynamicLogger,
  type LoggerHealth,
  type LoggerConfig,
  type LogEntry,
  type LogSink,
  createLogger,
  createNoopLogger,
} from './logger.js';
export {
  createLevelReloader,
  sigusr1Registrar,
  type SignalRegistrar,
  type LevelReloader,
} from './level-reloader.js';

export { createFileSink, getLogDir, type FileSinkOptions } from './file-sink.js';
export { createConsoleSink, type ConsoleSinkOptions } from './console-sink.js';
export { createOtlpLogSink, type OtlpSinkHandle, type OtlpSinkOptions } from './otlp-sink.js';
export {
  logAudit,
  logEnforcement,
  logEnforcementDebug,
  logHook,
  logOrchestrator,
  type AuditLogExtra,
  type EnforcementLogExtra,
  type HookLogExtra,
  type OrchestratorLogExtra,
} from './log-extras.js';
export {
  setAdapterLogger,
  getAdapterLogger,
  resetAdapterLogger,
  runWithAdapterLogger,
  runWithAdapterLoggerAsync,
  runWithTraceContext,
  runWithTraceContextAsync,
  getTraceContext,
  getLogTraceFields,
  toAdapterLogger,
  type AdapterLogger,
  type TraceContext,
} from './adapter-logger.js';
export {
  runWithLogContext,
  runWithLogContextAsync,
  getLogContext,
  type LogContext,
} from './log-context.js';
export { serializeError, type SerializedError } from './error-serialize.js';
export { sanitizeDiagnosticString } from './redact.js';
