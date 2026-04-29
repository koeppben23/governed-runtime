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
 * @version v1
 */

import { readConfig } from '../adapters/persistence.js';
import type { FlowGuardConfig } from '../config/flowguard-config.js';
import { DEFAULT_CONFIG } from '../config/flowguard-config.js';
import { createFileSink, getLogDir } from '../logging/file-sink.js';
import { createLogger, createNoopLogger, type LogEntry, type LogSink } from '../logging/logger.js';

/**
 * Build logging sinks based on config mode, client, and workspace.
 *
 * @param config - FlowGuard config with logging.mode, logging.level, logging.retentionDays
 * @param client - OpenCode client (optional, for UI logging)
 * @param workspaceDir - Absolute workspace directory (optional, for file logging)
 * @returns Array of LogSink functions
 */
export function buildLogSinks(
  config: { logging: { mode: 'file' | 'ui' | 'both'; level: string; retentionDays: number } },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: { app?: { log: (msg: any) => Promise<unknown> } } | undefined,
  workspaceDir: string | null,
): LogSink[] {
  const sinks: LogSink[] = [];
  const mode = config.logging.mode;

  if (mode === 'file' || mode === 'both') {
    if (workspaceDir) {
      sinks.push(createFileSink(workspaceDir, config.logging.retentionDays));
    }
  }

  if (mode === 'ui' || mode === 'both') {
    if (client?.app?.log) {
      const clientLog = client.app.log.bind(client.app);
      sinks.push((entry: LogEntry) => {
        clientLog({
          body: {
            service: entry.service,
            level: entry.level,
            message: entry.message,
            ...(entry.extra ? { extra: entry.extra } : {}),
          },
        }).catch(() => {});
      });
    }
  }

  return sinks;
}

/**
 * Create the plugin logger with sinks based on workspace config.
 *
 * Reads FlowGuardConfig from the workspace directory. Falls back to
 * DEFAULT_CONFIG if the directory is unavailable or the config is unreadable.
 *
 * @param client - OpenCode plugin client (for UI logging)
 * @param workspaceDir - Resolved workspace directory (may be null)
 * @param worktree - Project worktree path (for init log context)
 * @param fingerprint - Workspace fingerprint (for init log context)
 * @returns Logger instance and resolved config
 */
export async function createPluginLogger(
  client:
    | {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        app?: { log: (msg: any) => Promise<unknown> };
      }
    | undefined,
  workspaceDir: string | null,
  worktree: string | undefined,
  fingerprint: string | null,
): Promise<{ log: ReturnType<typeof createLogger>; config: FlowGuardConfig }> {
  // Read config once at plugin init. Failures fall back to defaults — never block.
  let config: FlowGuardConfig;
  try {
    if (workspaceDir) {
      config = await readConfig(workspaceDir);
    } else {
      config = DEFAULT_CONFIG;
    }
  } catch {
    // Config fallback for logging only - runtime behavior uses validated config
    config = DEFAULT_CONFIG;
  }

  // Create logger: supports file, ui, or both modes, filtered by config level.
  // File sink: {workspace}/.opencode/logs/flowguard-{date}.log (JSONL)
  // UI sink: delegates to client.app.log() (OpenCode UI)
  // Non-blocking: logging errors never block the plugin
  const sinks = buildLogSinks(config, client, workspaceDir);

  const log = sinks.length > 0 ? createLogger(config.logging.level, sinks) : createNoopLogger();

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
