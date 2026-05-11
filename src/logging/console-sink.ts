/**
 * @module logging/console-sink
 * @description Console-based logging sink for FlowGuard.
 *
 * Writes structured log entries to stderr. All levels route to stderr
 * to keep stdout clean for CLI user output and machine-readable data.
 *
 * Design:
 * - Formats each entry as: [TIMESTAMP] [LEVEL] service: message {extra}
 * - All output to stderr (industry standard for diagnostic logs)
 * - Non-blocking: errors are swallowed; logging never affects governance flow
 *
 * FlowGuard operational logs are diagnostic only. They are not audit evidence
 * and are not part of the governance SSOT.
 *
 * @version v2
 */

import type { LogEntry, LogSink } from './logger.js';

/**
 * Create a console-based logging sink.
 *
 * @returns LogSink function.
 */
export function createConsoleSink(): LogSink {
  return (entry: LogEntry): void => {
    try {
      const ts = new Date().toISOString();
      const extraStr = entry.extra ? ` ${JSON.stringify(entry.extra)}` : '';
      const line = `[${ts}] [${entry.level.toUpperCase()}] ${entry.service}: ${entry.message}${extraStr}\n`;

      process.stderr.write(line);
    } catch {
      // Non-blocking — console errors never fail the flow
    }
  };
}
