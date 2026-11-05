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
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { verifyChain } from '../../audit/integrity.js';
import { readAuditTrail } from '../persistence-audit.js';
import { resolveSessionAuthority, type SessionAuthorityResolution } from '../session-authority.js';
import { validateSessionId } from '../workspace/types.js';
import { hashBuffer } from '../../shared/hashing.js';
import { sanitizeDiagnosticString } from '../../logging/redact.js';
import {
  redactAuditEvent,
  redactDiagnosticPayload,
  redactSessionState,
  type RedactionMode,
} from '../../redaction/export-redaction.js';
import {
  DIAGNOSTIC_EXPORT_SCHEMA_VERSION,
  DEFAULT_DIAGNOSTIC_LIMITS,
  DiagnosticManifest,
  DiagnosticSessionGraph,
  DiagnosticTimeline,
  type DiagnosticCaptureStatus,
  type DiagnosticExportLimits,
  type DiagnosticManifest as DiagnosticManifestType,
  type DiagnosticSessionGraph as DiagnosticSessionGraphType,
  type DiagnosticTimeline as DiagnosticTimelineType,
  type DiagnosticWarning,
} from './export-schema.js';
import type { HostTranscript } from './host-transcript.js';
import type { AuditEvent } from '../../state/evidence-audit.js';
import type { SessionState } from '../../state/schema.js';
import { projectReviewAssurance } from './review-projection.js';

type DiagnosticHostReader = (sessionId: string) => Promise<HostTranscript>;

export interface DiagnosticExportRequest {
  readonly root: string;
  readonly sessionId: string;
  readonly outputDir: string;
  readonly redactionMode: RedactionMode;
  readonly includeHost: boolean;
  readonly limits?: DiagnosticExportLimits;
  readonly hostReader?: DiagnosticHostReader;
  /** Deterministic test seam; production uses the current clock. */
  readonly now?: () => Date;
  readonly captureId?: string;
}

export interface DiagnosticExportResult {
  readonly outputDir: string;
  readonly manifest: DiagnosticManifestType;
}

export type DiagnosticExportErrorCode =
  'OUTPUT_EXISTS' | 'OUTPUT_INVALID' | 'WRITE_FAILED' | 'INVALID_SESSION_ID';

export class DiagnosticExportError extends Error {
  readonly code: DiagnosticExportErrorCode;

  constructor(code: DiagnosticExportErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DiagnosticExportError';
    this.code = code;
  }
}

interface SessionCapture {
  readonly sessionId: string;
  readonly parentSessionId: string | null;
  readonly role: 'root' | 'reviewer' | 'continuation';
  readonly discoveredBy: readonly DiscoverySource[];
  readonly authority: SessionAuthorityResolution;
  readonly state: SessionState | null;
  readonly audit: readonly AuditEvent[];
  readonly auditValid: boolean | null;
  readonly host: HostTranscript | null;
  readonly hostRequested: boolean;
}

interface CaptureAccumulator {
  readonly sessions: SessionCapture[];
  readonly warnings: DiagnosticWarning[];
  readonly receipts: Array<{ path: string; sha256: string; bytes: number }>;
  auditEvents: number;
  hostMessages: number;
  truncated: boolean;
}

function warning(
  code: string,
  message: string,
  sessionId: string | null,
  source: DiagnosticWarning['source'],
): DiagnosticWarning {
  return { code, message, sessionId, source };
}

type DiscoverySource =
  'root' | 'review_invocation' | 'review_attempt' | 'review_observation' | 'host_parent';

interface SessionDiscovery {
  readonly sources: DiscoverySource[];
  readonly parentSessionId: string | null;
}

function discoveredSessionIds(state: SessionState | null): Map<string, SessionDiscovery> {
  const found = new Map<string, SessionDiscovery>();
  if (!state?.reviewAssurance) return found;
  const add = (
    sessionId: string | undefined,
    source: DiscoverySource,
    parentSessionId: string | null,
  ) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return;
    const existing = found.get(sessionId);
    const sources = existing?.sources ?? [];
    if (!sources.includes(source)) sources.push(source);
    found.set(sessionId, {
      sources,
      parentSessionId: existing?.parentSessionId ?? parentSessionId,
    });
  };
  for (const invocation of state.reviewAssurance.invocations) {
    add(invocation.childSessionId, 'review_invocation', invocation.parentSessionId);
  }
  for (const attempt of state.reviewAssurance.attempts) {
    add(attempt.childSessionId, 'review_attempt', null);
    for (const observation of attempt.observations) {
      add(observation.observedBySessionId, 'review_observation', null);
    }
  }
  return found;
}

