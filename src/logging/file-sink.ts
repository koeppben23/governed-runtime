/**
 * @module logging/file-sink
 * @description File-based logging sink for FlowGuard.
 *
 * Writes structured JSONL logs to {workspace}/.opencode/logs/
 * Automatically handles retention cleanup.
 *
 * Design:
 * - One file per day: flowguard-{YYYY-MM-DD}.log
 * - JSONL format (one JSON object per line)
 * - Retention: auto-delete files older than retentionDays
 * - Non-blocking: errors are swallowed; logging never affects governance flow
 *
 * FlowGuard operational logs are diagnostic only. They are not audit evidence
 * and are not part of the governance SSOT.
 *
 * @version v1
 */

import { writeFile, readdir, unlink, mkdir, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { LogEntry, LogSink } from './logger';

/** Log file directory relative to workspace. */
const LOG_SUBDIR = '.opencode/logs';

/** Log file prefix. */
const LOG_PREFIX = 'flowguard-';

/** Log file extension. */
const LOG_EXT = '.log';

/**
 * Create a file-based logging sink.
 *
 * @param workspaceDir - Absolute path to workspace directory.
 * @param retentionDays - Days to retain log files (default from config).
 * @returns LogSink function.
 */
export function createFileSink(workspaceDir: string, retentionDays: number | undefined): LogSink {
  const effectiveRetention = retentionDays ?? 7;

  let initialized = false;
  let _initPromise: Promise<boolean> | null = null;
  let logDir: string;

  async function ensureDir(): Promise<boolean> {
    if (!isAbsolute(workspaceDir)) {
      return false;
    }
    logDir = join(workspaceDir, LOG_SUBDIR);
    try {
      await mkdir(logDir, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  async function cleanupOldLogs(): Promise<void> {
    if (!logDir) return;
    try {
      const entries = await readdir(logDir);
      const cutoffMs = effectiveRetention * 24 * 60 * 60 * 1000;
      const cutoffTime = Date.now() - cutoffMs;

      for (const entry of entries) {
        if (!entry.startsWith(LOG_PREFIX)) continue;
        if (!entry.endsWith(LOG_EXT)) continue;

        const filePath = join(logDir, entry);
        let fileStat;

        try {
          fileStat = await stat(filePath);
        } catch {
          continue;
        }

        if (fileStat.mtimeMs < cutoffTime) {
          try {
            await unlink(filePath);
          } catch {
            // Ignore cleanup errors
          }
        }
      }
    } catch {
      // Non-blocking — cleanup errors never fail the flow
    }
  }

  return async (entry: LogEntry): Promise<void> => {
    try {
      if (!initialized) {
        if (!_initPromise) {
          _initPromise = ensureDir()
            .then(async (dirOk) => {
              if (dirOk) await cleanupOldLogs();
              return dirOk;
            })
            .finally(() => {
              _initPromise = null;
            });
        }
        const dirOk = await _initPromise;
        if (!dirOk) return;
        initialized = true;
      }

      if (!logDir) return;

      const date = new Date().toISOString().slice(0, 10);
      const logFile = join(logDir, `${LOG_PREFIX}${date}${LOG_EXT}`);

      const logEntry: Record<string, unknown> = {
        ts: new Date().toISOString(),
        level: entry.level,
        component: 'flowguard',
        message: entry.message,
        service: entry.service,
      };
      if (entry.extra) {
        logEntry.fields = entry.extra;
      }

      const line = JSON.stringify(logEntry) + '\n';

      await writeFile(logFile, line, { flag: 'a' });
    } catch {
      // Non-blocking — logging errors never fail the flow
    }
  };
}

/**
 * Get log directory path for a workspace.
 */
export function getLogDir(workspaceDir: string): string {
  return join(workspaceDir, LOG_SUBDIR);
}
