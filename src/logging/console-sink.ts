/**
 * @module logging/console-sink
 * @description Console-based logging sink for FlowGuard.
 *
 * Writes structured log entries to stderr (warn/error) or stdout (debug/info).
 * Useful for CLI contexts, CI, and development.
 *
 * Design:
 * - Formats each entry as: [LEVEL] service: message {extra}
 * - Writes to stderr for warn/error, stdout for debug/info
 * - Non-blocking: errors are swallowed; logging never affects governance flow
 *
 * FlowGuard operational logs are diagnostic only. They are not audit evidence
 * and are not part of the governance SSOT.
 *
 * @version v1
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

      if (entry.level === 'warn' || entry.level === 'error') {
        process.stderr.write(line);
      } else {
        process.stdout.write(line);
      }
    } catch {
      // Non-blocking — console errors never fail the flow
    }
  };
}
