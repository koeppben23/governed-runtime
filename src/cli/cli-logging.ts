/**
 * @module cli/cli-logging
 * @description Structured logging setup for FlowGuard CLI commands.
 *
 * The CLI has no OpenCode plugin context and cannot use `client.app.log()`.
 * It uses standalone file and console sinks to provide structured logging
 * for install, uninstall, doctor, run, and serve operations.
 *
 * **CLI logmode semantics (different from Plugin):**
 * - Plugin config uses `file|ui|both|console|file+console` (ui = OpenCode SDK).
 * - CLI uses `console|file|file+console` (no SDK, no "ui").
 * - Default: `console` (writes to stderr/stdout only).
 * - `setAdapterLogger` is acceptable here as a transitional mechanism because
 *   the CLI is a short-lived process — logger cleanup happens in `try/finally`.
 *
 * @version v2
 */

import { createConsoleSink } from '../logging/console-sink.js';
import { createFileSink } from '../logging/file-sink.js';
import { createLogger, type FlowGuardLogger } from '../logging/logger.js';
import { setAdapterLogger, toAdapterLogger } from '../logging/adapter-logger.js';

export type CliLogMode = 'console' | 'file' | 'file+console';

/**
 * Create and wire a CLI logger.
 *
 * @param targetDir - Installation target directory (or null; file sink needs this).
 * @param mode - Logging mode: console, file, or file+console. Default: console.
 * @returns FlowGuardLogger instance (also stored as adapter logger).
 */
export function initCliLogger(
  targetDir: string | null,
  mode: CliLogMode = 'console',
): FlowGuardLogger {
  const sinks = [];

  if (mode === 'console' || mode === 'file+console') {
    sinks.push(createConsoleSink());
  }

  if ((mode === 'file' || mode === 'file+console') && targetDir) {
    sinks.push(createFileSink(targetDir, 7));
  }

  const log = createLogger('info', sinks);

  setAdapterLogger(toAdapterLogger(log));

  log.info('cli', 'CLI logger initialized', {
    targetDir: targetDir ?? 'unknown',
    mode,
    sinks: sinks.length,
  });

  return log;
}
