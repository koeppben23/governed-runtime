/**
 * @module logging
 * @description Barrel export for FlowGuard logging.
 *
 * @version v1
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
