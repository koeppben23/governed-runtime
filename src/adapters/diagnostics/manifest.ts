/**
 * @module adapters/diagnostics/manifest
 * @description Per-source completeness and manifest projection for diagnostic snapshots.
 */

import path from 'node:path';

import type { RedactionMode } from '../../redaction/export-redaction.js';
import {
  DEFAULT_DIAGNOSTIC_LIMITS,
  DIAGNOSTIC_EXPORT_SCHEMA_VERSION,
  DiagnosticCaptureStatus,
  DiagnosticManifest,
  type DiagnosticExportLimits,
  type DiagnosticManifest as DiagnosticManifestType,
} from './export-schema.js';
import { sanitizeDiagnosticString } from '../../logging/redact.js';
import { DEFAULT_LOG_CAPTURE_LIMITS, type LogCaptureResult } from './log-capture.js';
import type { CaptureAccumulator, DiagnosticHostReader, SessionCapture } from './types.js';

export interface ManifestInput {
  readonly includeHost: boolean;
  readonly redactionMode: RedactionMode;
  readonly hostReader?: DiagnosticHostReader;
  readonly limits?: DiagnosticExportLimits;
  readonly logsDirectoryLabel?: string;
}

export interface ManifestContext {
  readonly request: ManifestInput;
  readonly root: SessionCapture;
  readonly acc: CaptureAccumulator;
  readonly captureId: string;
  readonly createdAt: string;
  readonly logs: LogCaptureResult | null;
}

type SourceStatus = 'complete' | 'partial' | 'not_verified';
type HostStatus = 'complete' | 'partial' | 'not_requested' | 'not_verified';

interface SourceProjection {
  readonly discovery: SourceStatus;
  readonly lineage: SourceStatus;
  readonly canonicalState: SourceStatus;
  readonly audit: SourceStatus;
  readonly hostHistory: HostStatus;
  readonly logs: SourceStatus;
}

function warningMessagesFor(
  acc: CaptureAccumulator,
  source: 'capture' | 'state' | 'audit' | 'host' | 'review' | 'logs',
): string[] {
  return acc.warnings
    .filter((entry) => entry.source === source)
    .map((entry) => sanitizeDiagnosticString(entry.message));
}

function verifiedSessions(acc: CaptureAccumulator): SessionCapture[] {
  return acc.sessions.filter((session) => session.lineage === 'verified');
}

function rootResolved(root: SessionCapture): boolean {
  return root.authority?.status === 'resolved';
}

function discoveryStatus(acc: CaptureAccumulator, resolved: boolean): SourceStatus {
  if (!resolved) return 'not_verified';
  return acc.truncated ? 'partial' : 'complete';
}

function lineageStatus(acc: CaptureAccumulator, resolved: boolean): SourceStatus {
  if (!resolved) return 'not_verified';
  return acc.sessions.some((session) => session.lineage === 'not_verified')
    ? 'partial'
    : 'complete';
}

function canonicalStateStatus(acc: CaptureAccumulator, resolved: boolean): SourceStatus {
  if (!resolved) return 'not_verified';
  return verifiedSessions(acc).some(
    (session) =>
      session.authority?.status === 'absent' || session.authority?.status === 'unavailable',
  )
    ? 'partial'
    : 'complete';
}

function auditStatus(acc: CaptureAccumulator, resolved: boolean): SourceStatus {
  if (!resolved) return 'not_verified';
  return verifiedSessions(acc).some(
    (session) =>
      session.authority?.status !== 'resolved' ||
      session.auditValid === null ||
      session.auditValid === false,
  )
    ? 'partial'
    : 'complete';
}

function hostHistoryStatus(
  acc: CaptureAccumulator,
  request: ManifestInput,
  resolved: boolean,
): HostStatus {
  const requested = request.includeHost && request.hostReader !== undefined;
  if (!requested) return 'not_requested';
  if (!resolved) return 'not_verified';
  return verifiedSessions(acc).some((session) => session.host === null) ? 'partial' : 'complete';
}

function logsStatus(logs: LogCaptureResult | null): SourceStatus {
  if (logs === null) return 'not_verified';
  if (logs.status === DiagnosticCaptureStatus.enum.COMPLETE) return 'complete';
  if (logs.status === DiagnosticCaptureStatus.enum.PARTIAL) return 'partial';
  return 'not_verified';
}

