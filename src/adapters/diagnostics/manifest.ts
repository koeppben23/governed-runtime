/**
 * @module adapters/diagnostics/manifest
 * @description Completeness and manifest projection for diagnostic snapshots.
 */

import path from 'node:path';

import type { RedactionMode } from '../../redaction/export-redaction.js';
import {
  DEFAULT_DIAGNOSTIC_LIMITS,
  DIAGNOSTIC_EXPORT_SCHEMA_VERSION,
  DiagnosticManifest,
  type DiagnosticCaptureStatus,
  type DiagnosticExportLimits,
  type DiagnosticManifest as DiagnosticManifestType,
} from './export-schema.js';
import { sanitizeDiagnosticString } from '../../logging/redact.js';
import type { CaptureAccumulator, DiagnosticHostReader, SessionCapture } from './types.js';

export interface ManifestInput {
  readonly includeHost: boolean;
  readonly redactionMode: RedactionMode;
  readonly hostReader?: DiagnosticHostReader;
  readonly limits?: DiagnosticExportLimits;
}

interface CompletenessProjection {
  readonly lineage: 'complete' | 'partial' | 'not_verified';
  readonly canonicalState: 'complete' | 'partial' | 'not_verified';
  readonly hostHistory: 'complete' | 'partial' | 'not_requested' | 'not_verified';
}

function completenessFor(
  acc: CaptureAccumulator,
  root: SessionCapture,
  request: ManifestInput,
): CompletenessProjection {
  const rootResolved = root.authority?.status === 'resolved';
  const verified = acc.sessions.filter((session) => session.lineage === 'verified');
  const lineage = !rootResolved
    ? 'not_verified'
    : acc.sessions.some((session) => session.lineage === 'not_verified')
      ? 'partial'
      : 'complete';
  const canonicalState = !rootResolved
    ? 'not_verified'
    : verified.some(
          (session) =>
            session.authority?.status === 'absent' || session.authority?.status === 'unavailable',
        )
      ? 'partial'
      : 'complete';
  const hostRequested = request.includeHost && request.hostReader !== undefined;
  const hostHistory = !hostRequested
    ? 'not_requested'
    : !rootResolved
      ? 'not_verified'
      : verified.some((session) => session.host === null)
        ? 'partial'
        : 'complete';
  return { lineage, canonicalState, hostHistory };
}

function statusFor(
  acc: CaptureAccumulator,
  root: SessionCapture,
  request: ManifestInput,
): DiagnosticCaptureStatus {
  if (root.authority?.status !== 'resolved') return 'NOT_VERIFIED';
  const completeness = completenessFor(acc, root, request);
  const hostIncomplete =
    completeness.hostHistory === 'partial' || completeness.hostHistory === 'not_verified';
  if (
    acc.truncated ||
    acc.warnings.length > 0 ||
    completeness.lineage !== 'complete' ||
    completeness.canonicalState !== 'complete' ||
    hostIncomplete
  ) {
    return 'PARTIAL';
  }
  return 'COMPLETE';
}

export function manifestFor(
  request: ManifestInput,
  root: SessionCapture,
  acc: CaptureAccumulator,
  captureId: string,
  createdAt: string,
): DiagnosticManifestType {
  const limit = request.limits ?? DEFAULT_DIAGNOSTIC_LIMITS;
  const withState = acc.sessions.filter((item) => item.authority?.status === 'resolved').length;
  const unavailable = acc.sessions.filter(
    (item) => item.authority?.status === 'unavailable',
  ).length;
  const lineageUnverified = acc.sessions.filter((item) => item.lineage === 'not_verified').length;
  const hostRequested = request.includeHost && request.hostReader !== undefined;
  const hostCaptured = acc.sessions.some((item) => item.host !== null);
  return DiagnosticManifest.parse({
    schemaVersion: DIAGNOSTIC_EXPORT_SCHEMA_VERSION,
    captureId,
    createdAt,
    status: statusFor(acc, root, request),
    redaction: {
      mode: request.redactionMode,
      rawIncluded: request.redactionMode === 'none',
      limitations: [
        'Redaction is best-effort and cannot guarantee complete anonymization.',
        'Provider-hidden reasoning is never reconstructed or claimed.',
      ],
    },
    boundary: {
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
      sessionsWithoutState: acc.sessions.length - withState - unavailable,
      sessionsUnavailable: unavailable,
      sessionsLineageUnverified: lineageUnverified,
      maxSessions: limit.maxSessions,
      maxFileBytes: limit.maxFileBytes,
      maxTotalBytes: limit.maxTotalBytes,
      maxDurationMs: limit.maxDurationMs,
      hostHistory: hostRequested ? (hostCaptured ? 'included' : 'unavailable') : 'not_requested',
    },
    completeness: completenessFor(acc, root, request),
    counts: {
      sessions: acc.sessions.length,
      auditEvents: acc.auditEvents,
      hostMessages: acc.hostMessages,
      warnings: acc.warnings.length,
    },
    files: acc.receipts,
    warnings: acc.warnings.map((entry) => ({
      ...entry,
      message: sanitizeDiagnosticString(entry.message),
    })),
  });
}
