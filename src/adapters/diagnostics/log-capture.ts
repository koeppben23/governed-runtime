/**
 * @module adapters/diagnostics/log-capture
 * @description Bounded, read-only capture of existing FlowGuard JSONL logs.
 *
 * The capture reads only `flowguard-YYYY-MM-DD[.N].log` files under the
 * supplied directory. It never creates a logger, a second log file or a
 * persistent view. Byte, file and line budgets are explicit; every truncation,
 * malformed entry and correlation gap is reported.
 */

import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { redactExtra, sanitizeDiagnosticString } from '../../logging/redact.js';

const LOG_FILE_PATTERN = /^flowguard-\d{4}-\d{2}-\d{2}(?:\.\d+)?\.log$/;
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
const SENSITIVE_FIELD = /password|passwd|secret|token|api[_-]?key|authorization|cookie/i;

export const DEFAULT_LOG_CAPTURE_LIMITS: LogCaptureLimits = Object.freeze({
  maxFiles: 7,
  maxBytes: 1_000_000,
  maxLines: 500,
});

export type DiagnosticLogLevel = (typeof LOG_LEVELS)[number];

export interface LogCaptureLimits {
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly maxLines: number;
}

export interface LogCaptureFilter {
  readonly levels: readonly DiagnosticLogLevel[];
  /** Empty means no session filter; otherwise only these exact IDs match. */
  readonly sessionIds: readonly string[];
  readonly traceId: string | null;
  readonly since: string | null;
  readonly until: string | null;
}

export interface CapturedLogEntry {
  readonly sourceFile: string;
  readonly sourceLine: number;
  readonly ts: string;
  readonly level: DiagnosticLogLevel;
  readonly service: string;
  readonly sessionId: string | null;
  readonly traceId: string | null;
  readonly message: string;
  readonly fields: Readonly<Record<string, unknown>> | null;
}

export interface CapturedLogFile {
  readonly file: string;
  readonly fileBytes: number;
  readonly bytesRead: number;
  readonly tailOnly: boolean;
  readonly modifiedAt: string;
  readonly entriesRead: number;
  readonly parseErrors: number;
}

export interface LogCaptureCorrelation {
  readonly withSessionId: number;
  readonly withoutSessionId: number;
  readonly withTraceId: number;
  readonly withoutTraceId: number;
  readonly missingFilteredSessionId: number;
  readonly missingFilteredTraceId: number;
  readonly sessionsWithEntries: number;
  readonly sessionsWithoutEntries: readonly string[];
}

export interface LogCaptureResult {
  readonly status: 'COMPLETE' | 'PARTIAL' | 'NOT_VERIFIED';
  readonly directory: string | null;
  readonly entries: readonly CapturedLogEntry[];
  readonly files: readonly CapturedLogFile[];
  readonly filesSkipped: number;
  readonly skippedFiles: readonly { readonly file: string; readonly reason: string }[];
  readonly bytesRead: number;
  readonly parseErrors: number;
  readonly truncated: boolean;
  readonly truncationReasons: readonly string[];
  readonly correlation: LogCaptureCorrelation;
  readonly limits: LogCaptureLimits;
}

export interface LogCaptureRequest {
  readonly directory: string | null;
  readonly filter?: Partial<LogCaptureFilter>;
  readonly limits?: Partial<LogCaptureLimits>;
  /** Default exports redact; explicit raw mode may disable additional masking. */
  readonly redact?: boolean;
  /** Deterministic test seam; production uses the current clock. */
  readonly now?: () => Date;
}

export type DiagnosticLogCaptureErrorCode = 'INVALID_FILTER' | 'INVALID_LIMIT';

export class DiagnosticLogCaptureError extends Error {
  readonly code: DiagnosticLogCaptureErrorCode;

  constructor(code: DiagnosticLogCaptureErrorCode, message: string) {
    super(message);
    this.name = 'DiagnosticLogCaptureError';
    this.code = code;
  }
}

