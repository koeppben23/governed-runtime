/**
 * @module adapters/diagnostics/export
 * @description Read-only diagnostic snapshot collection and safe publication.
 *
 * The collector reads canonical session authority, persisted state, audit and
 * optional host transcripts. It never starts, hydrates, reconciles, mutates or
 * repairs governance. Every known-but-unreadable session stays visible and
 * lowers completeness; it is never removed from the denominator.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { verifyChain } from '../../audit/integrity.js';
import { readAuditTrail } from '../persistence-audit.js';
import { auditPath } from '../persistence.js';
import { resolveSessionAuthority } from '../session-authority.js';
import { validateSessionId } from '../workspace/types.js';
import {
  DEFAULT_DIAGNOSTIC_LIMITS,
  DIAGNOSTIC_EXPORT_SCHEMA_VERSION,
  DiagnosticCaptureStatus,
  DiagnosticLogIndex,
  DiagnosticSessionGraph,
  DiagnosticTimeline,
  type DiagnosticExportLimits,
} from './export-schema.js';
import { DiagnosticExportError } from './errors.js';
import { manifestFor } from './manifest.js';
import { writeAllSessionArtifacts, writeArtifact } from './artifact-writer.js';
import { DEFAULT_LOG_CAPTURE_LIMITS, captureLogs, type LogCaptureResult } from './log-capture.js';
import {
  warning,
  type CaptureAccumulator,
  type DiagnosticHostReader,
  type DiscoverySource,
  type SessionCapture,
  type SessionDiscovery,
} from './types.js';
import { discoverReviewSessions } from './session-discovery.js';
import type { HostTranscript } from './host-transcript.js';
import type { AuditEvent } from '../../state/evidence-audit.js';
import type { RedactionMode } from '../../redaction/export-redaction.js';

export { DiagnosticExportError } from './errors.js';

export interface DiagnosticExportRequest {
  readonly root: string;
  readonly sessionId: string;
  readonly outputDir: string;
  readonly redactionMode: RedactionMode;
  readonly includeHost: boolean;
  readonly limits?: DiagnosticExportLimits;
  readonly hostReader?: DiagnosticHostReader;
  /** Absolute FlowGuard log directory supplied by the host adapter. */
  readonly logsDirectory?: string;
  /** Safe workspace-relative label for the manifest; never an absolute path. */
  readonly logsDirectoryLabel?: string;
  /** Deterministic test seam; production uses the current clock. */
  readonly now?: () => Date;
  readonly captureId?: string;
}

export interface DiagnosticExportResult {
  readonly outputDir: string;
  readonly manifest: import('./export-schema.js').DiagnosticManifest;
}

async function auditWithinLimit(sessDir: string, maxBytes: number): Promise<boolean> {
  try {
    const info = await stat(auditPath(sessDir));
    return info.size <= maxBytes;
  } catch {
    // A missing audit file is an empty trail; other read failures surface in
    // readAuditTrail with their typed persistence error.
    return true;
  }
}

async function readAudit(
  sessionId: string,
  sessDir: string,
  acc: CaptureAccumulator,
): Promise<{ audit: AuditEvent[]; valid: boolean | null }> {
  if (!(await auditWithinLimit(sessDir, acc.maxFileBytes))) {
    acc.warnings.push(
      warning(
        'AUDIT_TOO_LARGE',
        `Audit trail exceeds the ${acc.maxFileBytes}-byte capture limit; audit content was not read.`,
        sessionId,
        'audit',
      ),
    );
    return { audit: [], valid: null };
  }
  try {
    const audit = await readAuditTrail(sessDir);
    const chain = verifyChain(audit);
    acc.auditEvents += audit.length;
    if (!chain.valid) {
      acc.warnings.push(
        warning(
          'AUDIT_CHAIN_INVALID',
          `Audit chain verification failed: ${chain.reason ?? 'unknown reason'}.`,
          sessionId,
          'audit',
        ),
      );
    }
    return { audit, valid: chain.valid };
  } catch (error) {
    acc.warnings.push(
      warning(
        'AUDIT_READ_FAILED',
        `Audit trail could not be read: ${error instanceof Error ? error.message : String(error)}`,
        sessionId,
        'audit',
      ),
    );
    return { audit: [], valid: null };
  }
}

