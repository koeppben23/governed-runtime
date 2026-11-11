/**
 * @module adapters/diagnostics/log-artifacts
 * @description Capture and publish bounded FlowGuard log artifacts.
 */

import type { RedactionMode } from '../../redaction/export-redaction.js';
import { warning, type CaptureAccumulator } from './types.js';
import { writeArtifact } from './artifact-writer.js';
import { DiagnosticCaptureStatus, DiagnosticLogIndex } from './export-schema.js';
import { DEFAULT_LOG_CAPTURE_LIMITS, captureLogs, type LogCaptureResult } from './log-capture.js';

export interface LogArtifactRequest {
  readonly outputDir: string;
  readonly redactionMode: RedactionMode;
  readonly logsDirectory?: string;
  readonly logsDirectoryLabel?: string;
  readonly verifiedSessionIds: readonly string[];
  readonly now?: () => Date;
}

interface LogPublication {
  readonly status: LogCaptureResult['status'];
  readonly reasons: readonly string[];
  readonly artifactWritten: boolean;
  readonly indexWritten: boolean;
}

function emptyLogCapture(
  directory: string | null,
  sessionIds: readonly string[],
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
    truncationReasons: ['log capture failed'],
    correlation: {
      withSessionId: 0,
      withoutSessionId: 0,
      withTraceId: 0,
      withoutTraceId: 0,
      missingFilteredSessionId: 0,
      missingFilteredTraceId: 0,
      sessionsWithEntries: 0,
      sessionsWithoutEntries: sessionIds,
    },
    limits: DEFAULT_LOG_CAPTURE_LIMITS,
  };
}

function recordLogWarnings(acc: CaptureAccumulator, logs: LogCaptureResult): void {
  if (logs.status !== DiagnosticCaptureStatus.enum.COMPLETE) {
    acc.warnings.push(
      warning(
        logs.status === DiagnosticCaptureStatus.enum.NOT_VERIFIED
          ? 'LOG_SOURCE_NOT_VERIFIED'
          : 'LOG_CAPTURE_PARTIAL',
        logs.truncationReasons.length > 0
          ? `FlowGuard log capture is ${logs.status}: ${logs.truncationReasons.join('; ')}`
          : `FlowGuard log capture is ${logs.status}.`,
        null,
        'logs',
      ),
    );
  }
  if (logs.entries.length === 0 && logs.status === DiagnosticCaptureStatus.enum.COMPLETE) {
    acc.warnings.push(
      warning(
        'LOG_NO_MATCHING_ENTRIES',
        'FlowGuard logs were inspected but contained no entries for the requested verified sessions.',
        null,
        'logs',
      ),
    );
  }
  if (logs.correlation.sessionsWithoutEntries.length > 0) {
    acc.warnings.push(
      warning(
        'LOG_SESSION_NO_ENTRIES',
        `No FlowGuard log entries were found for ${logs.correlation.sessionsWithoutEntries.length} verified session(s).`,
        null,
        'logs',
      ),
    );
  }
}

async function captureDiagnosticLogs(
  request: LogArtifactRequest,
  acc: CaptureAccumulator,
): Promise<LogCaptureResult> {
  const logDirectory = request.logsDirectory ?? null;
  try {
    const logs = await captureLogs({
      directory: logDirectory,
      filter: { sessionIds: request.verifiedSessionIds },
      limits: DEFAULT_LOG_CAPTURE_LIMITS,
      redact: request.redactionMode !== 'none',
      ...(request.now === undefined ? {} : { now: request.now }),
    });
    recordLogWarnings(acc, logs);
    return logs;
  } catch (error) {
    acc.warnings.push(
      warning(
        'LOG_CAPTURE_FAILED',
        `FlowGuard log capture failed: ${error instanceof Error ? error.message : String(error)}`,
        null,
        'logs',
      ),
    );
    const logs = emptyLogCapture(logDirectory, request.verifiedSessionIds);
    recordLogWarnings(acc, logs);
    return logs;
  }
}

