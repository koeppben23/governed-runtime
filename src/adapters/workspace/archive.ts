/**
 * @module workspace/archive
 * @description Creates Archive Layout v2 packages for raw evidence or redacted sharing.
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
import { ARCHIVE_MANIFEST_FILE, archiveArtifactPath } from './archive-layout.js';
import type { RedactionMode } from '../../redaction/export-redaction.js';
import {
  type ArtifactBindingEntry,
  ARTIFACT_BINDING_EVENT,
  ARTIFACT_BINDING_SCHEMA_VERSION,
  ARCHIVE_PUBLICATION_BINDING_EVENT,
  ARCHIVE_PUBLICATION_BINDING_SCHEMA_VERSION,
  archivePublicationBinding,
  type ArchivePublicationBinding,
} from './archive-artifact-binding.js';
import {
  findBindingArtifacts,
  findPublicationBinding,
  lastPublicationBinding,
} from './archive-verify-helpers.js';
import { inspectArchiveTar } from './archive-tar.js';
import { publishArchiveArtifacts, removeArchiveArtifacts } from './archive-publish.js';

export interface ArchiveSessionOptions {
  readonly redactionMode: RedactionMode;
  readonly includeRaw: boolean;
}

export function archiveFileName(sessionId: string, regulatedEvidence = false): string {
  return `${regulatedEvidence ? 'regulated-' : ''}${sessionId}.tar.gz`;
}

export async function archiveSession(
  fingerprint: string,
  sessionId: string,
  opts: ArchiveSessionOptions,
): Promise<string> {
  return archiveWithAuthorization(fingerprint, sessionId, opts, false);
}

/**
 * Create the mandatory raw-evidence package for a regulated completion.
 *
 * This is intentionally separate from the user-requested archive API: the
 * regulated completion service is the only production caller. It is not a
 * configurable sharing export and is not re-exported by the workspace barrel.
 */
export async function archiveRegulatedEvidence(
  fingerprint: string,
  sessionId: string,
): Promise<string> {
  return archiveWithAuthorization(
    fingerprint,
    sessionId,
    { redactionMode: 'none', includeRaw: true },
    true,
  );
}

async function archiveWithAuthorization(
  fingerprint: string,
  sessionId: string,
  opts: ArchiveSessionOptions,
  regulatedEvidence: boolean,
): Promise<string> {
  return withSpan(
    'archive.create',
    async () => {
      addFingerprint(fingerprint);
      addSessionId(sessionId);
      return archiveSessionImpl(fingerprint, sessionId, opts, regulatedEvidence);
    },
    { 'flowguard.fingerprint': fingerprint, 'flowguard.session_id': sessionId },
  );
}

