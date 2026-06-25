/**
 * @module logging
 * @description Barrel export for FlowGuard logging.
 *
 * @version v2
 */

export {
  type FlowGuardLogger,
  type LogEntry,
  type LogSink,
  createLogger,
  createNoopLogger,
} from './logger.js';

export { createFileSink, getLogDir } from './file-sink.js';
export { createConsoleSink } from './console-sink.js';
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
