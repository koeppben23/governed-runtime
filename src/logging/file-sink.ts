/**
 * @module logging/file-sink
 * @description File-based logging sink for FlowGuard.
 *
 * Writes structured JSONL logs to {workspace}/.opencode/logs/
 * Automatically handles retention cleanup and size-based rotation.
 *
 * Design:
 * - One file per day: flowguard-{YYYY-MM-DD}.log
 * - JSONL format (one JSON object per line)
 * - Retention: auto-delete files older than retentionDays by filename date
 * - Size rotation: when maxSizeBytes is exceeded, rotates to .N.log files
 * - Sink failures reject through the LogSink contract so createLogger can count them;
 *   the logger boundary remains non-blocking and never lets diagnostic logging fail governance.
 *
 * FlowGuard operational logs are diagnostic only. They are not audit evidence
 * and are not part of the governance SSOT.
 *
 * @version v2
 */

import { appendFile, readdir, unlink, mkdir, rename, stat, access } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { LogEntry, LogSink } from './logger.js';

/** Log file directory relative to workspace. */
const LOG_SUBDIR = '.opencode/logs';

/** Log file prefix. */
const LOG_PREFIX = 'flowguard-';

/** Log file extension. */
const LOG_EXT = '.log';

/** Default max file size in bytes before rotation (10 MB). */
const DEFAULT_MAX_SIZE_BYTES = 10 * 1024 * 1024;

/** Default retention in days. */
const DEFAULT_RETENTION_DAYS = 7;

/**
 * File sink configuration.
 */
export interface FileSinkOptions {
  /** Days to retain log files (default: 7). */
  retentionDays?: number;
  /** Max file size in bytes before rotation (default: 10 MB). */
  maxSizeBytes?: number;
  /** Called when a log file is rotated due to size. */
  onRotate?: (event: { oldPath: string; newPath: string; reason: 'size' }) => void;
  /**
   * Called when a write, directory setup, rotation, or stat operation fails.
   * The callback is best-effort diagnostic notification; the sink itself also
   * rejects so the owning logger can account for the failure centrally.
   */
  onFailure?: (error: unknown) => void;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function parseLogFileDate(filename: string): string | null {
  if (!filename.startsWith(LOG_PREFIX) || !filename.endsWith(LOG_EXT)) return null;
  // Strip prefix and extension: flowguard-2026-06-25.log → 2026-06-25
  // flowguard-2026-06-25.1.log → 2026-06-25 (first 10 chars after prefix)
  const core = filename.slice(LOG_PREFIX.length, -LOG_EXT.length);
  const datePart = core.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return datePart;
  return null;
}

function normalizeFileSinkOptions(options?: FileSinkOptions | number): {
  retentionDays: number;
  maxSizeBytes: number;
  onRotate?: FileSinkOptions['onRotate'];
  onFailure?: FileSinkOptions['onFailure'];
} {
  if (typeof options === 'number') {
    return {
      retentionDays: options,
      maxSizeBytes: DEFAULT_MAX_SIZE_BYTES,
    };
  }
  return {
    retentionDays: options?.retentionDays ?? DEFAULT_RETENTION_DAYS,
    maxSizeBytes: options?.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES,
    onRotate: options?.onRotate,
    onFailure: options?.onFailure,
  };
}

/**
 * Create a file-based logging sink.
 *
 * @param workspaceDir - Absolute path to workspace directory.
 * @param options - File sink options or retention days (number, backward-compat).
 * @returns LogSink function.
 */
export function createFileSink(workspaceDir: string, options?: FileSinkOptions | number): LogSink {
  const normalized = normalizeFileSinkOptions(options);
  const effectiveRetention = normalized.retentionDays;
  const effectiveMaxSize = normalized.maxSizeBytes;
  const onRotate = normalized.onRotate;
  const onFailure = normalized.onFailure;
  const logDir = join(workspaceDir, LOG_SUBDIR);

  // Diagnostic callback failures are deliberately isolated from the original
  // sink failure. The sink rejection itself is the canonical health signal.
  const notifyFailure = (error: unknown): void => {
    try {
      onFailure?.(error);
    } catch {
      // Never replace the original sink failure with an observer failure.
    }
  };

  let initialized = false;
  let _initPromise: Promise<void> | null = null;

  async function ensureDir(): Promise<void> {
    if (!isAbsolute(workspaceDir)) {
      throw new Error(
        `file sink requires an absolute workspace directory, received "${workspaceDir}" — file logging is disabled`,
      );
    }
    await mkdir(logDir, { recursive: true });
  }

  async function cleanupOldLogs(): Promise<void> {
    try {
      const entries = await readdir(logDir);
      const cutoffMs = effectiveRetention * 24 * 60 * 60 * 1000;
      const cutoffTime = Date.now() - cutoffMs;

      for (const entry of entries) {
        if (!entry.startsWith(LOG_PREFIX)) continue;
        if (!entry.endsWith(LOG_EXT)) continue;

        const fileDate = parseLogFileDate(entry);
        if (!fileDate) continue;

        const fileTime = new Date(fileDate).getTime();
        if (!isNaN(fileTime) && fileTime < cutoffTime) {
          const filePath = join(logDir, entry);
          try {
            await unlink(filePath);
          } catch {
            // Retention cleanup is housekeeping, not delivery of the current entry.
          }
        }
      }
    } catch {
      // Retention cleanup is best-effort and does not imply loss of the current entry.
    }
  }

  return async (entry: LogEntry): Promise<void> => {
    try {
      if (!initialized) {
        if (!_initPromise) {
          _initPromise = ensureDir()
            .then(cleanupOldLogs)
            .finally(() => {
              _initPromise = null;
            });
        }
        await _initPromise;
        initialized = true;
      }

      const date = new Date().toISOString().slice(0, 10);
      const logFile = join(logDir, `${LOG_PREFIX}${date}${LOG_EXT}`);

      const logEntry: Record<string, unknown> = {
        ts: new Date().toISOString(),
        level: entry.level,
        component: 'flowguard',
        message: entry.message,
        service: entry.service,
      };
      if (entry.traceId) logEntry.traceId = entry.traceId;
      if (entry.sessionId) logEntry.sessionId = entry.sessionId;
      if (entry.extra) logEntry.fields = entry.extra;

      await appendFile(logFile, JSON.stringify(logEntry) + '\n', 'utf8');

      // Post-write rotation: check size after writing, rotate if needed.
      // This avoids the stat→appendFile TOCTOU that CodeQL flags.
      const st = await stat(logFile);
      if (st.size > effectiveMaxSize) {
        let n = 1;
        let rotatedPath: string;
        do {
          rotatedPath = join(logDir, `${LOG_PREFIX}${date}.${n}${LOG_EXT}`);
          n++;
        } while (await pathExists(rotatedPath));

        await rename(logFile, rotatedPath);
        try {
          onRotate?.({ oldPath: logFile, newPath: rotatedPath, reason: 'size' });
        } catch {
          // onRotate is an observer; rotation itself already succeeded.
        }
      }
    } catch (err) {
      notifyFailure(err);
      throw err;
    }
  };
}

/**
 * Get log directory path for a workspace.
 */
export function getLogDir(workspaceDir: string): string {
  return join(workspaceDir, LOG_SUBDIR);
}
