/**
 * @module integration/diagnostics/log-view
 * @description Bounded, read-only view over the existing FlowGuard JSONL sink.
 *
 * The view reads only the newest tail of existing `flowguard-*.log` files. It
 * never creates a logger, a second log file or a persistent view state. Byte,
 * file and line budgets are explicit and every truncation is reported.
 */

import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { redactExtra, sanitizeDiagnosticString } from '../../logging/redact.js';
import { DiagnosticViewError } from './errors.js';
import type { LogEntryView, LogFileView, LogView, LogViewFilter, LogViewLevel } from './types.js';

const LOG_FILE_PATTERN = /^flowguard-\d{4}-\d{2}-\d{2}(?:\.\d+)?\.log$/;
const LOG_LEVELS: readonly LogViewLevel[] = ['debug', 'info', 'warn', 'error'];
const SENSITIVE_FIELD = /password|passwd|secret|token|api[_-]?key|authorization|cookie/i;

const DEFAULT_LOG_MAX_BYTES = 1_000_000;
const DEFAULT_LOG_MAX_LINES = 500;
const DEFAULT_LOG_MAX_FILES = 7;

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

interface CorrelationCounts {
  withSessionId: number;
  withoutSessionId: number;
  withTraceId: number;
  withoutTraceId: number;
  missingFilteredSessionId: number;
  missingFilteredTraceId: number;
}

interface ParsedEntry {
  readonly view: LogEntryView;
  readonly hasSessionId: boolean;
  readonly hasTraceId: boolean;
  readonly missingFilteredSessionId: boolean;
  readonly missingFilteredTraceId: boolean;
  readonly matched: boolean;
}

interface ReadResult {
  readonly files: readonly LogFileView[];
  readonly parsedEntries: readonly ParsedEntry[];
  readonly matchedEntries: readonly ParsedEntry[];
  readonly bytesRead: number;
  readonly parseErrors: number;
  readonly truncationReasons: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLogLevel(value: unknown): value is LogViewLevel {
  return typeof value === 'string' && LOG_LEVELS.includes(value as LogViewLevel);
}

/** Mask values of known sensitive keys before structured fields reach output. */
function redactSensitiveFields(value: unknown, depth = 0): unknown {
  if (depth > 16) return '[redacted:too-deep]';
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveFields(item, depth + 1));
  }
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SENSITIVE_FIELD.test(key) ? '[REDACTED]' : redactSensitiveFields(item, depth + 1);
  }
  return out;
}

function normalizeFilter(input: Partial<LogViewFilter> | undefined): LogViewFilter {
  const levels = input?.levels ?? [];
  for (const level of levels) {
    if (!isLogLevel(level)) {
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

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new DiagnosticViewError('INVALID_LIMIT', `${name} must be a positive integer.`);
  }
  return resolved;
}

function withinTime(ts: string, filter: LogViewFilter): boolean {
  const at = Date.parse(ts);
  if (Number.isNaN(at)) return false;
  if (filter.since !== null && at < Date.parse(filter.since)) return false;
  if (filter.until !== null && at > Date.parse(filter.until)) return false;
  return true;
}

function parseRecord(parsed: Record<string, unknown>): LogEntryView | null {
  const ts = typeof parsed['ts'] === 'string' ? parsed['ts'] : null;
  const message = parsed['message'];
  if (ts === null || !isLogLevel(parsed['level']) || typeof message !== 'string') return null;
  const fields = isRecord(parsed['fields'])
    ? (redactSensitiveFields(redactExtra(parsed['fields']) ?? null) as Record<string, unknown>)
    : null;
  return {
    ts,
    level: parsed['level'],
    service:
      typeof parsed['service'] === 'string'
        ? sanitizeDiagnosticString(parsed['service'])
        : 'unknown',
    sessionId: typeof parsed['sessionId'] === 'string' ? parsed['sessionId'] : null,
    traceId: typeof parsed['traceId'] === 'string' ? parsed['traceId'] : null,
    message: sanitizeDiagnosticString(message),
    fields,
  };
}

function correlationFlags(
  view: LogEntryView,
  filter: LogViewFilter,
): Pick<
  ParsedEntry,
  'hasSessionId' | 'hasTraceId' | 'missingFilteredSessionId' | 'missingFilteredTraceId'
> {
  return {
    hasSessionId: view.sessionId !== null,
    hasTraceId: view.traceId !== null,
    missingFilteredSessionId: filter.sessionId !== null && view.sessionId === null,
    missingFilteredTraceId: filter.traceId !== null && view.traceId === null,
  };
}

function matchesFilter(view: LogEntryView, filter: LogViewFilter): boolean {
  return (
    withinTime(view.ts, filter) &&
    (filter.levels.length === 0 || filter.levels.includes(view.level)) &&
    (filter.sessionId === null || view.sessionId === filter.sessionId) &&
    (filter.traceId === null || view.traceId === filter.traceId)
  );
}

function parseLine(line: string, filter: LogViewFilter): ParsedEntry | 'malformed' {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return 'malformed';
  }
  if (!isRecord(parsed)) return 'malformed';
  const view = parseRecord(parsed);
  if (view === null) return 'malformed';
  return {
    view,
    ...correlationFlags(view, filter),
    matched: matchesFilter(view, filter),
  };
}

