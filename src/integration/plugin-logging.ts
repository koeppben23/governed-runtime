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
import {
  createLevelReloader,
  sigusr1Registrar,
  type LevelReloader,
} from '../logging/level-reloader.js';
import { createOtlpLogSink, type OtlpSinkHandle } from '../logging/otlp-sink.js';

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

type BuildLogSinksConfig = Pick<
  FlowGuardConfig['logging'],
  'mode' | 'retentionDays' | 'consoleFormat' | 'maxFileSizeMb'
> & {
  level: string;
  otlp?: FlowGuardConfig['logging']['otlp'];
};

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
/** Sinks plus any lifecycle-bearing disposables (e.g. the OTLP exporter). */
export interface BuiltLogSinks {
  sinks: LogSink[];
  disposables: OtlpSinkHandle[];
}

export function buildLogSinks(
  config: { logging: BuildLogSinksConfig },
  client: PluginLogClient | undefined,
  workspaceDir: string | null,
): BuiltLogSinks {
  const sinks: LogSink[] = [];
  const disposables: OtlpSinkHandle[] = [];
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

  // G3: OTLP log export — opt-in, endpoint validated here
  addOtlpSinkIfEnabled(config, sinks, disposables);

  return { sinks, disposables };
}

export function addOtlpSinkIfEnabled(
  config: {
    logging: {
      otlp?: { enabled: boolean; endpoint?: string; allowInsecure?: boolean };
    };
  },
  sinks: LogSink[],
  disposables: OtlpSinkHandle[],
): void {
  if (!config.logging.otlp?.enabled) return;

  const endpoint = config.logging.otlp.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) {
    process.stderr.write('[FlowGuard] OTLP log export disabled: no endpoint configured\n');
    return;
  }

  // The config-schema endpoint is already URL/HTTPS-validated, but the
  // OTEL_EXPORTER_OTLP_ENDPOINT env fallback bypasses the schema. Validate the
  // resolved endpoint here so a malformed or cleartext egress fails closed.
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    process.stderr.write('[FlowGuard] OTLP log export disabled: endpoint is not a valid URL\n');
    return;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    process.stderr.write('[FlowGuard] OTLP log export disabled: endpoint must be an http(s) URL\n');
    return;
  }
  if (parsed.protocol !== 'https:' && !config.logging.otlp.allowInsecure) {
    process.stderr.write(
      '[FlowGuard] OTLP log export disabled: endpoint must use https:// ' +
        '(set logging.otlp.allowInsecure to opt into cleartext http://)\n',
    );
    return;
  }

  const handle = createOtlpLogSink({
    endpoint,
    onFailure: (err) => {
      process.stderr.write(
        `[FlowGuard] OTLP log export failure: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    },
  });
  sinks.push(handle.sink);
  disposables.push(handle);
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
 * @param configPath - Resolved config file path for dynamic log level reload (G5)
 * @returns Logger instance, resolved config, and optional dispose callback
 */
export async function createPluginLogger(
  client: PluginLogClient | undefined,
  workspaceDir: string | null,
  worktree: string | undefined,
  fingerprint: string | null,
  configPath?: string,
): Promise<{
  log: ReturnType<typeof createLogger>;
  config: FlowGuardConfig;
  disposeLogging?: () => Promise<void>;
}> {
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
  const { sinks, disposables } = buildLogSinks(config, client, workspaceDir);

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

  let reloader: LevelReloader | undefined;

  // G5: Dynamic log level via SIGUSR1 — opt-in, only when enabled and config path known
  if (config.logging.enableDynamicLevel) {
    if (configPath) {
      reloader = createLevelReloader(sigusr1Registrar);
      reloader.attach(log, configPath);
    } else {
      log.warn('logging', 'dynamic log level reload disabled: config path unavailable');
    }
  }

  log.info('plugin', 'initialized', {
    worktree: worktree ?? 'none',
    logMode: config.logging.mode,
    logLevel: config.logging.level,
    logRetentionDays: config.logging.retentionDays,
    logDir: workspaceDir ? getLogDir(workspaceDir) : null,
    hasConfigFile: config !== DEFAULT_CONFIG,
    fingerprint: fingerprint ?? 'unknown',
  });

  return {
    log,
    config,
    disposeLogging: async () => {
      reloader?.detach();
      // Flush + release the OTLP exporter so batched records are not lost on
      // exit and the BatchLogRecordProcessor timer is released.
      for (const d of disposables) {
        await d.shutdown();
      }
    },
  };
}
