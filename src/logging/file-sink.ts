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
   * Called when a log file write, directory setup, rotation, or stat operation fails.
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

/** Mutable state shared by the file sink's module-scope helpers. */
interface FileSinkRuntime {
  readonly enabled: boolean;
  readonly logDir: string;
  readonly retentionDays: number;
  readonly maxSizeBytes: number;
  readonly onRotate: FileSinkOptions['onRotate'];
  readonly onFailure: FileSinkOptions['onFailure'];
  initialized: boolean;
  initPromise: Promise<void> | null;
}

// Diagnostic callback failures are deliberately isolated from the original
// sink failure. The sink rejection itself is the canonical health signal.
function notifyFileSinkFailure(runtime: FileSinkRuntime, error: unknown): void {
  try {
    runtime.onFailure?.(error);
  } catch {
    // Never replace the original sink failure with an observer failure.
  }
}

async function ensureLogDir(logDir: string): Promise<void> {
  await mkdir(logDir, { recursive: true });
}

async function cleanupOldLogs(logDir: string, retentionDays: number): Promise<void> {
  try {
    const entries = await readdir(logDir);
    const cutoffMs = retentionDays * 24 * 60 * 60 * 1000;
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

async function initializeFileSink(runtime: FileSinkRuntime): Promise<void> {
  if (runtime.initialized) return;
  if (!runtime.initPromise) {
    runtime.initPromise = ensureLogDir(runtime.logDir)
      .then(() => cleanupOldLogs(runtime.logDir, runtime.retentionDays))
      .finally(() => {
        runtime.initPromise = null;
      });
  }
  await runtime.initPromise;
  runtime.initialized = true;
}

function buildLogRecord(entry: LogEntry): Record<string, unknown> {
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
  return logEntry;
}

async function rotateLogFileIfNeeded(
  runtime: FileSinkRuntime,
  logFile: string,
  date: string,
): Promise<void> {
  // Post-write rotation: check size after writing, rotate if needed.
  // This avoids the stat→appendFile TOCTOU that CodeQL flags.
  const st = await stat(logFile);
  if (st.size <= runtime.maxSizeBytes) return;

  let n = 1;
  let rotatedPath: string;
  do {
    rotatedPath = join(runtime.logDir, `${LOG_PREFIX}${date}.${n}${LOG_EXT}`);
    n++;
  } while (await pathExists(rotatedPath));

  await rename(logFile, rotatedPath);
  try {
    runtime.onRotate?.({ oldPath: logFile, newPath: rotatedPath, reason: 'size' });
  } catch {
    // onRotate is an observer; rotation itself already succeeded.
  }
}

async function appendLogEntry(runtime: FileSinkRuntime, entry: LogEntry): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  const logFile = join(runtime.logDir, `${LOG_PREFIX}${date}${LOG_EXT}`);
  await appendFile(logFile, JSON.stringify(buildLogRecord(entry)) + '\n', 'utf8');
  await rotateLogFileIfNeeded(runtime, logFile, date);
}

/**
 * Create a file-based logging sink.
 *
 * Empty or non-absolute workspace paths represent an unavailable workspace and
 * preserve the historical disabled-sink contract: the sink performs no I/O and
 * resolves successfully. Once an absolute workspace is available, real
 * filesystem delivery/setup/rotation failures reject through LogSink so the
 * owning logger can account for them.
 *
 * @param workspaceDir - Absolute path to workspace directory.
 * @param options - File sink options or retention days (number, backward-compat).
 * @returns LogSink function.
 */
export function createFileSink(workspaceDir: string, options?: FileSinkOptions | number): LogSink {
  const normalized = normalizeFileSinkOptions(options);
  const enabled = isAbsolute(workspaceDir);
  const runtime: FileSinkRuntime = {
    enabled,
    logDir: enabled ? join(workspaceDir, LOG_SUBDIR) : '',
    retentionDays: normalized.retentionDays,
    maxSizeBytes: normalized.maxSizeBytes,
    onRotate: normalized.onRotate,
    onFailure: normalized.onFailure,
    initialized: false,
    initPromise: null,
  };

  return async (entry: LogEntry): Promise<void> => {
    if (!runtime.enabled) return;

    try {
      await initializeFileSink(runtime);
      await appendLogEntry(runtime, entry);
    } catch (err) {
      notifyFileSinkFailure(runtime, err);
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