async function readTail(
  filePath: string,
  size: number,
  remaining: number,
): Promise<{ text: string; bytesRead: number; tailOnly: boolean }> {
  const start = Math.max(0, size - remaining);
  const length = size - start;
  if (length <= 0) return { text: '', bytesRead: 0, tailOnly: start > 0 };
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (start > 0) {
      const firstBreak = text.indexOf('\n');
      text = firstBreak >= 0 ? text.slice(firstBreak + 1) : '';
    }
    return { text, bytesRead, tailOnly: start > 0 };
  } finally {
    await handle.close();
  }
}

function emptyCorrelation(): CorrelationCounts {
  return {
    withSessionId: 0,
    withoutSessionId: 0,
    withTraceId: 0,
    withoutTraceId: 0,
    missingFilteredSessionId: 0,
    missingFilteredTraceId: 0,
  };
}

function correlationFor(entries: readonly ParsedEntry[]): CorrelationCounts {
  const correlation = emptyCorrelation();
  for (const entry of entries) {
    if (entry.hasSessionId) correlation.withSessionId++;
    else correlation.withoutSessionId++;
    if (entry.hasTraceId) correlation.withTraceId++;
    else correlation.withoutTraceId++;
    if (entry.missingFilteredSessionId) correlation.missingFilteredSessionId++;
    if (entry.missingFilteredTraceId) correlation.missingFilteredTraceId++;
  }
  return correlation;
}

function emptyView(
  base: Omit<
    LogView,
    | 'status'
    | 'directory'
    | 'entries'
    | 'files'
    | 'bytesRead'
    | 'filesSkipped'
    | 'truncated'
    | 'truncationReasons'
    | 'parseErrors'
    | 'correlation'
  >,
  directory: string | null,
  reason: string,
): LogView {
  return {
    ...base,
    status: 'NOT_VERIFIED',
    directory,
    entries: [],
    files: [],
    bytesRead: 0,
    filesSkipped: 0,
    truncated: false,
    truncationReasons: [reason],
    parseErrors: 0,
    correlation: emptyCorrelation(),
  };
}

async function logFileNames(directory: string): Promise<string[] | null> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && LOG_FILE_PATTERN.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return null;
  }
}

