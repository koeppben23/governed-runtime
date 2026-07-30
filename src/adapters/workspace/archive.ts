/**
 * @module workspace/archive
 * @description Creates complete raw-evidence Archive Layout v2 packages.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { atomicWrite, readState } from '../persistence.js';
import { appendAuditEvent, readAuditTrail } from '../persistence-audit.js';
import { hashBuffer } from '../../shared/hashing.js';
import { getAdapterLogger } from '../../logging/adapter-logger.js';
import { readConfig } from '../persistence-config.js';
import { verifyEvidenceArtifacts } from './evidence-artifacts.js';
import { WorkspaceError, validateFingerprint, validateSessionId } from './types.js';
import { workspacesHome, sessionDir } from './init.js';
import { withSpan, addFingerprint, addSessionId } from '../../telemetry/index.js';
import { createArchiveStaging } from './archive-staging.js';
import { listSessionFiles } from './archive-files.js';
import { archiveArtifactPath } from './archive-layout.js';
import type { RedactionMode } from '../../redaction/export-redaction.js';
import {
  type ArtifactBindingEntry,
  ARTIFACT_BINDING_EVENT,
  ARTIFACT_BINDING_SCHEMA_VERSION,
} from './archive-artifact-binding.js';
import { findBindingArtifacts } from './archive-verify-helpers.js';

export interface ArchiveSessionOptions {
  readonly redactionMode: RedactionMode;
  readonly includeRaw: boolean;
}

export async function archiveSession(
  fingerprint: string,
  sessionId: string,
  opts: ArchiveSessionOptions,
): Promise<string> {
  return withSpan(
    'archive.create',
    async () => {
      addFingerprint(fingerprint);
      addSessionId(sessionId);
      return archiveSessionImpl(fingerprint, sessionId, opts);
    },
    { 'flowguard.fingerprint': fingerprint, 'flowguard.session_id': sessionId },
  );
}

function validateArchiveOptions(
  opts: ArchiveSessionOptions,
  config: Awaited<ReturnType<typeof readConfig>>,
): void {
  const { redactionMode, includeRaw } = opts;
  const rc = config.archive.redaction ?? {
    allowedModes: ['none', 'basic', 'pseudonymous'] as const,
    allowRawExport: false,
    maxAuditEvents: 10_000,
  };

  if (!rc.allowedModes.includes(redactionMode)) {
    throw new WorkspaceError(
      'ARCHIVE_FAILED',
      `Redaction mode '${redactionMode}' is not allowed (config allows: ${rc.allowedModes.join(', ')}).`,
    );
  }

  if (redactionMode === 'none' && !includeRaw) {
    throw new WorkspaceError(
      'ARCHIVE_FAILED',
      'Invalid combination: redactionMode=none requires includeRaw=true. Choose basic or pseudonymous for redacted-only export.',
    );
  }

  if (includeRaw && !rc.allowRawExport) {
    throw new WorkspaceError(
      'ARCHIVE_FAILED',
      'Raw export is not enabled. Set archive.redaction.allowRawExport=true in flowguard.json.',
    );
  }
}

async function archiveSessionImpl(
  fingerprint: string,
  sessionId: string,
  opts: ArchiveSessionOptions,
): Promise<string> {
  validateFingerprint(fingerprint);
  const validSessionId = validateSessionId(sessionId);
  const sessDir = sessionDir(fingerprint, validSessionId);
  const archiveDir = path.join(workspacesHome(), fingerprint, 'sessions', 'archive');
  const archivePath = path.join(archiveDir, `${validSessionId}.tar.gz`);
  try {
    await fs.access(sessDir);
    await fs.mkdir(archiveDir, { recursive: true });
  } catch (error) {
    throw new WorkspaceError(
      'ARCHIVE_FAILED',
      `Archive setup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const state = await readState(sessDir);
  if (state) await verifyEvidenceArtifacts(sessDir, state);
  const archiveConfig = await readConfig();
  validateArchiveOptions(opts, archiveConfig);

  await appendArtifactBindingAuditEvent(sessDir, validSessionId, state);
  const { events, skipped } = await readAuditTrail(sessDir);
  if (skipped > 0) {
    throw new WorkspaceError(
      'ARCHIVE_FAILED',
      `Refusing to archive an audit trail with ${skipped} unparseable line(s)`,
    );
  }

  if (
    opts.redactionMode !== 'none' &&
    events.length > (archiveConfig.archive.redaction?.maxAuditEvents ?? 10_000)
  ) {
    throw new WorkspaceError(
      'ARCHIVE_FAILED',
      `Audit trail length (${events.length}) exceeds maxAuditEvents (${archiveConfig.archive.redaction?.maxAuditEvents ?? 10_000}). Increase archive.redaction.maxAuditEvents or reduce the audit trail.`,
    );
  }

  const staging = await createArchiveStaging({
    archiveDir,
    sessionId: validSessionId,
    fingerprint,
    sessDir,
    state,
    events,
    redactionMode: opts.redactionMode,
    includeRaw: opts.includeRaw,
  });
  try {
    await createArchiveBundle(staging.stagingRoot, validSessionId, archivePath);
    await writeArchiveChecksum(archivePath, `${archivePath}.sha256`, state);
  } finally {
    await fs.rm(staging.stagingRoot, { recursive: true, force: true });
  }
  getAdapterLogger().info('archive', 'archive_created', {
    sessionId: validSessionId,
    layoutVersion: 2,
  });
  return archivePath;
}

async function createArchiveBundle(
  stagingRoot: string,
  sessionId: string,
  archivePath: string,
): Promise<void> {
  try {
    await promisify(execFile)('tar', ['czf', archivePath, '-C', stagingRoot, sessionId], {
      timeout: 30_000,
      windowsHide: true,
    });
  } catch (error) {
    throw new WorkspaceError(
      'ARCHIVE_FAILED',
      `tar command failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function writeArchiveChecksum(
  archivePath: string,
  checksumPath: string,
  state: import('../../state/schema.js').SessionState | null,
): Promise<void> {
  try {
    await atomicWrite(
      checksumPath,
      `${hashBuffer(await fs.readFile(archivePath))}  ${path.basename(archivePath)}\n`,
    );
  } catch (error) {
    if (state?.policySnapshot?.mode === 'regulated') {
      throw new WorkspaceError(
        'ARCHIVE_FAILED',
        `Checksum sidecar write failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

async function appendArtifactBindingAuditEvent(
  sessDir: string,
  sessionId: string,
  state: import('../../state/schema.js').SessionState | null,
): Promise<void> {
  const artifacts = await collectArtifactBindings(sessDir);
  if (artifacts.length === 0) return;
  const { events } = await readAuditTrail(sessDir);
  const previous = findBindingArtifacts(events);
  if (bindingMatches(previous, artifacts)) return;
  await appendAuditEvent(sessDir, {
    id: crypto.randomUUID(),
    sessionId,
    phase: state?.phase ?? 'unknown',
    event: ARTIFACT_BINDING_EVENT,
    timestamp: new Date().toISOString(),
    actor: 'system',
    detail: {
      kind: 'archive_artifact_binding',
      schemaVersion: ARTIFACT_BINDING_SCHEMA_VERSION,
      artifactCount: artifacts.length,
      artifacts,
    },
  });
}

function bindingMatches(
  previous: unknown[] | undefined,
  current: readonly ArtifactBindingEntry[],
): boolean {
  if (!previous || previous.length !== current.length) return false;
  const prior = new Set(previous.map((entry) => JSON.stringify(entry)));
  return current.every((entry) => prior.has(JSON.stringify(entry)));
}

async function collectArtifactBindings(sessDir: string): Promise<ArtifactBindingEntry[]> {
  const files = (await listSessionFiles(sessDir)).filter((file) => file.startsWith('artifacts/'));
  return Promise.all(
    files.map(async (file) => ({
      path: archiveArtifactPath(path.posix.basename(file)),
      sha256: hashBuffer(await fs.readFile(path.join(sessDir, file))),
      artifactType: path.posix.basename(file).split('.')[0] ?? null,
    })),
  );
}