function validateArchiveOptions(
  opts: ArchiveSessionOptions,
  config: Awaited<ReturnType<typeof readConfig>>,
  rawEvidenceAuthorized: boolean,
): void {
  const { redactionMode, includeRaw } = opts;
  const rc = config.archive.redaction;

  if (!rawEvidenceAuthorized && !rc.allowedModes.includes(redactionMode)) {
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

  if (includeRaw && !rc.allowRawExport && !rawEvidenceAuthorized) {
    throw new WorkspaceError(
      'ARCHIVE_FAILED',
      'Raw export is not enabled. Set archive.redaction.allowRawExport=true in flowguard.json.',
    );
  }
}

function assertRegulatedEvidenceState(
  state: import('../../state/schema.js').SessionState | null,
): void {
  if (state?.policySnapshot.mode === 'regulated' && !state.error) {
    return;
  }
  throw new WorkspaceError(
    'ARCHIVE_FAILED',
    'Mandatory regulated evidence archive requires a clean regulated session.',
  );
}

function assertCompletionAuditEvent(
  events: readonly { readonly event: string; readonly detail: Record<string, unknown> }[],
): void {
  if (
    events.some(
      (event) =>
        event.event === 'lifecycle:session_completed' &&
        event.detail.action === 'session_completed',
    )
  ) {
    return;
  }
  throw new WorkspaceError(
    'ARCHIVE_FAILED',
    'Mandatory regulated evidence archive requires the canonical session_completed audit event.',
  );
}

async function archiveSessionImpl(
  fingerprint: string,
  sessionId: string,
  opts: ArchiveSessionOptions,
  regulatedEvidence: boolean,
): Promise<string> {
  validateFingerprint(fingerprint);
  const validSessionId = validateSessionId(sessionId);
  const sessDir = sessionDir(fingerprint, validSessionId);
  const archiveDir = path.join(workspacesHome(), fingerprint, 'sessions', 'archive');
  const archivePath = path.join(archiveDir, archiveFileName(validSessionId, regulatedEvidence));
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
  if (regulatedEvidence) assertRegulatedEvidenceState(state);
  const archiveConfig = regulatedEvidence ? undefined : await readConfig();
  if (archiveConfig) validateArchiveOptions(opts, archiveConfig, false);

  await appendArtifactBindingAuditEvent(sessDir, validSessionId, state);
  const { events, skipped } = await readAuditTrail(sessDir);
  if (skipped > 0) {
    throw new WorkspaceError(
      'ARCHIVE_FAILED',
      `Refusing to archive an audit trail with ${skipped} unparseable line(s)`,
    );
  }
  if (regulatedEvidence) assertCompletionAuditEvent(events);

  if (
    opts.redactionMode !== 'none' &&
    events.length > archiveConfig!.archive.redaction.maxAuditEvents
  ) {
    throw new WorkspaceError(
      'ARCHIVE_FAILED',
      `Audit trail length (${events.length}) exceeds maxAuditEvents (${archiveConfig!.archive.redaction.maxAuditEvents}). Increase archive.redaction.maxAuditEvents or reduce the audit trail.`,
    );
  }

  await stagePublishAndBind({
    archiveDir,
    archivePath,
    fingerprint,
    sessionId: validSessionId,
    sessDir,
    state,
    events,
    redactionMode: opts.redactionMode,
    includeRaw: opts.includeRaw,
  });
  getAdapterLogger().info('archive', 'archive_created', {
    sessionId: validSessionId,
    layoutVersion: 2,
  });
  return archivePath;
}

async function stagePublishAndBind(input: {
  readonly archiveDir: string;
  readonly archivePath: string;
  readonly fingerprint: string;
  readonly sessionId: string;
  readonly sessDir: string;
  readonly state: import('../../state/schema.js').SessionState | null;
  readonly events: Awaited<ReturnType<typeof readAuditTrail>>['events'];
  readonly redactionMode: RedactionMode;
  readonly includeRaw: boolean;
}): Promise<void> {
  // Publication bindings are external authorities and must never alter the
  // self-contained v2 audit snapshot they attest.
  const archiveEvents = input.events.filter(
    (event) => event.event !== ARCHIVE_PUBLICATION_BINDING_EVENT,
  );
  const staging = await createArchiveStaging({
    archiveDir: input.archiveDir,
    sessionId: input.sessionId,
    fingerprint: input.fingerprint,
    sessDir: input.sessDir,
    state: input.state,
    events: archiveEvents,
    redactionMode: input.redactionMode,
    includeRaw: input.includeRaw,
  });
  const temporaryArchivePath = `${input.archivePath}.${crypto.randomUUID()}.tmp`;
  const checksumPath = `${input.archivePath}.sha256`;
  const temporaryChecksumPath = `${checksumPath}.${crypto.randomUUID()}.tmp`;
  const archiveArtifacts = {
    archivePath: input.archivePath,
    checksumPath,
    temporaryArchivePath,
    temporaryChecksumPath,
  };
  const existingPublication = lastPublicationBinding(input.events);
  try {
    let publication: ArchivePublicationBinding;
    try {
      publication = await createAndPublishArchive(
        staging,
        input.sessionId,
        archiveArtifacts,
        staging.manifest.contentDigest,
        existingPublication,
      );
    } catch (error) {
      await removeArchiveArtifacts(archiveArtifacts);
      throw error;
    }
    if (existingPublication?.publicationId === publication.publicationId) return;
    await appendPublicationBindingAuditEvent(
      input.sessDir,
      input.sessionId,
      input.state,
      publication,
    );
  } finally {
    await fs.rm(staging.stagingRoot, { recursive: true, force: true });
  }
}

async function createAndPublishArchive(
  staging: Awaited<ReturnType<typeof createArchiveStaging>>,
  sessionId: string,
  artifacts: {
    readonly archivePath: string;
    readonly checksumPath: string;
    readonly temporaryArchivePath: string;
    readonly temporaryChecksumPath: string;
  },
  manifestContentDigest: string,
  existingPublication: ArchivePublicationBinding | undefined,
): Promise<ArchivePublicationBinding> {
  await createArchiveBundle(
    staging.stagingRoot,
    sessionId,
    staging.manifest.includedFiles,
    artifacts.temporaryArchivePath,
  );
  await writeArchiveChecksum(
    artifacts.temporaryArchivePath,
    artifacts.temporaryChecksumPath,
    path.basename(artifacts.archivePath),
  );
  const publication = await publicationBindingFor(
    artifacts.temporaryArchivePath,
    artifacts.temporaryChecksumPath,
    path.basename(artifacts.archivePath),
    manifestContentDigest,
  );
  if (
    existingPublication?.publicationId === publication.publicationId &&
    (await publishedArtifactsMatch(artifacts, existingPublication))
  ) {
    await fs.rm(artifacts.temporaryArchivePath, { force: true });
    await fs.rm(artifacts.temporaryChecksumPath, { force: true });
    return publication;
  }
  await Promise.all([
    fs.rm(artifacts.archivePath, { force: true }),
    fs.rm(artifacts.checksumPath, { force: true }),
  ]);
  await publishArchiveArtifacts(artifacts);
  return publication;
}

async function publicationBindingFor(
  archivePath: string,
  checksumPath: string,
  archiveFile: string,
  manifestContentDigest: string,
): Promise<ArchivePublicationBinding> {
  const [archive, sidecar] = await Promise.all([
    fs.readFile(archivePath),
    fs.readFile(checksumPath),
  ]);
  return archivePublicationBinding(archive, sidecar, archiveFile, manifestContentDigest);
}

async function publishedArtifactsMatch(
  paths: { readonly archivePath: string; readonly checksumPath: string },
  expected: ArchivePublicationBinding,
): Promise<boolean> {
  try {
    const actual = await publicationBindingFor(
      paths.archivePath,
      paths.checksumPath,
      expected.archiveFile,
      expected.manifestContentDigest,
    );
    return actual.publicationId === expected.publicationId;
  } catch {
    return false;
  }
}

async function createArchiveBundle(
  stagingRoot: string,
  sessionId: string,
  includedFiles: readonly string[],
  archivePath: string,
): Promise<void> {
  const members = await resolveArchiveMembers(stagingRoot, sessionId, includedFiles);
  try {
    await promisify(execFile)(
      'tar',
      ['--format=ustar', '-czf', archivePath, '-C', stagingRoot, ...members],
      {
        timeout: 30_000,
        windowsHide: true,
        env: { ...process.env, COPYFILE_DISABLE: '1' },
      },
    );
    const inspection = await inspectArchiveTar(archivePath, sessionId, members);
    if (inspection.kind === 'blocked') {
      throw new WorkspaceError(
        'ARCHIVE_FAILED',
        `archive bundle verification failed: ${inspection.reason}`,
      );
    }
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    throw new WorkspaceError(
      'ARCHIVE_FAILED',
      `tar command failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function resolveArchiveMembers(
  stagingRoot: string,
  sessionId: string,
  includedFiles: readonly string[],
): Promise<string[]> {
  const relativeMembers = [...includedFiles, ARCHIVE_MANIFEST_FILE];
  if (new Set(relativeMembers).size !== relativeMembers.length) {
    throw new WorkspaceError('ARCHIVE_FAILED', 'Archive manifest contains duplicate member paths.');
  }

  const archiveRoot = path.resolve(stagingRoot, sessionId);
  const members: string[] = [];
  for (const relativePath of relativeMembers) {
    if (!isSafeArchiveMemberPath(relativePath)) {
      throw new WorkspaceError(
        'ARCHIVE_FAILED',
        `Archive manifest has unsafe member path: ${relativePath}`,
      );
    }
    const member = path.posix.join(sessionId, relativePath);
    const fullPath = path.resolve(stagingRoot, member);
    if (!fullPath.startsWith(`${archiveRoot}${path.sep}`)) {
      throw new WorkspaceError(
        'ARCHIVE_FAILED',
        `Archive member escapes staging root: ${relativePath}`,
      );
    }
    let stat: import('node:fs').Stats;
    try {
      stat = await fs.lstat(fullPath);
    } catch {
      throw new WorkspaceError('ARCHIVE_FAILED', `Archive member is missing: ${relativePath}`);
    }
    if (!stat.isFile()) {
      throw new WorkspaceError(
        'ARCHIVE_FAILED',
        `Archive member is not a regular file: ${relativePath}`,
      );
    }
    members.push(member);
  }
  return members;
}

function isSafeArchiveMemberPath(relativePath: string): boolean {
  return (
    relativePath.length > 0 &&
    !path.posix.isAbsolute(relativePath) &&
    !relativePath
      .split('/')
      .some((segment) => segment.length === 0 || segment === '.' || segment === '..') &&
    !relativePath.includes('\\')
  );
}

async function writeArchiveChecksum(
  archivePath: string,
  checksumPath: string,
  archiveFileName: string,
): Promise<void> {
  try {
    await atomicWrite(
      checksumPath,
      `${hashBuffer(await fs.readFile(archivePath))}  ${archiveFileName}\n`,
    );
  } catch (error) {
    throw new WorkspaceError(
      'ARCHIVE_FAILED',
      `Checksum sidecar write failed: ${error instanceof Error ? error.message : String(error)}`,
    );
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

async function appendPublicationBindingAuditEvent(
  sessDir: string,
  sessionId: string,
  state: import('../../state/schema.js').SessionState | null,
  publication: ArchivePublicationBinding,
): Promise<void> {
  const { events } = await readAuditTrail(sessDir);
  if (findPublicationBinding(events, publication)) return;
  await appendAuditEvent(sessDir, {
    id: crypto.randomUUID(),
    sessionId,
    phase: state?.phase ?? 'unknown',
    event: ARCHIVE_PUBLICATION_BINDING_EVENT,
    timestamp: new Date().toISOString(),
    actor: 'system',
    detail: {
      kind: 'archive_publication_binding',
      schemaVersion: ARCHIVE_PUBLICATION_BINDING_SCHEMA_VERSION,
      ...publication,
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