async function readAudit(sessionId: string, sessDir: string, acc: CaptureAccumulator) {
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
    return { audit, valid: chain.valid as boolean | null };
  } catch (error) {
    acc.warnings.push(
      warning(
        'AUDIT_READ_FAILED',
        `Audit trail could not be read: ${error instanceof Error ? error.message : String(error)}`,
        sessionId,
        'audit',
      ),
    );
    return { audit: [] as AuditEvent[], valid: null };
  }
}

async function readHost(
  sessionId: string,
  request: DiagnosticExportRequest,
  acc: CaptureAccumulator,
): Promise<HostTranscript | null> {
  if (!request.includeHost || request.hostReader === undefined) return null;
  try {
    const transcript = await request.hostReader(sessionId);
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
    role: meta.role,
    discoveredBy: meta.discoveredBy,
    authority,
    state,
    audit: auditResult.audit,
    auditValid: auditResult.valid,
    host,
    hostRequested: request.includeHost,
  };
}

function statusFor(acc: CaptureAccumulator, root: SessionCapture): DiagnosticCaptureStatus {
  if (root.authority.status !== 'resolved') return 'NOT_VERIFIED';
  const unavailable = acc.sessions.some((item) => item.authority.status === 'unavailable');
  const hostFailed = acc.warnings.some((item) => item.code === 'HOST_HISTORY_UNAVAILABLE');
  if (acc.truncated || unavailable || hostFailed || acc.warnings.length > 0) return 'PARTIAL';
  return 'COMPLETE';
}

function graphFor(root: SessionCapture, acc: CaptureAccumulator): DiagnosticSessionGraphType {
  return {
    schemaVersion: DIAGNOSTIC_EXPORT_SCHEMA_VERSION,
    rootSessionId: root.sessionId,
    sessions: acc.sessions.map((item) => ({
      sessionId: item.sessionId,
      parentSessionId: item.parentSessionId,
      role: item.role,
      discoveredBy: [...item.discoveredBy],
      state:
        item.authority.status === 'resolved'
          ? 'captured'
          : item.authority.status === 'absent'
            ? 'absent'
            : 'unavailable',
      phase: item.state?.phase ?? null,
      binding: item.authority.status === 'resolved' ? 'verified' : 'unknown',
      hostHistory: item.host ? 'captured' : item.hostRequested ? 'unavailable' : 'not_requested',
      warningCodes: acc.warnings
        .filter((entry) => entry.sessionId === item.sessionId)
        .map((entry) => entry.code),
    })),
  };
}

