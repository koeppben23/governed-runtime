/**
 * @module logging/console-sink
 * @description Console-based logging sink for FlowGuard.
 *
 * Writes structured log entries to stderr. All levels route to stderr
 * to keep stdout clean for CLI user output and machine-readable data.
 *
 * Design:
 * - Text mode: [TIMESTAMP] [LEVEL] [trace/session] service: message {extra}
 * - JSON mode: JSON.stringify(entry) + '\n' (for container log aggregators)
 * - All output to stderr (industry standard for diagnostic logs)
 * - Non-blocking: errors are swallowed; logging never affects governance flow
 *
 * FlowGuard operational logs are diagnostic only. They are not audit evidence
 * and are not part of the governance SSOT.
 *
 * @version v3
 */

import type { LogEntry, LogSink } from './logger.js';

/**
 * Escape control characters (newlines, carriage returns, tabs, ANSI escapes,
 * other C0 controls) so a crafted message cannot inject a forged log line or
 * emit raw terminal escape sequences in text mode. JSON mode is already safe
 * because JSON.stringify escapes these.
 */
function escapeControlChars(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      out += `\\x${code.toString(16).padStart(2, '0')}`;
    } else {
      out += s[i];
    }
  }
  return out;
}

/**
 * Console sink options.
 */
export interface ConsoleSinkOptions {
  /** Output format. 'text' is the backward-compatible default. */
  format?: 'text' | 'json';
}

/**
 * Create a console-based logging sink.
 *
 * @param options - Optional format configuration (defaults to 'text').
 * @returns LogSink function.
 */
export function createConsoleSink(options?: ConsoleSinkOptions): LogSink {
  const fmt = options?.format ?? 'text';

  return (entry: LogEntry): void => {
    try {
      if (fmt === 'json') {
        process.stderr.write(JSON.stringify(entry) + '\n');
      } else {
        const ts = new Date().toISOString();
        const ids = [entry.traceId?.slice(0, 8), entry.sessionId].filter(Boolean).join('/');
        const idStr = ids ? `[${ids}] ` : '';
        const extraStr = entry.extra ? ` ${JSON.stringify(entry.extra)}` : '';
        const line = `[${ts}] [${entry.level.toUpperCase()}] ${idStr}${entry.service}: ${escapeControlChars(entry.message)}${extraStr}\n`;
        process.stderr.write(line);
      }
    } catch {
      // Non-blocking — console errors never fail the flow
    }
  };
}
