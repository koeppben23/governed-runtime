/**
 * @module integration/diagnostics/log-view
 * @description Bounded, read-only view over the existing FlowGuard JSONL sink.
 *
 * The heavy lifting is the shared adapter capture pipeline. This module only
 * validates the presentation request and maps the adapter result to the
 * versioned `LogView` projection.
 */

import {
  DEFAULT_LOG_CAPTURE_LIMITS,
  DiagnosticLogCaptureError,
  captureLogs,
} from '../../adapters/diagnostics/index.js';
import { DiagnosticViewError } from './errors.js';
import type { LogEntryView, LogFileView, LogView, LogViewFilter, LogViewLevel } from './types.js';

const LOG_LEVELS: readonly LogViewLevel[] = ['debug', 'info', 'warn', 'error'];

export interface LogViewRequest {
  /** Existing `.opencode/logs` directory, or null when the workspace is unavailable. */
  readonly directory: string | null;
  readonly filter?: Partial<LogViewFilter>;
  readonly maxBytes?: number;
  readonly maxLines?: number;
  readonly maxFiles?: number;
  /** Deterministic test seam; production uses the current clock. */
  readonly now?: () => Date;
}

function normalizeFilter(input: Partial<LogViewFilter> | undefined): LogViewFilter {
  const levels = input?.levels ?? [];
  for (const level of levels) {
    if (!LOG_LEVELS.includes(level)) {
      throw new DiagnosticViewError(
        'INVALID_FILTER',
        `Unknown log level "${String(level)}"; expected one of ${LOG_LEVELS.join(', ')}.`,
      );
    }
  }
  const time = (value: string | null | undefined, name: string): string | null => {
    if (value === undefined || value === null) return null;
    if (Number.isNaN(Date.parse(value))) {
      throw new DiagnosticViewError(
        'INVALID_FILTER',
        `Invalid ${name} timestamp "${value}"; expected an ISO-8601 value.`,
      );
    }
    return new Date(value).toISOString();
  };
  return {
    levels,
    sessionId: input?.sessionId ?? null,
    traceId: input?.traceId ?? null,
    since: time(input?.since, 'since'),
    until: time(input?.until, 'until'),
  };
}

/**
 * Read the newest bounded tail of the existing FlowGuard JSONL logs.
 *
 * @throws DiagnosticViewError for invalid filters or limits.
 */
export async function readLogView(request: LogViewRequest): Promise<LogView> {
  const generatedAt = (request.now ?? (() => new Date()))().toISOString();
  const filter = normalizeFilter(request.filter);
  const maxBytes = request.maxBytes ?? DEFAULT_LOG_CAPTURE_LIMITS.maxBytes;
  const maxLines = request.maxLines ?? DEFAULT_LOG_CAPTURE_LIMITS.maxLines;
  const maxFiles = request.maxFiles ?? DEFAULT_LOG_CAPTURE_LIMITS.maxFiles;
  const base = {
    schemaVersion: 'diagnostic-view.v1' as const,
    kind: 'logs' as const,
    generatedAt,
    filter,
    maxBytes,
    maxLines,
    note: 'Bounded tail over existing FlowGuard JSONL logs. Older entries outside the inspected byte budget may exist; this view is diagnostic only and never evidence.',
  };

  let captured;
  try {
    captured = await captureLogs({
      directory: request.directory,
      filter: {
        levels: filter.levels,
        sessionIds: filter.sessionId === null ? [] : [filter.sessionId],
        traceId: filter.traceId,
        since: filter.since,
        until: filter.until,
      },
      limits: { maxFiles, maxBytes, maxLines },
      redact: true,
      ...(request.now === undefined ? {} : { now: request.now }),
    });
  } catch (error) {
    if (error instanceof DiagnosticLogCaptureError) {
      throw new DiagnosticViewError(error.code, error.message);
    }
    throw error;
  }

  return {
    ...base,
    status: captured.status,
    directory: captured.directory,
    entries: captured.entries.map((entry): LogEntryView => ({
      ts: entry.ts,
      level: entry.level,
      service: entry.service,
      sessionId: entry.sessionId,
      traceId: entry.traceId,
      message: entry.message,
      fields: entry.fields,
    })),
    files: captured.files.map((file): LogFileView => ({
      file: file.file,
      fileBytes: file.fileBytes,
      bytesRead: file.bytesRead,
      tailOnly: file.tailOnly,
      modifiedAt: file.modifiedAt,
    })),
    bytesRead: captured.bytesRead,
    filesSkipped: captured.filesSkipped,
    truncated: captured.truncated,
    truncationReasons: captured.truncationReasons,
    parseErrors: captured.parseErrors,
    correlation: {
      withSessionId: captured.correlation.withSessionId,
      withoutSessionId: captured.correlation.withoutSessionId,
      withTraceId: captured.correlation.withTraceId,
      withoutTraceId: captured.correlation.withoutTraceId,
      missingFilteredSessionId: captured.correlation.missingFilteredSessionId,
      missingFilteredTraceId: captured.correlation.missingFilteredTraceId,
    },
  };
}