async function readHost(
  sessionId: string,
  request: DiagnosticExportRequest,
  acc: CaptureAccumulator,
): Promise<HostTranscript | null> {
  if (!request.includeHost || request.hostReader === undefined) return null;
  const remaining = acc.deadlineAt - Date.now();
  if (remaining <= 0) {
    acc.warnings.push(
      warning(
        'CAPTURE_TIME_BUDGET_EXCEEDED',
        'Host history was not captured because the total capture time budget was exhausted.',
        sessionId,
        'host',
      ),
    );
    return null;
  }
  try {
    const transcript = await request.hostReader(
      sessionId,
      Math.min(request.limits?.hostTimeoutMs ?? DEFAULT_DIAGNOSTIC_LIMITS.hostTimeoutMs, remaining),
    );
    if (transcript.bytes > acc.maxFileBytes) {
      acc.warnings.push(
        warning(
          'HOST_HISTORY_TOO_LARGE',
          `Host transcript exceeds the ${acc.maxFileBytes}-byte capture limit.`,
          sessionId,
          'host',
        ),
      );
      return null;
    }
    acc.hostMessages += transcript.messageCount;
    return transcript;
  } catch (error) {
    acc.warnings.push(
      warning(
        'HOST_HISTORY_UNAVAILABLE',
        `Host transcript could not be captured: ${error instanceof Error ? error.message : String(error)}`,
        sessionId,
        'host',
      ),
    );
    return null;
  }
}

async function captureOne(
  sessionId: string,
  root: string,
  request: DiagnosticExportRequest,
  acc: CaptureAccumulator,
  meta: {
    role: SessionCapture['role'];
    discoveredBy: readonly DiscoverySource[];
    parentSessionId: string | null;
    generation: number;
    lineage: SessionCapture['lineage'];
  },
): Promise<SessionCapture> {
  const authority = await resolveSessionAuthority({ root, sessionId });
  if (authority.status === 'unavailable') {
    acc.warnings.push(
      warning(
        `SESSION_${authority.code}`,
        `Known session could not be resolved: ${authority.reason}`,
        sessionId,
        'state',
      ),
    );
  }
  const state = authority.status === 'resolved' ? authority.state : null;
  const auditResult =
    authority.status === 'unavailable'
      ? { audit: [] as AuditEvent[], valid: null }
      : await readAudit(sessionId, authority.sessDir, acc);
  const host = authority.status === 'unavailable' ? null : await readHost(sessionId, request, acc);
  return {
    sessionId,
    parentSessionId: meta.parentSessionId,
    generation: meta.generation,
    captureStatus: 'captured',
    role: meta.role,
    discoveredBy: meta.discoveredBy,
    lineage: meta.lineage,
    authority,
    state,
    audit: auditResult.audit,
    auditValid: auditResult.valid,
    host,
    hostRequested: request.includeHost,
  };
}

function uncapturedSession(
  sessionId: string,
  discovery: SessionDiscovery,
  acc: CaptureAccumulator,
): SessionCapture {
  acc.warnings.push(
    warning(
      'SESSION_LINEAGE_NOT_VERIFIED',
      'Known session was retained in the graph but not read because its lineage to the requested root is not positively established.',
      sessionId,
      'review',
    ),
  );
  return {
    sessionId,
    parentSessionId: discovery.parentSessionId,
    generation: 1,
    captureStatus: 'not_captured',
    role: 'reviewer',
    discoveredBy: discovery.sources,
    lineage: 'not_verified',
    authority: null,
    state: null,
    audit: [],
    auditValid: null,
    host: null,
    hostRequested: false,
  };
}

function graphFor(
  root: SessionCapture,
  acc: CaptureAccumulator,
): import('./export-schema.js').DiagnosticSessionGraph {
  return {
    schemaVersion: DIAGNOSTIC_EXPORT_SCHEMA_VERSION,
    rootSessionId: root.sessionId,
    sessions: acc.sessions.map((item) => ({
      sessionId: item.sessionId,
      parentSessionId: item.parentSessionId,
      generation: item.generation,
      role: item.role,
      captureStatus: item.captureStatus,
      discoveredBy: [...item.discoveredBy],
      state:
        item.authority === null
          ? 'unavailable'
          : item.authority.status === 'resolved'
            ? 'captured'
            : item.authority.status === 'absent'
              ? 'absent'
              : 'unavailable',
      lineage: item.lineage,
      phase: item.state?.phase ?? null,
      binding: item.authority?.status === 'resolved' ? 'verified' : 'unknown',
      hostHistory: item.host ? 'captured' : item.hostRequested ? 'unavailable' : 'not_requested',
      warningCodes: acc.warnings
        .filter((entry) => entry.sessionId === item.sessionId)
        .map((entry) => entry.code),
    })),
  };
}

