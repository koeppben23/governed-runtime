/**
 * @module workspace/archive
 * @description Creates Archive Layout v2 packages for raw evidence or redacted sharing.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readState } from '../persistence.js';
import { validateBinding } from '../binding.js';
import { appendAuditEvent, readAuditTrail } from '../persistence-audit.js';
import { hashBuffer } from '../../shared/hashing.js';
import { getAdapterLogger } from '../../logging/adapter-logger.js';
import {
  readEffectiveArchivePolicy,
  type EffectiveArchiveRedactionPolicy,
} from '../persistence-config.js';
import { verifyEvidenceArtifacts } from './evidence-artifacts.js';
import { WorkspaceError, validateFingerprint, validateSessionId } from './types.js';
import { workspacesHome, sessionDir } from './init.js';
import { withSpan, addFingerprint, addSessionId } from '../../telemetry/index.js';
import { createArchiveStaging } from './archive-staging.js';
import { listSessionFiles } from './archive-files.js';
import {
  ARCHIVE_MANIFEST_FILE,
  archiveArtifactPath,
  archiveFileName,
  type ArchivePurpose,
} from './archive-layout.js';
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
import {
  publishArchiveArtifacts,
  removeArchiveArtifacts,
  writeArchiveChecksum,
} from './archive-publish.js';

/** Redaction shape shared by every archive entrypoint. */
export interface ArchivePayloadOptions {
  readonly redactionMode: RedactionMode;
  readonly includeRaw: boolean;
}

/**
 * User-configurable archive options.
 *
 * `worktree` is required: the effective archive policy is projected from the
 * explicit global installation config (administrator ceiling) and the repo
 * `.opencode/flowguard.json` (which may only restrict). A caller without a
 * canonical worktree would silently lose the repository restriction — the exact
 * divergence this contract forbids.
 */
export interface ArchiveSessionOptions extends ArchivePayloadOptions {
  /** Canonical worktree root (authority-validated). */
  readonly worktree: string;
}

export async function archiveSession(
  fingerprint: string,
  sessionId: string,
  opts: ArchiveSessionOptions,
): Promise<string> {
  return archiveWithAuthorization(
    fingerprint,
    sessionId,
    opts,
    {
      authorizedRaw: false,
      regulatedEvidence: false,
      purpose: 'archive',
    },
    opts.worktree,
  );
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
    { authorizedRaw: true, regulatedEvidence: true, purpose: 'regulated' },
  );
}

/**
 * Create the mandatory completion export package for the canonical export rail.
 *
 * Completion is a workflow obligation, not a user-configured sharing export, so
 * raw evidence is authorized by the workflow itself — exactly like the regulated
 * evidence package. The package uses the non-regulated archive name: a regulated
 * session's immutable `regulated-{sessionId}.tar.gz` is produced separately by
 * the regulated completion chain, which runs only after completion evidence
 * exists, and must never be overwritten by a pre-completion export.
 */
export async function archiveCompletionExport(
  fingerprint: string,
  sessionId: string,
): Promise<string> {
  return archiveWithAuthorization(
    fingerprint,
    sessionId,
    { redactionMode: 'none', includeRaw: true },
    { authorizedRaw: true, regulatedEvidence: false, purpose: 'export' },
  );
}

interface ArchiveAuthorization {
  readonly authorizedRaw: boolean;
  readonly regulatedEvidence: boolean;
  readonly purpose: ArchivePurpose;
}

async function archiveWithAuthorization(
  fingerprint: string,
  sessionId: string,
  opts: ArchivePayloadOptions,
  authorization: ArchiveAuthorization,
  worktree?: string,
): Promise<string> {
  return withSpan(
    'archive.create',
    async () => {
      addFingerprint(fingerprint);
      addSessionId(sessionId);
      return archiveSessionImpl(fingerprint, sessionId, opts, authorization, worktree);
    },
    { 'flowguard.fingerprint': fingerprint, 'flowguard.session_id': sessionId },
  );
}

