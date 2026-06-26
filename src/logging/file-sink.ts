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
 * - Non-blocking: errors are swallowed; logging never affects governance flow
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
   * Called when a write, rotation, or stat operation fails. Gives the file sink
   * a failure signal (parity with the OTLP sink) so silent log loss is
   * observable. Non-blocking — invoked best-effort and its own errors are
   * swallowed.
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

  // Safe one-shot notifier: surfaces a sink failure without ever throwing back
  // into the logging path (an onFailure that itself throws is swallowed).
  const notifyFailure = (error: unknown): void => {
    try {
      onFailure?.(error);
    } catch {
      // onFailure errors are swallowed — logging must never fail the flow.
    }
  };

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

        const fileDate = parseLogFileDate(entry);
        if (!fileDate) continue;

        const fileTime = new Date(fileDate).getTime();
        if (!isNaN(fileTime) && fileTime < cutoffTime) {
          const filePath = join(logDir, entry);
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

      await appendFile(logFile, line, 'utf8');

      // Post-write rotation: check size after writing, rotate if needed.
      // This avoids the stat→appendFile TOCTOU that CodeQL flags.
      try {
        const st = await stat(logFile);
        if (st.size > effectiveMaxSize) {
          let n = 1;
          let rotatedPath: string;
          do {
            rotatedPath = join(logDir, `${LOG_PREFIX}${date}.${n}${LOG_EXT}`);
            n++;
          } while (await pathExists(rotatedPath));

          try {
            await rename(logFile, rotatedPath);
            try {
              onRotate?.({ oldPath: logFile, newPath: rotatedPath, reason: 'size' });
            } catch {
              // onRotate errors are non-blocking
            }
          } catch (rotateErr) {
            // Rotation is non-blocking, but a persistent rename failure leaves the
            // live file in place — subsequent writes keep appending to the SAME
            // file, so it grows past maxSizeBytes unbounded. Surface it via
            // onFailure so a stuck rotation is observable instead of silent.
            notifyFailure(rotateErr);
          }
        }
      } catch (statErr) {
        // A stat failure means rotation can't be evaluated; signal it so a stuck
        // rotation (and unbounded growth) is observable rather than silent.
        notifyFailure(statErr);
      }
    } catch (err) {
      // Non-blocking — logging errors never fail the flow. Surface via onFailure
      // so a failing write (ENOSPC/EACCES) is observable instead of silent.
      notifyFailure(err);
    }
  };
}

/**
 * Get log directory path for a workspace.
 */
export function getLogDir(workspaceDir: string): string {
  return join(workspaceDir, LOG_SUBDIR);
}