interface ParsedEntry {
  readonly entry: CapturedLogEntry;
  readonly hasSessionId: boolean;
  readonly hasTraceId: boolean;
  readonly missingFilteredSessionId: boolean;
  readonly missingFilteredTraceId: boolean;
  readonly matched: boolean;
}

interface ReadResult {
  readonly files: CapturedLogFile[];
  readonly parsedEntries: ParsedEntry[];
  readonly matchedEntries: ParsedEntry[];
  readonly bytesRead: number;
  readonly parseErrors: number;
  readonly truncationReasons: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLogLevel(value: unknown): value is DiagnosticLogLevel {
  return typeof value === 'string' && LOG_LEVELS.includes(value as DiagnosticLogLevel);
}

function redactSensitiveFields(value: unknown, depth = 0): unknown {
  if (depth > 16) return '[redacted:too-deep]';
  if (Array.isArray(value)) return value.map((item) => redactSensitiveFields(item, depth + 1));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SENSITIVE_FIELD.test(key) ? '[REDACTED]' : redactSensitiveFields(item, depth + 1);
  }
  return out;
}

function normalizeFilter(input: Partial<LogCaptureFilter> | undefined): LogCaptureFilter {
  const levels = input?.levels ?? [];
  for (const level of levels) {
    if (!isLogLevel(level)) {
      throw new DiagnosticLogCaptureError(
        'INVALID_FILTER',
        `Unknown log level "${String(level)}"; expected one of ${LOG_LEVELS.join(', ')}.`,
      );
    }
  }
  const time = (value: string | null | undefined, name: string): string | null => {
    if (value === undefined || value === null) return null;
    if (Number.isNaN(Date.parse(value))) {
      throw new DiagnosticLogCaptureError(
        'INVALID_FILTER',
        `Invalid ${name} timestamp "${value}"; expected an ISO-8601 value.`,
      );
    }
    return new Date(value).toISOString();
  };
  return {
    levels,
    sessionIds: [...new Set(input?.sessionIds ?? [])],
    traceId: input?.traceId ?? null,
    since: time(input?.since, 'since'),
    until: time(input?.until, 'until'),
  };
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new DiagnosticLogCaptureError('INVALID_LIMIT', `${name} must be a positive integer.`);
  }
  return resolved;
}

function withinTime(ts: string, filter: LogCaptureFilter): boolean {
  const at = Date.parse(ts);
  if (Number.isNaN(at)) return false;
  if (filter.since !== null && at < Date.parse(filter.since)) return false;
  if (filter.until !== null && at > Date.parse(filter.until)) return false;
  return true;
}

function parseRecord(
  parsed: Record<string, unknown>,
  sourceFile: string,
  sourceLine: number,
  redact: boolean,
): CapturedLogEntry | null {
  const ts = typeof parsed['ts'] === 'string' ? parsed['ts'] : null;
  const message = parsed['message'];
  if (ts === null || !isLogLevel(parsed['level']) || typeof message !== 'string') return null;
  const fields = isRecord(parsed['fields'])
    ? redact
      ? (redactSensitiveFields(redactExtra(parsed['fields']) ?? null) as Record<string, unknown>)
      : parsed['fields']
    : null;
  return {
    sourceFile,
    sourceLine,
    ts,
    level: parsed['level'],
    service:
      typeof parsed['service'] === 'string' ? safeString(parsed['service'], redact) : 'unknown',
    sessionId: typeof parsed['sessionId'] === 'string' ? parsed['sessionId'] : null,
    traceId: typeof parsed['traceId'] === 'string' ? parsed['traceId'] : null,
    message: safeString(message, redact),
    fields,
  };
}

function safeString(value: string, redact: boolean): string {
  return redact ? sanitizeDiagnosticString(value) : value;
}

function correlationFlags(
  entry: CapturedLogEntry,
  filter: LogCaptureFilter,
): Pick<
  ParsedEntry,
  'hasSessionId' | 'hasTraceId' | 'missingFilteredSessionId' | 'missingFilteredTraceId'
