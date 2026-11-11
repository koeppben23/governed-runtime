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
  DEFAULT_MAX_DISCOVERY_NODES,
  DIAGNOSTIC_EXPORT_SCHEMA_VERSION,
  DiagnosticSessionGraph,
  DiagnosticTimeline,
  type DiagnosticExportLimits,
} from './export-schema.js';
import { DiagnosticExportError } from './errors.js';
import { manifestFor } from './manifest.js';
import { writeAllSessionArtifacts, writeArtifact } from './artifact-writer.js';
import { captureAndWriteLogs } from './log-artifacts.js';
import {
  warning,
  type CaptureAccumulator,
  type DiagnosticHostReader,
  type DiscoverySource,
  type SessionCapture,
} from './types.js';
import { discoverSessionTree, type DiscoveredSession } from './session-discovery.js';
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
  const remaining = acc.deadlineAt - (request.now ?? (() => new Date()))().getTime();
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

function pushDiscoveryWarnings(acc: CaptureAccumulator, discovered: DiscoveredSession): void {
  acc.warnings.push(...discovered.warnings);
}

function uncapturedSession(discovered: DiscoveredSession, acc: CaptureAccumulator): SessionCapture {
  pushDiscoveryWarnings(acc, discovered);
  return {
    sessionId: discovered.sessionId,
    parentSessionId: discovered.parentSessionId,
    generation: discovered.generation,
    captureStatus: 'not_captured',
    role: 'reviewer',
    discoveredBy: discovered.sources,
    lineage: 'not_verified',
    authority: null,
    state: null,
    audit: [],
    auditValid: null,
    host: null,
    hostRequested: false,
  };
}

function truncatedSession(
  discovered: DiscoveredSession,
  acc: CaptureAccumulator,
  code: string,
  message: string,
): SessionCapture {
  pushDiscoveryWarnings(acc, discovered);
  acc.warnings.push(warning(code, message, discovered.sessionId, 'capture'));
  return {
    sessionId: discovered.sessionId,
    parentSessionId: discovered.parentSessionId,
    generation: discovered.generation,
    captureStatus: 'truncated',
    role: 'reviewer',
    discoveredBy: discovered.sources,
    lineage: 'verified',
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
  if (root.state === null) return root;

  const clock = request.now ?? (() => new Date());
  const tree = await discoverSessionTree({
    root: request.root,
    rootSessionId: request.sessionId,
    rootState: root.state,
    ...(root.authority === null ? {} : { rootAuthority: root.authority }),
    maxNodes: limit.maxDiscoveryNodes ?? DEFAULT_MAX_DISCOVERY_NODES,
    deadlineAt: acc.deadlineAt,
    now: () => clock().getTime(),
  });
  acc.discoveryTruncated = tree.truncated;
  acc.discoveryReasons.push(...tree.reasons);
  if (tree.truncated) {
    acc.truncated = true;
    acc.warnings.push(
      warning(
        'DISCOVERY_TRUNCATED',
        `Known descendants were not fully discovered: ${tree.reasons.join('; ') || 'discovery budget reached'}`,
        null,
        'capture',
      ),
    );
  }

  let captured = 1;
  for (const discovered of tree.sessions) {
    if (discovered.sessionId === request.sessionId) continue;
    const decision = await captureDiscoveredSession({
      request,
      limit,
      acc,
      discovered,
      captured,
      clock,
    });
    acc.sessions.push(decision.capture);
    if (decision.counted) captured++;
  }
  return root;
}

interface CaptureDecision {
  readonly capture: SessionCapture;
  readonly counted: boolean;
}

interface CaptureDiscoveredInput {
  readonly request: DiagnosticExportRequest;
  readonly limit: DiagnosticExportLimits;
  readonly acc: CaptureAccumulator;
  readonly discovered: DiscoveredSession;
  readonly captured: number;
  readonly clock: () => Date;
}

async function captureDiscoveredSession(input: CaptureDiscoveredInput): Promise<CaptureDecision> {
  const { request, limit, acc, discovered, captured, clock } = input;
  if (discovered.lineage !== 'verified' || discovered.conflict) {
    return { capture: uncapturedSession(discovered, acc), counted: false };
  }
  if (captured >= limit.maxSessions) {
    acc.truncated = true;
    return {
      capture: truncatedSession(
        discovered,
        acc,
        'SESSION_LIMIT_TRUNCATED',
        `Known session ${discovered.sessionId} was not captured because the ${limit.maxSessions}-session capture limit was reached.`,
      ),
      counted: false,
    };
  }
  // A verified node whose state discovery did not read (graph-budget overflow,
  // unreadable authority, or elapsed time) must not be re-read by capture.
  if (clock().getTime() > acc.deadlineAt) {
    acc.truncated = true;
    return {
      capture: truncatedSession(
        discovered,
        acc,
        'CAPTURE_TIME_BUDGET_EXCEEDED',
        `Known session ${discovered.sessionId} was not captured because the total capture time budget was exhausted.`,
      ),
      counted: false,
    };
  }
  if (discovered.authority === null) {
    acc.truncated = true;
    return {
      capture: truncatedSession(
        discovered,
        acc,
        'SESSION_DISCOVERY_TRUNCATED',
        `Known session ${discovered.sessionId} was not captured because discovery did not read its state within the graph budget.`,
      ),
      counted: false,
    };
  }
  return {
    capture: await captureOne(discovered.sessionId, request.root, request, acc, {
      role: 'reviewer',
      discoveredBy: discovered.sources,
      parentSessionId: discovered.parentSessionId,
      generation: discovered.generation,
      lineage: discovered.lineage,
    }),
    counted: true,
  };
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
  const clock = request.now ?? (() => new Date());
  const createdAt = clock().toISOString();
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
    deadlineAt: clock().getTime() + limit.maxDurationMs,
    truncated: false,
    discoveryTruncated: false,
    discoveryReasons: [],
  };
  const root = await collectSessions(request, limit, acc);
  await writeAllSessionArtifacts(request, acc, createdAt);
  await writeIndexArtifacts(request, root, acc, createdAt);
  const logs = await captureAndWriteLogs(
    {
      outputDir: request.outputDir,
      redactionMode: request.redactionMode,
      verifiedSessionIds: acc.sessions
        .filter((session) => session.lineage === 'verified')
        .map((session) => session.sessionId),
      ...(request.logsDirectory === undefined ? {} : { logsDirectory: request.logsDirectory }),
      ...(request.logsDirectoryLabel === undefined
        ? {}
        : { logsDirectoryLabel: request.logsDirectoryLabel }),
      ...(request.now === undefined ? {} : { now: request.now }),
    },
    acc,
  );

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