function validateArchiveOptions(
  opts: ArchivePayloadOptions,
  policy: EffectiveArchiveRedactionPolicy,
): void {
  const { redactionMode, includeRaw } = opts;

  if (!policy.allowedModes.includes(redactionMode)) {
    throw new WorkspaceError(
      'ARCHIVE_FAILED',
      `Redaction mode '${redactionMode}' is not allowed (effective config allows: ${policy.allowedModes.join(', ')}).`,
    );
  }

  if (redactionMode === 'none' && !includeRaw) {
    throw new WorkspaceError(
      'ARCHIVE_FAILED',
      'Invalid combination: redactionMode=none requires includeRaw=true. Choose basic or pseudonymous for redacted-only export.',
    );
  }

  if (includeRaw && !policy.allowRawExport) {
    throw new WorkspaceError(
      'ARCHIVE_FAILED',
      'Raw export is not enabled. An administrator must set archive.redaction.allowRawExport=true in the explicit global flowguard.json; the repository config can only restrict the effective policy.',
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

/**
 * Resolve the effective archive policy for the configurable export, binding the
 * repository-policy worktree to the session that is actually being archived.
 * Missing state/worktree and worktree-binding drift fail closed.
 */
async function resolveBoundArchivePolicy(
  opts: ArchivePayloadOptions,
  worktree: string | undefined,
  state: import('../../state/schema.js').SessionState | null,
  sessionId: string,
): Promise<EffectiveArchiveRedactionPolicy> {
  if (worktree === undefined || state === null) {
    throw new WorkspaceError(
      'ARCHIVE_FAILED',
      'The configurable archive export requires the canonical worktree and persisted session state to bind the repository policy.',
    );
  }
  try {
    validateBinding(state, { worktreeRoot: worktree, sessionId });
  } catch (err) {
    throw new WorkspaceError(
      'ARCHIVE_FAILED',
      `Archive worktree does not match the persisted session binding: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const effective = await readEffectiveArchivePolicy(worktree);
  if (effective.kind === 'blocked') {
    throw new WorkspaceError(
      'ARCHIVE_FAILED',
      `Archive redaction policy conflict: ${effective.reason}. Reconcile the global and repository allowedModes.`,
    );
  }
  validateArchiveOptions(opts, effective.policy);
  return effective.policy;
}

async function archiveSessionImpl(
  fingerprint: string,
  sessionId: string,
  opts: ArchivePayloadOptions,
  authorization: ArchiveAuthorization,
  worktree?: string,
): Promise<string> {
  const { authorizedRaw, regulatedEvidence } = authorization;
  validateFingerprint(fingerprint);
  const validSessionId = validateSessionId(sessionId);
  const sessDir = sessionDir(fingerprint, validSessionId);
  const archiveDir = path.join(workspacesHome(), fingerprint, 'sessions', 'archive');
  const archivePath = path.join(archiveDir, archiveFileName(validSessionId, authorization.purpose));
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
  // The configurable archive export applies the admin-ceiling projection over
  // the explicit global config and the repo config, bound to the session's
  // persisted worktree. A malformed config, an empty allowedModes intersection,
  // and worktree-binding drift are fail-closed. System-authorized raw exports
  // (regulated completion and the canonical `/export` rail) skip the projection
  // by design and stay workflow-authorized.
  const archivePolicy = authorizedRaw
    ? undefined
    : await resolveBoundArchivePolicy(opts, worktree, state, validSessionId);

  await appendArtifactBindingAuditEvent(sessDir, validSessionId, state);
  const events = await readAuditTrail(sessDir);
  if (regulatedEvidence) assertCompletionAuditEvent(events);

  if (opts.redactionMode !== 'none') {
    if (archivePolicy === undefined) {
      throw new WorkspaceError(
        'ARCHIVE_FAILED',
        'Archive audit-trail limits require loaded archive configuration.',
      );
    }
    if (events.length > archivePolicy.maxAuditEvents) {
      throw new WorkspaceError(
        'ARCHIVE_FAILED',
        `Audit trail length (${events.length}) exceeds maxAuditEvents (${archivePolicy.maxAuditEvents}). Increase archive.redaction.maxAuditEvents or reduce the audit trail.`,
      );
    }
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

function stripTrailingPublicationBindings(
  events: Awaited<ReturnType<typeof readAuditTrail>>,
): Awaited<ReturnType<typeof readAuditTrail>> {
  let end = events.length;
  while (end > 0) {
    const event = events[end - 1];
    if (event === undefined || event.event !== ARCHIVE_PUBLICATION_BINDING_EVENT) break;
    end -= 1;
  }
  return events.slice(0, end);
}

async function stagePublishAndBind(input: {
  readonly archiveDir: string;
  readonly archivePath: string;
  readonly fingerprint: string;
  readonly sessionId: string;
  readonly sessDir: string;
  readonly state: import('../../state/schema.js').SessionState | null;
  readonly events: Awaited<ReturnType<typeof readAuditTrail>>;
  readonly redactionMode: RedactionMode;
  readonly includeRaw: boolean;
}): Promise<void> {
  // Publication bindings are external authorities and must never alter the
  // self-contained v2 audit snapshot they attest. Only the trailing run can
  // belong to this publication attempt: a binding followed by later events has
  // become part of the historical chain, and dropping it would break chain
  // verification of the snapshot (the mandatory completion export publishes
  // before terminal events are appended).
  const archiveEvents = stripTrailingPublicationBindings(input.events);
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
  const existingPublication = lastPublicationBinding(
    input.events,
    path.basename(input.archivePath),
  );
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

async function appendArtifactBindingAuditEvent(
  sessDir: string,
  sessionId: string,
  state: import('../../state/schema.js').SessionState | null,
): Promise<void> {
  const artifacts = await collectArtifactBindings(sessDir);
  if (artifacts.length === 0) return;
  if (!state) return;
  const events = await readAuditTrail(sessDir);
  const previous = findBindingArtifacts(events);
  if (bindingMatches(previous, artifacts)) return;
  await appendAuditEvent(sessDir, {
    id: crypto.randomUUID(),
    flowguardSessionId: state.flowguardSessionId,
    hostSessionId: sessionId,
    phase: state.phase,
    event: ARTIFACT_BINDING_EVENT,
    occurredAt: new Date().toISOString(),
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
  if (!state) return;
  const events = await readAuditTrail(sessDir);
  if (findPublicationBinding(events, publication)) return;
  await appendAuditEvent(sessDir, {
    id: crypto.randomUUID(),
    flowguardSessionId: state.flowguardSessionId,
    hostSessionId: sessionId,
    phase: state.phase,
    event: ARCHIVE_PUBLICATION_BINDING_EVENT,
    occurredAt: new Date().toISOString(),
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