> {
  return {
    hasSessionId: entry.sessionId !== null,
    hasTraceId: entry.traceId !== null,
    missingFilteredSessionId: filter.sessionIds.length > 0 && entry.sessionId === null,
    missingFilteredTraceId: filter.traceId !== null && entry.traceId === null,
  };
}

function matchesFilter(entry: CapturedLogEntry, filter: LogCaptureFilter): boolean {
  return (
    withinTime(entry.ts, filter) &&
    (filter.levels.length === 0 || filter.levels.includes(entry.level)) &&
    (filter.sessionIds.length === 0 ||
      (entry.sessionId !== null && filter.sessionIds.includes(entry.sessionId))) &&
    (filter.traceId === null || entry.traceId === filter.traceId)
  );
}

function parseLine(
  line: string,
  sourceFile: string,
  sourceLine: number,
  filter: LogCaptureFilter,
  redact: boolean,
): ParsedEntry | 'malformed' {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return 'malformed';
  }
  if (!isRecord(parsed)) return 'malformed';
  const entry = parseRecord(parsed, sourceFile, sourceLine, redact);
  if (entry === null) return 'malformed';
  return {
    entry,
    ...correlationFlags(entry, filter),
    matched: matchesFilter(entry, filter),
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

function emptyCorrelation(): {
  withSessionId: number;
  withoutSessionId: number;
  withTraceId: number;
  withoutTraceId: number;
  missingFilteredSessionId: number;
  missingFilteredTraceId: number;
} {
  return {
    withSessionId: 0,
    withoutSessionId: 0,
    withTraceId: 0,
    withoutTraceId: 0,
    missingFilteredSessionId: 0,
    missingFilteredTraceId: 0,
  };
}

function correlationFor(
  entries: readonly ParsedEntry[],
  filter: LogCaptureFilter,
): LogCaptureCorrelation {
  const counts = emptyCorrelation();
  const sessions = new Set<string>();
  for (const parsed of entries) {
    if (parsed.hasSessionId) counts.withSessionId++;
    else counts.withoutSessionId++;
    if (parsed.hasTraceId) counts.withTraceId++;
    else counts.withoutTraceId++;
    if (parsed.missingFilteredSessionId) counts.missingFilteredSessionId++;
    if (parsed.missingFilteredTraceId) counts.missingFilteredTraceId++;
    if (parsed.matched && parsed.entry.sessionId !== null) sessions.add(parsed.entry.sessionId);
  }
  return {
    ...counts,
    sessionsWithEntries: sessions.size,
    sessionsWithoutEntries: filter.sessionIds.filter((sessionId) => !sessions.has(sessionId)),
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
  filter: LogCaptureFilter,
  maxBytes: number,
  redact: boolean,
  truncationReasons: string[],
): Promise<ReadResult> {
  const files: CapturedLogFile[] = [];
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
    let entriesRead = 0;
    let fileParseErrors = 0;
    try {
      const tail = await readTail(file.filePath, file.size, remaining);
      bytesRead += tail.bytesRead;
      if (tail.tailOnly) truncationReasons.push(`${file.name} was read as a tail only`);
      const lines = tail.text.split('\n');
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (line === undefined || line.trim().length === 0) continue;
        const parsed = parseLine(line, file.name, index + 1, filter, redact);
        if (parsed === 'malformed') {
          parseErrors++;
          fileParseErrors++;
        } else {
          entriesRead++;
          parsedEntries.push(parsed);
          if (parsed.matched) matchedEntries.push(parsed);
        }
      }
      files.push({
        file: file.name,
        fileBytes: file.size,
        bytesRead: tail.bytesRead,
        tailOnly: tail.tailOnly,
        modifiedAt: new Date(file.mtimeMs).toISOString(),
        entriesRead,
        parseErrors: fileParseErrors,
      });
    } catch {
      truncationReasons.push(`${file.name} could not be read`);
      files.push({
        file: file.name,
        fileBytes: file.size,
        bytesRead: 0,
        tailOnly: false,
        modifiedAt: new Date(file.mtimeMs).toISOString(),
        entriesRead: 0,
        parseErrors: 0,
      });
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
    (left, right) => Date.parse(left.entry.ts) - Date.parse(right.entry.ts),
  );
  if (sorted.length <= maxLines) return sorted;
  truncationReasons.push('line budget kept only the newest matching entries');
  return sorted.slice(sorted.length - maxLines);
}

function emptyCaptureResult(
  directory: string | null,
  filter: LogCaptureFilter,
  limits: LogCaptureLimits,
  reason: string,
): LogCaptureResult {
  return {
    status: 'NOT_VERIFIED',
    directory,
    entries: [],
    files: [],
    filesSkipped: 0,
    skippedFiles: [],
    bytesRead: 0,
    parseErrors: 0,
    truncated: false,
    truncationReasons: [reason],
    correlation: {
      ...emptyCorrelation(),
      sessionsWithEntries: 0,
      sessionsWithoutEntries: filter.sessionIds,
    },
    limits,
  };
}

function captureStatus(
  truncated: boolean,
  parseErrors: number,
  uncorrelatedGap: boolean,
): LogCaptureResult['status'] {
  return truncated || parseErrors > 0 || uncorrelatedGap ? 'PARTIAL' : 'COMPLETE';
}

/** Read the newest bounded tail of existing FlowGuard JSONL logs. */
export async function captureLogs(request: LogCaptureRequest): Promise<LogCaptureResult> {
  const filter = normalizeFilter(request.filter);
  const limits: LogCaptureLimits = {
    maxFiles: positiveLimit(
      request.limits?.maxFiles,
      DEFAULT_LOG_CAPTURE_LIMITS.maxFiles,
      'maxFiles',
    ),
    maxBytes: positiveLimit(
      request.limits?.maxBytes,
      DEFAULT_LOG_CAPTURE_LIMITS.maxBytes,
      'maxBytes',
    ),
    maxLines: positiveLimit(
      request.limits?.maxLines,
      DEFAULT_LOG_CAPTURE_LIMITS.maxLines,
      'maxLines',
    ),
  };
  const redact = request.redact ?? true;
  if (request.directory === null)
    return emptyCaptureResult(null, filter, limits, 'log directory is unavailable');
  const names = await logFileNames(request.directory);
  if (names === null)
    return emptyCaptureResult(
      request.directory,
      filter,
      limits,
      'log directory is missing or unreadable',
    );
  const statted = await statLogFiles(request.directory, names);
  if (statted.length === 0)
    return emptyCaptureResult(
      request.directory,
      filter,
      limits,
      'no FlowGuard log files were found',
    );

  const truncationReasons: string[] = [];
  const skipped = statted.slice(limits.maxFiles);
  const filesSkipped = skipped.length;
  if (filesSkipped > 0) {
    truncationReasons.push(`${filesSkipped} older log file(s) were outside the file budget`);
  }
  const read = await readSelectedFiles(
    statted.slice(0, limits.maxFiles),
    filter,
    limits.maxBytes,
    redact,
    truncationReasons,
  );
  const limited = newestWithinLineBudget(read.matchedEntries, limits.maxLines, truncationReasons);
  const correlation = correlationFor(read.parsedEntries, filter);
  const uncorrelatedGap = filter.sessionIds.length > 0 && correlation.withoutSessionId > 0;
  if (uncorrelatedGap)
    truncationReasons.push('log entries without session IDs were not attributable');
  const truncated = truncationReasons.length > 0;
  return {
    status: captureStatus(truncated, read.parseErrors, uncorrelatedGap),
    directory: request.directory,
    entries: limited.map((parsed) => parsed.entry),
    files: read.files,
    filesSkipped,
    skippedFiles: skipped.map((file) => ({ file: file.name, reason: 'outside file budget' })),
    bytesRead: read.bytesRead,
    parseErrors: read.parseErrors,
    truncated,
    truncationReasons,
    correlation,
    limits,
  };
}