function buildLogIndex(input: {
  readonly request: LogArtifactRequest;
  readonly logs: LogCaptureResult;
  readonly artifact: string;
  readonly artifactWritten: boolean;
  readonly status: LogCaptureResult['status'];
  readonly publicationReasons: readonly string[];
}) {
  const { request, logs, artifact, artifactWritten, status, publicationReasons } = input;
  return {
    schemaVersion: 'diagnostic-log-index.v1' as const,
    status,
    directory: logs.directory === null ? null : (request.logsDirectoryLabel ?? null),
    sessionIds: [
      ...new Set([
        ...logs.correlation.sessionsWithoutEntries,
        ...logs.entries
          .map((entry) => entry.sessionId)
          .filter((sessionId): sessionId is string => sessionId !== null),
      ]),
    ].sort(),
    limits: logs.limits,
    artifact: artifactWritten ? artifact : null,
    files: logs.files,
    filesSkipped: logs.filesSkipped,
    skippedFiles: logs.skippedFiles,
    counts: {
      files: logs.files.length,
      entriesRead: logs.files.reduce((count, file) => count + file.entriesRead, 0),
      entriesIncluded: logs.entries.length,
      parseErrors: logs.parseErrors,
    },
    correlation: logs.correlation,
    truncationReasons: [...logs.truncationReasons, ...publicationReasons],
    hostLogs: {
      status: 'not_verified' as const,
      reason:
        'Host process logs are not read by this exporter; only FlowGuard JSONL logs are captured.',
    },
    note: 'Diagnostics log capture is bounded and diagnostic only. Older entries outside the inspected budgets may exist; unreadable or uncorrelated entries are explicit gaps.',
  };
}

async function writeLogArtifacts(
  request: LogArtifactRequest,
  acc: CaptureAccumulator,
  logs: LogCaptureResult,
): Promise<LogPublication> {
  const artifact = `diagnostics/${request.redactionMode === 'none' ? 'logs' : 'logs.redacted'}.jsonl`;
  let artifactWritten = false;
  if (logs.entries.length > 0) {
    artifactWritten = await writeArtifact(
      request.outputDir,
      artifact,
      `${logs.entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
      acc,
    );
    if (!artifactWritten) {
      acc.warnings.push(
        warning(
          'LOG_ARTIFACT_TOO_LARGE',
          'The bounded log artifact exceeded the capture budget and was not written.',
          null,
          'logs',
        ),
      );
    }
  }
  const publicationReasons =
    logs.entries.length > 0 && !artifactWritten ? ['log artifact publication failed'] : [];
  const sourceStatus =
    publicationReasons.length > 0 ? DiagnosticCaptureStatus.enum.PARTIAL : logs.status;
  const index = buildLogIndex({
    request,
    logs,
    artifact,
    artifactWritten,
    status: sourceStatus,
    publicationReasons,
  });
  const indexWritten = await writeArtifact(
    request.outputDir,
    'diagnostics/log-files.json',
    `${JSON.stringify(DiagnosticLogIndex.parse(index), null, 2)}\n`,
    acc,
  );
  if (!indexWritten) {
    acc.warnings.push(
      warning(
        'LOG_INDEX_TOO_LARGE',
        'The bounded log index exceeded the capture budget and was not written.',
        null,
        'logs',
      ),
    );
  }
  return {
    status: indexWritten ? sourceStatus : DiagnosticCaptureStatus.enum.PARTIAL,
    reasons: indexWritten
      ? publicationReasons
      : [...publicationReasons, 'log index publication failed'],
    artifactWritten,
    indexWritten,
  };
}

/** Capture logs and publish the JSONL artifact plus source index. */
export async function captureAndWriteLogs(
  request: LogArtifactRequest,
  acc: CaptureAccumulator,
): Promise<LogCaptureResult> {
  const logs = await captureDiagnosticLogs(request, acc);
  const publication = await writeLogArtifacts(request, acc, logs);
  if (publication.reasons.length === 0) return logs;
  return {
    ...logs,
    status: publication.status,
    truncationReasons: [...logs.truncationReasons, ...publication.reasons],
  };
}