async function statLogFiles(
  directory: string,
  names: readonly string[],
): Promise<Array<{ name: string; filePath: string; size: number; mtimeMs: number }>> {
  const statted: Array<{ name: string; filePath: string; size: number; mtimeMs: number }> = [];
  for (const name of names) {
    const filePath = path.join(directory, name);
    try {
      const info = await stat(filePath);
      if (info.isFile()) {
        statted.push({ name, filePath, size: info.size, mtimeMs: info.mtimeMs });
      }
    } catch {
      // A file that disappears between readdir and stat is omitted from the
      // inspected set; the missing-correlation/truncation state still applies.
    }
  }
  return statted.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

async function readSelectedFiles(
  selected: readonly { name: string; filePath: string; size: number; mtimeMs: number }[],
  filter: LogViewFilter,
  maxBytes: number,
  truncationReasons: string[],
): Promise<ReadResult> {
  const files: LogFileView[] = [];
  const parsedEntries: ParsedEntry[] = [];
  const matchedEntries: ParsedEntry[] = [];
  let bytesRead = 0;
  let parseErrors = 0;
  for (const file of selected) {
    const remaining = maxBytes - bytesRead;
    if (remaining <= 0) {
      truncationReasons.push('byte budget exhausted before all selected files were read');
      break;
    }
    try {
      const tail = await readTail(file.filePath, file.size, remaining);
      bytesRead += tail.bytesRead;
      files.push({
        file: file.name,
        fileBytes: file.size,
        bytesRead: tail.bytesRead,
        tailOnly: tail.tailOnly,
        modifiedAt: new Date(file.mtimeMs).toISOString(),
      });
      if (tail.tailOnly) truncationReasons.push(`${file.name} was read as a tail only`);
      for (const line of tail.text.split('\n')) {
        if (line.trim().length === 0) continue;
        const parsed = parseLine(line, filter);
        if (parsed === 'malformed') {
          parseErrors++;
        } else {
          parsedEntries.push(parsed);
          if (parsed.matched) matchedEntries.push(parsed);
        }
      }
    } catch {
      truncationReasons.push(`${file.name} could not be read`);
    }
  }
  return { files, parsedEntries, matchedEntries, bytesRead, parseErrors, truncationReasons };
}

function newestWithinLineBudget(
  entries: readonly ParsedEntry[],
  maxLines: number,
  truncationReasons: string[],
): readonly ParsedEntry[] {
  const sorted = [...entries].sort(
    (left, right) => Date.parse(left.view.ts) - Date.parse(right.view.ts),
  );
  if (sorted.length <= maxLines) return sorted;
  truncationReasons.push('line budget kept only the newest matching entries');
  return sorted.slice(sorted.length - maxLines);
}

/**
 * Read the newest bounded tail of the existing FlowGuard JSONL logs.
 *
 * @throws DiagnosticViewError for invalid filters or limits.
 */
export async function readLogView(request: LogViewRequest): Promise<LogView> {
  const generatedAt = (request.now ?? (() => new Date()))().toISOString();
  const filter = normalizeFilter(request.filter);
  const maxBytes = positiveLimit(request.maxBytes, DEFAULT_LOG_MAX_BYTES, 'maxBytes');
  const maxLines = positiveLimit(request.maxLines, DEFAULT_LOG_MAX_LINES, 'maxLines');
  const maxFiles = positiveLimit(request.maxFiles, DEFAULT_LOG_MAX_FILES, 'maxFiles');
  const base = {
    schemaVersion: 'diagnostic-view.v1' as const,
    kind: 'logs' as const,
    generatedAt,
    filter,
    maxBytes,
    maxLines,
    note: 'Bounded tail over existing FlowGuard JSONL logs. Older entries outside the inspected byte budget may exist; this view is diagnostic only and never evidence.',
  };

  if (request.directory === null) {
    return emptyView(base, null, 'log directory is unavailable');
  }
  const names = await logFileNames(request.directory);
  if (names === null) {
    return emptyView(base, request.directory, 'log directory is missing or unreadable');
  }
  const statted = await statLogFiles(request.directory, names);
  if (statted.length === 0) {
    return emptyView(base, request.directory, 'no FlowGuard log files were found');
  }

  const truncationReasons: string[] = [];
  const filesSkipped = Math.max(0, statted.length - maxFiles);
  if (filesSkipped > 0) {
    truncationReasons.push(`${filesSkipped} older log file(s) were outside the file budget`);
  }
  const read = await readSelectedFiles(
    statted.slice(0, maxFiles),
    filter,
    maxBytes,
    truncationReasons,
  );
  const limited = newestWithinLineBudget(read.matchedEntries, maxLines, truncationReasons);
  const truncated = truncationReasons.length > 0;
  return {
    ...base,
    status: truncated || read.parseErrors > 0 ? 'PARTIAL' : 'COMPLETE',
    directory: request.directory,
    entries: limited.map((entry) => entry.view),
    files: read.files,
    bytesRead: read.bytesRead,
    filesSkipped,
    truncated,
    truncationReasons,
    parseErrors: read.parseErrors,
    correlation: correlationFor(read.parsedEntries),
  };
}