function sourceProjection(
  acc: CaptureAccumulator,
  root: SessionCapture,
  request: ManifestInput,
  logs: LogCaptureResult | null,
): SourceProjection {
  const resolved = rootResolved(root);
  return {
    discovery: discoveryStatus(acc, resolved),
    lineage: lineageStatus(acc, resolved),
    canonicalState: canonicalStateStatus(acc, resolved),
    audit: auditStatus(acc, resolved),
    hostHistory: hostHistoryStatus(acc, request, resolved),
    logs: logsStatus(logs),
  };
}

function statusFor(
  acc: CaptureAccumulator,
  root: SessionCapture,
  request: ManifestInput,
  logs: LogCaptureResult | null,
): DiagnosticCaptureStatus {
  if (!rootResolved(root)) return 'NOT_VERIFIED';
  const sources = sourceProjection(acc, root, request, logs);
  const required = [sources.discovery, sources.lineage, sources.canonicalState, sources.audit];
  if (required.includes('not_verified') || sources.logs === 'not_verified') return 'PARTIAL';
  if (
    acc.truncated ||
    acc.warnings.length > 0 ||
    required.some((status) => status !== 'complete') ||
    sources.logs !== 'complete' ||
    (sources.hostHistory !== 'not_requested' && sources.hostHistory !== 'complete')
  ) {
    return 'PARTIAL';
  }
  return 'COMPLETE';
}

function discoverySource(acc: CaptureAccumulator, status: SourceStatus) {
  const verified = verifiedSessions(acc);
  return {
    status,
    known: acc.sessions.length,
    verified: verified.length,
    unverified: acc.sessions.length - verified.length,
    truncated: acc.truncated,
    reasons: warningMessagesFor(acc, 'capture'),
  };
}

function lineageSource(acc: CaptureAccumulator, status: SourceStatus) {
  const verified = verifiedSessions(acc);
  return {
    status,
    verified: verified.length,
    unverified: acc.sessions.length - verified.length,
    reasons: warningMessagesFor(acc, 'review'),
  };
}

function canonicalStateSource(acc: CaptureAccumulator, status: SourceStatus) {
  return {
    status,
    captured: acc.sessions.filter((session) => session.authority?.status === 'resolved').length,
    absent: acc.sessions.filter((session) => session.authority?.status === 'absent').length,
    unavailable: acc.sessions.filter(
      (session) => session.authority?.status === 'unavailable' || session.authority === null,
    ).length,
    reasons: warningMessagesFor(acc, 'state'),
  };
}

function auditSource(acc: CaptureAccumulator, status: SourceStatus) {
  const verified = verifiedSessions(acc);
  return {
    status,
    sessionsRead: verified.filter((session) => session.auditValid !== null).length,
    validChains: verified.filter((session) => session.auditValid === true).length,
    invalidChains: verified.filter((session) => session.auditValid === false).length,
    unavailable: verified.filter(
      (session) => session.authority?.status !== 'resolved' || session.auditValid === null,
    ).length,
    reasons: warningMessagesFor(acc, 'audit'),
  };
}

function hostHistorySource(acc: CaptureAccumulator, request: ManifestInput, status: HostStatus) {
  const requested = request.includeHost && request.hostReader !== undefined;
  const captured = acc.sessions.filter((session) => session.host !== null).length;
  return {
    status,
    requested,
    captured,
    unavailable: requested
      ? verifiedSessions(acc).filter((session) => session.host === null).length
      : 0,
    reasons: warningMessagesFor(acc, 'host'),
  };
}

type LogMetrics = Pick<
  LogCaptureResult,
  | 'directory'
  | 'files'
  | 'entries'
  | 'filesSkipped'
  | 'parseErrors'
  | 'correlation'
  | 'truncated'
  | 'truncationReasons'
  | 'limits'
>;

function logMetrics(logs: LogCaptureResult | null): LogMetrics {
  if (logs !== null) {
    return {
      directory: logs.directory,
      files: logs.files,
      entries: logs.entries,
      filesSkipped: logs.filesSkipped,
      parseErrors: logs.parseErrors,
      correlation: logs.correlation,
      truncated: logs.truncated,
      truncationReasons: logs.truncationReasons,
      limits: logs.limits,
    };
  }
  return {
    directory: null,
    files: [],
    entries: [],
    filesSkipped: 0,
    parseErrors: 0,
    correlation: {
      withSessionId: 0,
      withoutSessionId: 0,
      withTraceId: 0,
      withoutTraceId: 0,
      missingFilteredSessionId: 0,
      missingFilteredTraceId: 0,
      sessionsWithEntries: 0,
      sessionsWithoutEntries: [],
    },
    truncated: false,
    truncationReasons: [],
    limits: DEFAULT_LOG_CAPTURE_LIMITS,
  };
}