function timelineFor(acc: CaptureAccumulator, createdAt: string): DiagnosticTimelineType {
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

async function writeArtifact(
  outputDir: string,
  relativePath: string,
  content: string | Buffer,
  acc: CaptureAccumulator,
): Promise<void> {
  const full = path.join(outputDir, relativePath);
  await mkdir(path.dirname(full), { recursive: true, mode: 0o700 });
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  try {
    await writeFile(full, bytes, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    throw new DiagnosticExportError(
      'WRITE_FAILED',
      `Cannot write diagnostic artifact ${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  acc.receipts.push({
    path: relativePath.replace(/\\/g, '/'),
    sha256: hashBuffer(bytes),
    bytes: bytes.byteLength,
  });
}

function artifactName(base: string, extension: string, mode: RedactionMode): string {
  return `${base}${mode === 'none' ? '' : '.redacted'}${extension}`;
}

async function writeSessionArtifacts(
  outputDir: string,
  session: SessionCapture,
  mode: RedactionMode,
  acc: CaptureAccumulator,
  createdAt: string,
): Promise<void> {
  const sessionDir = `sessions/${validateSessionId(session.sessionId)}`;
  if (session.state !== null) {
    const redacted = redactSessionState(session.state, mode);
    await writeArtifact(
      outputDir,
      `${sessionDir}/${artifactName('state', '.json', mode)}`,
      `${JSON.stringify(redacted, null, 2)}\n`,
      acc,
    );
    const review = projectReviewAssurance(session.state);
    if (review !== null) {
      await writeArtifact(
        outputDir,
        `${sessionDir}/review-assurance.json`,
        `${JSON.stringify(review, null, 2)}\n`,
        acc,
      );
    }
  }
  if (session.audit.length > 0) {
    const lines = session.audit.map((event) =>
      JSON.stringify(redactAuditEvent(event as unknown as Record<string, unknown>, mode)),
    );
    await writeArtifact(
      outputDir,
      `${sessionDir}/${artifactName('audit', '.jsonl', mode)}`,
      `${lines.join('\n')}\n`,
      acc,
    );
  }
  if (session.host !== null) {
    const redacted = redactDiagnosticPayload(session.host.payload, mode);
    await writeArtifact(
      outputDir,
      `${sessionDir}/${artifactName('host.transcript', '.json', mode)}`,
      `${JSON.stringify(redacted, null, 2)}\n`,
      acc,
    );
  }
  await writeArtifact(
    outputDir,
    `${sessionDir}/session.json`,
    `${JSON.stringify(
      {
        schemaVersion: DIAGNOSTIC_EXPORT_SCHEMA_VERSION,
        sessionId: session.sessionId,
        capturedAt: createdAt,
        authority: session.authority.status,
        ...(session.authority.status === 'resolved'
          ? {
              fingerprint: session.authority.fingerprint,
              worktreeName: path.basename(session.authority.worktreeRoot),
            }
          : {}),
        auditChain:
          session.auditValid === null ? 'NOT_VERIFIED' : session.auditValid ? 'valid' : 'invalid',
        hostHistory: session.hostRequested
          ? session.host
            ? 'captured'
            : 'unavailable'
          : 'not_requested',
      },
      null,
      2,
    )}\n`,
    acc,
  );
}

function manifestFor(
  request: DiagnosticExportRequest,
  root: SessionCapture,
  acc: CaptureAccumulator,
  captureId: string,
  createdAt: string,
): DiagnosticManifestType {
  const limit = request.limits ?? DEFAULT_DIAGNOSTIC_LIMITS;
  const withState = acc.sessions.filter((item) => item.authority.status === 'resolved').length;
  const unavailable = acc.sessions.filter((item) => item.authority.status === 'unavailable').length;
  const hostRequested = request.includeHost && request.hostReader !== undefined;
  const hostCaptured = acc.sessions.some((item) => item.host !== null);
  return DiagnosticManifest.parse({
    schemaVersion: DIAGNOSTIC_EXPORT_SCHEMA_VERSION,
    captureId,
    createdAt,
    status: statusFor(acc, root),
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
        root.authority.status === 'unavailable' ? null : root.authority.fingerprint,
      worktreeName:
        root.authority.status === 'unavailable' ? null : path.basename(root.authority.worktreeRoot),
      sessionsKnown: acc.sessions.length,
      sessionsWithState: withState,
      sessionsWithoutState: acc.sessions.length - withState - unavailable,
      sessionsUnavailable: unavailable,
      maxSessions: limit.maxSessions,
      maxFileBytes: limit.maxFileBytes,
      hostHistory: hostRequested ? (hostCaptured ? 'included' : 'unavailable') : 'not_requested',
    },
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
  });
  acc.sessions.push(root);
  for (const [sessionId, discovery] of discoveredSessionIds(root.state)) {
    if (sessionId === request.sessionId) continue;
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
    acc.sessions.push(
      await captureOne(sessionId, request.root, request, acc, {
        role: 'reviewer',
        discoveredBy: discovery.sources,
        parentSessionId: discovery.parentSessionId,
      }),
    );
  }
  return root;
}

async function writeAllSessionArtifacts(
  request: DiagnosticExportRequest,
  acc: CaptureAccumulator,
  createdAt: string,
): Promise<void> {
  for (const session of acc.sessions) {
    try {
      await writeSessionArtifacts(
        request.outputDir,
        session,
        request.redactionMode,
        acc,
        createdAt,
      );
    } catch (error) {
      if (error instanceof DiagnosticExportError) throw error;
      throw new DiagnosticExportError(
        'WRITE_FAILED',
        `Cannot write session artifacts: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
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
  await writeArtifact(
    request.outputDir,
    'diagnostics/log-files.json',
    `${JSON.stringify(
      {
        schemaVersion: DIAGNOSTIC_EXPORT_SCHEMA_VERSION,
        directory: null,
        status: 'NOT_VERIFIED',
        note: 'Host log files are not copied into a diagnostic snapshot; inspect them locally through the host surface.',
      },
      null,
      2,
    )}\n`,
    acc,
  );
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
    truncated: false,
  };
  const root = await collectSessions(request, limit, acc);
  await writeAllSessionArtifacts(request, acc, createdAt);
  await writeIndexArtifacts(request, root, acc, createdAt);

  const manifest = manifestFor(request, root, acc, request.captureId ?? randomUUID(), createdAt);
  await writeArtifact(
    request.outputDir,
    'manifest.json',
    `${JSON.stringify(manifest, null, 2)}\n`,
    acc,
  );
  return { outputDir: request.outputDir, manifest };
}
