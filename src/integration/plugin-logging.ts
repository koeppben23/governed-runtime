/**
 * @module integration/plugin-logging
 * @description Logger setup and log sink configuration for the FlowGuard plugin.
 *
 * Extracted from plugin.ts to reduce monolith size and enable isolated testing.
 *
 * Responsibilities:
 * - Build log sinks (file, UI, or both) based on FlowGuardConfig
 * - Read FlowGuardConfig from workspace (with DEFAULT_CONFIG fallback)
 * - Create and initialize the Logger instance
 *
 * Non-blocking: logging errors never block the plugin.
 *
 * @version v2
 */

import { readConfig } from '../adapters/persistence-config.js';
import type { FlowGuardConfig } from '../config/flowguard-config.js';
import { DEFAULT_CONFIG } from '../config/flowguard-config.js';
import { createFileSink, getLogDir } from '../logging/file-sink.js';
import { createConsoleSink } from '../logging/console-sink.js';
import { createLogger, createNoopLogger, type LogEntry, type LogSink } from '../logging/logger.js';

/**
 * Shape of the log message accepted by the OpenCode SDK client.log().
 * Extracted from actual call site at buildLogSinks() — service, level, message
 * are always present; extra is an optional Record.
 */
interface PluginLogMessage {
  body: {
    service: string;
    level: 'debug' | 'info' | 'warn' | 'error';
    message: string;
    extra?: Record<string, unknown>;
  };
}

/**
 * Compatibility type for the OpenCode plugin client.
 * Only the app.log method is used — the rest of the client surface is ignored.
 * The log signature matches our actual call shape and the SDK return type.
 */
interface PluginLogClient {
  app?: {
    log: (msg: PluginLogMessage) => Promise<unknown>;
  };
}

/**
 * Maximum number of UI sink failures before stderr warnings are suppressed.
 * Prevents flooding stderr when the SDK connection is persistently broken.
 */
const UI_SINK_FAILURE_WARN_LIMIT = 3;
const UI_HEALTH_REPORT_MS = 5 * 60 * 1000;

/**
 * Build logging sinks based on config mode, client, and workspace.
 *
 * @param config - FlowGuard config with logging.mode, logging.level, logging.retentionDays
 * @param client - OpenCode client (optional, for UI logging)
 * @param workspaceDir - Absolute workspace directory (optional, for file logging)
 * @returns Array of LogSink functions
 */
export function buildLogSinks(
  config: {
    logging: {
      mode: 'file' | 'ui' | 'both' | 'console' | 'file+console';
      level: string;
      retentionDays: number;
      consoleFormat: 'text' | 'json';
      maxFileSizeMb: number;
    };
  },
  client: PluginLogClient | undefined,
  workspaceDir: string | null,
): LogSink[] {
  const sinks: LogSink[] = [];
  const mode = config.logging.mode;

  if (mode === 'file' || mode === 'both' || mode === 'file+console') {
    if (workspaceDir) {
      sinks.push(
        createFileSink(workspaceDir, {
          retentionDays: config.logging.retentionDays,
          maxSizeBytes: config.logging.maxFileSizeMb * 1024 * 1024,
          onRotate: (event) => {
            process.stderr.write(
              `[FlowGuard] diagnostic log file rotated: ${event.reason} — ${event.newPath}\n`,
            );
          },
        }),
      );
    }
  }

  if (mode === 'ui' || mode === 'both') {
    if (client?.app?.log) {
      const clientLog = client.app.log.bind(client.app);
      let uiSinkFailures = 0;
      let lastHealthReport = 0;
      sinks.push(async (entry: LogEntry) => {
        try {
          await clientLog({
            body: {
              service: entry.service,
              level: entry.level,
              message: entry.message,
              ...(entry.extra ? { extra: entry.extra } : {}),
            },
          });
        } catch {
          uiSinkFailures++;
          const now = Date.now();
          if (
            uiSinkFailures <= UI_SINK_FAILURE_WARN_LIMIT ||
            now - lastHealthReport > UI_HEALTH_REPORT_MS
          ) {
            process.stderr.write(`[FlowGuard] UI log sink failure (${uiSinkFailures} total)\n`);
            lastHealthReport = now;
          }
          throw new Error('UI log sink failure'); // rethrow for central counting (G10)
        }
      });
    }
  }

  if (mode === 'console' || mode === 'file+console') {
    sinks.push(createConsoleSink({ format: config.logging.consoleFormat }));
  }

  return sinks;
}

/**
 * Create the plugin logger with sinks based on repo/global config.
 *
 * Reads FlowGuardConfig from the repo or global config file. Falls back to
 * DEFAULT_CONFIG if the directory is unavailable or the config is unreadable.
 *
 * @param client - OpenCode plugin client (for UI logging)
 * @param workspaceDir - Resolved workspace directory (may be null)
 * @param worktree - Project worktree path (for init log context)
 * @param fingerprint - Workspace fingerprint (for init log context)
 * @returns Logger instance and resolved config
 */
export async function createPluginLogger(
  client: PluginLogClient | undefined,
  workspaceDir: string | null,
  worktree: string | undefined,
  fingerprint: string | null,
): Promise<{ log: ReturnType<typeof createLogger>; config: FlowGuardConfig }> {
  // Read config once at plugin init. Failures fall back to defaults — never block.
  let config: FlowGuardConfig;
  try {
    if (workspaceDir || worktree) {
      config = await readConfig(worktree);
    } else {
      config = DEFAULT_CONFIG;
    }
  } catch (err) {
    console.warn(
      '[flowguard] failed to read plugin log config, using defaults:',
      err instanceof Error ? err.message : String(err),
    );
    config = DEFAULT_CONFIG;
  }

  // Create logger: supports file, ui, or both modes, filtered by config level.
  // File sink: {workspace}/.opencode/logs/flowguard-{date}.log (JSONL)
  // UI sink: delegates to client.app.log() (OpenCode UI)
  // Non-blocking: logging errors never block the plugin
  const sinks = buildLogSinks(config, client, workspaceDir);

  const log =
    sinks.length > 0
      ? createLogger(config.logging.level, sinks, {
          rateLimit: {
            enabled: config.logging.rateLimit.enabled,
            maxPerSecond: config.logging.rateLimit.maxPerSecond,
            exemptLevels: config.logging.rateLimit.exemptLevels,
            summaryIntervalMs: config.logging.rateLimit.summaryIntervalMs,
          },
        })
      : createNoopLogger();

  log.info('plugin', 'initialized', {
    worktree: worktree ?? 'none',
    logMode: config.logging.mode,
    logLevel: config.logging.level,
    logRetentionDays: config.logging.retentionDays,
    logDir: workspaceDir ? getLogDir(workspaceDir) : null,
    hasConfigFile: config !== DEFAULT_CONFIG,
    fingerprint: fingerprint ?? 'unknown',
  });

  return { log, config };
}