function timelineFor(
  acc: CaptureAccumulator,
  createdAt: string,
): import('./export-schema.js').DiagnosticTimeline {
  const entries: Array<{
    at: string | null;
    source: 'audit' | 'host' | 'capture';
    sessionId: string | null;
    kind: string;
    reference: string | null;
  }> = [
    {
      at: createdAt,
      source: 'capture',
      sessionId: null,
      kind: 'capture_started',
      reference: null,
    },
  ];
  for (const session of acc.sessions) {
    for (const event of session.audit) {
      entries.push({
        at: event.occurredAt,
        source: 'audit',
        sessionId: session.sessionId,
        kind: event.event,
        reference: event.id,
      });
    }
  }
  return {
    schemaVersion: DIAGNOSTIC_EXPORT_SCHEMA_VERSION,
    entries,
    note: 'Chronology is navigational only; timestamps never establish lineage or causality.',
  };
}

async function createOutputDirectory(outputDir: string): Promise<void> {
  try {
    await mkdir(path.dirname(outputDir), { recursive: true, mode: 0o700 });
    await mkdir(outputDir, { recursive: false, mode: 0o700 });
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
    if (code === 'EEXIST') {
      throw new DiagnosticExportError(
        'OUTPUT_EXISTS',
        `Refusing to overwrite existing diagnostic output: ${outputDir}`,
        { cause: error },
      );
    }
    throw new DiagnosticExportError(
      'OUTPUT_INVALID',
      `Cannot create diagnostic output directory: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function collectSessions(
  request: DiagnosticExportRequest,
  limit: DiagnosticExportLimits,
  acc: CaptureAccumulator,
): Promise<SessionCapture> {
  const root = await captureOne(request.sessionId, request.root, request, acc, {
    role: 'root',
    discoveredBy: ['root'],
    parentSessionId: null,
    generation: 0,
    lineage: 'verified',
  });
  acc.sessions.push(root);
  if (Date.now() > acc.deadlineAt) {
    acc.truncated = true;
    acc.warnings.push(
      warning(
        'CAPTURE_TIME_BUDGET_EXCEEDED',
        'The root capture consumed the total capture time budget; descendants were not traversed.',
        request.sessionId,
        'capture',
      ),
    );
    return root;
  }
  for (const [sessionId, discovery] of discoverReviewSessions(root.state, request.sessionId)) {
    if (sessionId === request.sessionId) continue;
    if (Date.now() > acc.deadlineAt) {
      acc.truncated = true;
      acc.warnings.push(
        warning(
          'CAPTURE_TIME_BUDGET_EXCEEDED',
          `Known session ${sessionId} was not captured because the total capture time budget was exhausted.`,
          sessionId,
          'capture',
        ),
      );
      break;
    }
    if (acc.sessions.length >= limit.maxSessions) {
      acc.truncated = true;
      acc.warnings.push(
        warning(
          'SESSION_LIMIT_TRUNCATED',
          `Known session ${sessionId} was not captured because the ${limit.maxSessions}-session limit was reached.`,
          sessionId,
          'capture',
        ),
      );
      continue;
    }
    if (discovery.lineage !== 'verified') {
      acc.sessions.push(uncapturedSession(sessionId, discovery, acc));
      continue;
    }
    acc.sessions.push(
      await captureOne(sessionId, request.root, request, acc, {
        role: 'reviewer',
        discoveredBy: discovery.sources,
        parentSessionId: discovery.parentSessionId,
        generation: 1,
        lineage: discovery.lineage,
      }),
    );
  }
  return root;
}

async function writeIndexArtifacts(
  request: DiagnosticExportRequest,
  root: SessionCapture,
  acc: CaptureAccumulator,
  createdAt: string,
): Promise<void> {
  const graph = graphFor(root, acc);
  const timeline = timelineFor(acc, createdAt);
  await writeArtifact(
    request.outputDir,
    'session-graph.json',
    `${JSON.stringify(DiagnosticSessionGraph.parse(graph), null, 2)}\n`,
    acc,
  );
  await writeArtifact(
    request.outputDir,
    'timeline.json',
    `${JSON.stringify(DiagnosticTimeline.parse(timeline), null, 2)}\n`,
    acc,
  );
}

async function writeLogArtifacts(
  request: DiagnosticExportRequest,
  acc: CaptureAccumulator,
  logs: LogCaptureResult,
): Promise<void> {
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
  const index = {
    schemaVersion: 'diagnostic-log-index.v1' as const,
    status: logs.status,
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
    truncationReasons: logs.truncationReasons,
    hostLogs: {
      status: 'not_verified' as const,
      reason:
        'Host process logs are not read by this exporter; only FlowGuard JSONL logs are captured.',
    },
    note: 'Diagnostics log capture is bounded and diagnostic only. Older entries outside the inspected budgets may exist; unreadable or uncorrelated entries are explicit gaps.',
  };
  await writeArtifact(
    request.outputDir,
    'diagnostics/log-files.json',
    `${JSON.stringify(DiagnosticLogIndex.parse(index), null, 2)}\n`,
    acc,
  );
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
  request: DiagnosticExportRequest,
  acc: CaptureAccumulator,
): Promise<LogCaptureResult> {
  const logDirectory = request.logsDirectory ?? null;
  const sessionIds = acc.sessions
    .filter((session) => session.lineage === 'verified')
    .map((session) => session.sessionId);
  let logs: LogCaptureResult;
  try {
    logs = await captureLogs({
      directory: logDirectory,
      filter: { sessionIds },
      limits: DEFAULT_LOG_CAPTURE_LIMITS,
      redact: request.redactionMode !== 'none',
      ...(request.now === undefined ? {} : { now: request.now }),
    });
  } catch (error) {
    acc.warnings.push(
      warning(
        'LOG_CAPTURE_FAILED',
        `FlowGuard log capture failed: ${error instanceof Error ? error.message : String(error)}`,
        null,
        'logs',
      ),
    );
    logs = emptyLogCapture(logDirectory, sessionIds);
  }
  recordLogWarnings(acc, logs);
  return logs;
}

/**
 * Collect and publish one bounded diagnostic snapshot. The output directory is
 * created exclusively (`EEXIST` fails); every artifact is write-once.
 */
export async function writeDiagnosticExport(
  request: DiagnosticExportRequest,
): Promise<DiagnosticExportResult> {
  if (request.sessionId.trim().length === 0) {
    throw new DiagnosticExportError('INVALID_SESSION_ID', 'A root session ID is required.');
  }
  validateSessionId(request.sessionId);
  const limit = request.limits ?? DEFAULT_DIAGNOSTIC_LIMITS;
  const createdAt = (request.now ?? (() => new Date()))().toISOString();
  await createOutputDirectory(request.outputDir);

  const acc: CaptureAccumulator = {
    sessions: [],
    warnings: [],
    receipts: [],
    auditEvents: 0,
    hostMessages: 0,
    totalBytes: 0,
    maxFileBytes: limit.maxFileBytes,
    maxTotalBytes: limit.maxTotalBytes,
    deadlineAt: Date.now() + limit.maxDurationMs,
    truncated: false,
  };
  const root = await collectSessions(request, limit, acc);
  await writeAllSessionArtifacts(request, acc, createdAt);
  await writeIndexArtifacts(request, root, acc, createdAt);
  const logs = await captureDiagnosticLogs(request, acc);
  await writeLogArtifacts(request, acc, logs);

  const manifest = manifestFor({
    request,
    root,
    acc,
    captureId: request.captureId ?? randomUUID(),
    createdAt,
    logs,
  });
  const manifestWritten = await writeArtifact(
    request.outputDir,
    'manifest.json',
    `${JSON.stringify(manifest, null, 2)}\n`,
    acc,
    { enforceTotal: false },
  );
  if (!manifestWritten)
    throw new DiagnosticExportError(
      'MANIFEST_TOO_LARGE',
      'The diagnostic manifest exceeds the configured capture budget.',
    );
  return { outputDir: request.outputDir, manifest };
}