function logsSource(
  acc: CaptureAccumulator,
  request: ManifestInput,
  logs: LogCaptureResult | null,
  status: SourceStatus,
) {
  const metrics = logMetrics(logs);
  const entriesRead = metrics.files.reduce((count, file) => count + file.entriesRead, 0);
  return {
    status,
    directory: metrics.directory === null ? null : (request.logsDirectoryLabel ?? null),
    filesInspected: metrics.files.length,
    filesSkipped: metrics.filesSkipped,
    entriesRead,
    entriesIncluded: metrics.entries.length,
    parseErrors: metrics.parseErrors,
    sessionsRequested:
      metrics.correlation.sessionsWithEntries + metrics.correlation.sessionsWithoutEntries.length,
    sessionsWithEntries: metrics.correlation.sessionsWithEntries,
    sessionsWithoutEntries: [...metrics.correlation.sessionsWithoutEntries],
    truncated: metrics.truncated,
    truncationReasons: [...metrics.truncationReasons],
    limits: metrics.limits,
    hostLogs: {
      status: 'not_verified' as const,
      reason:
        'Host process logs are not read by this exporter; only FlowGuard JSONL logs are captured.',
    },
    reasons: [...metrics.truncationReasons, ...warningMessagesFor(acc, 'logs')],
  };
}

function boundaryFor(
  root: SessionCapture,
  acc: CaptureAccumulator,
  request: ManifestInput,
  limit: DiagnosticExportLimits,
) {
  const withState = acc.sessions.filter((item) => item.authority?.status === 'resolved').length;
  const unavailable = acc.sessions.filter(
    (item) => item.authority?.status === 'unavailable' || item.authority === null,
  ).length;
  const absent = acc.sessions.filter((item) => item.authority?.status === 'absent').length;
  const hostRequested = request.includeHost && request.hostReader !== undefined;
  const hostCaptured = acc.sessions.some((item) => item.host !== null);
  return {
    workspaceFingerprint:
      root.authority?.status === 'unavailable' || root.authority === null
        ? null
        : root.authority.fingerprint,
    worktreeName:
      root.authority?.status === 'unavailable' || root.authority === null
        ? null
        : path.basename(root.authority.worktreeRoot),
    sessionsKnown: acc.sessions.length,
    sessionsWithState: withState,
    sessionsWithoutState: absent,
    sessionsUnavailable: unavailable,
    sessionsLineageUnverified: acc.sessions.filter((item) => item.lineage === 'not_verified')
      .length,
    maxSessions: limit.maxSessions,
    maxFileBytes: limit.maxFileBytes,
    maxTotalBytes: limit.maxTotalBytes,
    maxDurationMs: limit.maxDurationMs,
    hostHistory: hostRequested ? (hostCaptured ? 'included' : 'unavailable') : 'not_requested',
  } as const;
}

export function manifestFor(context: ManifestContext): DiagnosticManifestType {
  const { request, root, acc, captureId, createdAt, logs } = context;
  const limit = request.limits ?? DEFAULT_DIAGNOSTIC_LIMITS;
  const sources = sourceProjection(acc, root, request, logs);
  return DiagnosticManifest.parse({
    schemaVersion: DIAGNOSTIC_EXPORT_SCHEMA_VERSION,
    captureId,
    createdAt,
    status: statusFor(acc, root, request, logs),
    redaction: {
      mode: request.redactionMode,
      rawIncluded: request.redactionMode === 'none',
      limitations: [
        'Redaction is best-effort and cannot guarantee complete anonymization.',
        'Provider-hidden reasoning is never reconstructed or claimed.',
      ],
    },
    boundary: boundaryFor(root, acc, request, limit),
    counts: {
      sessions: acc.sessions.length,
      auditEvents: acc.auditEvents,
      hostMessages: acc.hostMessages,
      logEntries: logs?.entries.length ?? 0,
      warnings: acc.warnings.length,
    },
    sources: {
      discovery: discoverySource(acc, sources.discovery),
      lineage: lineageSource(acc, sources.lineage),
      canonicalState: canonicalStateSource(acc, sources.canonicalState),
      audit: auditSource(acc, sources.audit),
      hostHistory: hostHistorySource(acc, request, sources.hostHistory),
      logs: logsSource(acc, request, logs, sources.logs),
    },
    files: acc.receipts,
    warnings: acc.warnings.map((entry) => ({
      ...entry,
      message: sanitizeDiagnosticString(entry.message),
    })),
  });
}
