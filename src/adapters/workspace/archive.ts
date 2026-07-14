/**
 * @module workspace/archive
 * @description Session archive build pipeline only.
 *
 * Creates compressed tar.gz archives of completed sessions with:
 * - Archive manifest (file inventory + SHA-256 digests)
 * - SHA-256 checksum sidecar file (fatal in regulated mode — P26)
 * - Discovery snapshot soft-check
 *
 * Does NOT perform archive verification — that is owned by
 * archive-verify-chain.ts and archive-verify-manifest.ts.
 *
 * Fail-closed invariants (P4a):
 * - State read failure (corrupt/unreadable) blocks archive creation.
 * - Audit trail read failure blocks archive creation.
 * - ENOENT (no file yet) is safe — readState returns null, readAuditTrail returns empty.
 *
 * @version v4
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { atomicWrite, readState } from '../persistence.js';
import { appendAuditEvent, readAuditTrail } from '../persistence-audit.js';
import { hashBuffer } from '../../shared/hashing.js';
import { readConfig } from '../persistence-config.js';
import { getAdapterLogger } from '../../logging/adapter-logger.js';
import { getLastChainHash } from '../../audit/integrity.js';
import {
  ARCHIVE_MANIFEST_SCHEMA_VERSION,
  MANIFEST_POLICY_MODE_UNKNOWN,
  type ArchiveManifest,
} from '../../archive/types.js';
import { computeArchiveContentDigest } from '../../archive/content-digest.js';
import { decisionReceipts } from '../../audit/query.js';
import {
  redactDecisionReceipts,
  redactReviewReport,
  redactSessionState,
  redactAuditDetail,
  stableMask,
  type RedactionMode,
} from '../../redaction/export-redaction.js';
import { summarizeArgs } from '../../audit/types.js';

import { WorkspaceError, validateFingerprint, validateSessionId } from './types.js';
import { workspacesHome, sessionDir } from './init.js';
import { withSpan, addFingerprint, addSessionId } from '../../telemetry/index.js';
import { verifyEvidenceArtifacts } from './evidence-artifacts.js';
import { fileExists, listSessionFiles } from './archive-files.js';
import { findBindingArtifacts } from './archive-verify-helpers.js';
import {
  type ArtifactBindingEntry,
  ARTIFACT_BINDING_EVENT,
  ARTIFACT_BINDING_SCHEMA_VERSION,
} from './archive-artifact-binding.js';

// -- Session Archive ----------------------------------------------------------

/**
 * Archive a completed session as a tar.gz file.
 *
 * Creates: ~/.config/opencode/workspaces/{fingerprint}/sessions/archive/{sessionId}.tar.gz
 *          ~/.config/opencode/workspaces/{fingerprint}/sessions/archive/{sessionId}.tar.gz.sha256
 *
 * Archive process:
 * 1. Soft-check: warn if discoveryDigest is set but snapshots are missing
 * 2. Build archive-manifest.json (file inventory + SHA-256 digests)
 * 3. Write manifest into session dir (becomes part of the archive)
 * 4. Create tar.gz from session dir
 * 5. Write .sha256 sidecar file for the archive
 *
 * Uses the system `tar` command (available on Windows 10+, macOS, Linux).
 *
 * @param fingerprint - Validated workspace fingerprint.
 * @param sessionId - Session ID to archive.
 * @returns Absolute path to the created archive file.
 * @throws WorkspaceError if the session directory doesn't exist or archiving fails.
 */
export async function archiveSession(fingerprint: string, sessionId: string): Promise<string> {
  return withSpan(
    'archive.create',
    async () => {
      addFingerprint(fingerprint);
      addSessionId(sessionId);
      return archiveSessionImpl(fingerprint, sessionId);
    },
    { 'flowguard.fingerprint': fingerprint, 'flowguard.session_id': sessionId },
  );
}

async function archiveSessionImpl(fingerprint: string, sessionId: string): Promise<string> {
  validateFingerprint(fingerprint);
  const validSessionId = validateSessionId(sessionId);

  const sessDir = sessionDir(fingerprint, validSessionId);
  const archiveDir = path.join(workspacesHome(), fingerprint, 'sessions', 'archive');
  const archivePath = path.join(archiveDir, `${validSessionId}.tar.gz`);
  const checksumPath = `${archivePath}.sha256`;

  // Verify session directory exists
  try {
    await fs.access(sessDir);
  } catch {
    throw new WorkspaceError('ARCHIVE_FAILED', `Session directory does not exist: ${sessDir}`);
  }

  // ── Fail-closed: state must be readable if it exists ────────────
  // readState returns null for ENOENT (no state file = fresh session),
  // but throws PersistenceError for corrupt/unreadable state.
  // An archive without verifiable state cannot prove what was governed.
  const state = await readState(sessDir);

  // Fail-closed: if ticket/plan evidence exists in state, derived artifacts must be present.
  if (state) {
    await verifyEvidenceArtifacts(sessDir, state);
  }

  if (state?.discoveryDigest) {
    const snapshotPath = path.join(sessDir, 'discovery-snapshot.json');
    try {
      await fs.access(snapshotPath);
    } catch {
      // Soft warning — log but don't fail. The archive will just lack the snapshot.
      getAdapterLogger().warn('archive', 'Discovery snapshot missing during archive creation', {
        sessionId: validSessionId,
        fingerprint,
      });
    }
  }

  // Archive redaction uses GLOBAL config only (no worktree param). Rationale:
  // Archives are stored in the centralized workspace store (~/.config/opencode/workspaces/).
  // The originating worktree may no longer exist at archive time. Redaction policy
  // is a platform-level concern, not a per-repo override.
  const config = await readConfig();
  const redactionMode = config.archive.redaction.mode;
  const includeRaw = config.archive.redaction.includeRaw;

  // ── Fail-closed: audit trail must be readable if it exists ─────
  // readAuditTrail returns { events: [], skipped: 0 } for ENOENT,
  // but throws PersistenceError for unreadable files.
  // An archive without its audit chain is governance-worthless.
  const { events } = await readAuditTrail(sessDir);

  // ── Build and write archive manifest ──────────────────────────
  const receipts = decisionReceipts(events).filter((r) => r.sessionId === validSessionId);
  const receiptsPayload = {
    schemaVersion: 'decision-receipts.v1',
    sessionId: validSessionId,
    generatedAt: new Date().toISOString(),
    count: receipts.length,
    receipts,
  };
  await atomicWrite(
    path.join(sessDir, 'decision-receipts.v1.json'),
    JSON.stringify(receiptsPayload, null, 2) + '\n',
  );

  const redaction = await applyArchiveRedaction(sessDir, redactionMode, includeRaw);
  await appendArtifactBindingAuditEvent(sessDir, validSessionId, state);

  const manifest = await buildArchiveManifest(sessDir, state, fingerprint, validSessionId, {
    redactionMode,
    rawIncluded: includeRaw || redactionMode === 'none',
    redactedArtifacts: redaction.redactedArtifacts,
    excludedFiles: redaction.excludedFiles,
    riskFlags: redaction.riskFlags,
  });
  const manifestJson = JSON.stringify(manifest, null, 2) + '\n';
  await atomicWrite(path.join(sessDir, 'archive-manifest.json'), manifestJson);

  await createArchiveBundle(fingerprint, validSessionId, archiveDir, archivePath, {
    excludedFiles: redaction.excludedFiles,
  });

  await writeArchiveChecksum(archivePath, checksumPath, state);

  getAdapterLogger().info('archive', 'archive_created', { sessionId: validSessionId });

  return archivePath;
}

interface ArchiveRedactionResult {
  redactedArtifacts: string[];
  excludedFiles: string[];
  riskFlags: string[];
}

async function applyArchiveRedaction(
  sessDir: string,
  redactionMode: string,
  includeRaw: boolean,
): Promise<ArchiveRedactionResult> {
  const redactedArtifacts: string[] = [];
  const excludedFiles: string[] = [];
  const riskFlags: string[] = [];

  if (redactionMode !== 'none') {
    await writeRedactedExportArtifact(
      sessDir,
      'decision-receipts.v1.json',
      'decision-receipts.redacted.v1.json',
      redactionMode as RedactionMode,
      redactDecisionReceipts,
    );
    redactedArtifacts.push('decision-receipts.redacted.v1.json');
    if (!includeRaw) excludedFiles.push('decision-receipts.v1.json');

    const reviewPath = path.join(sessDir, 'review-report.json');
    if (await fileExists(reviewPath)) {
      await writeRedactedExportArtifact(
        sessDir,
        'review-report.json',
        'review-report.redacted.json',
        redactionMode as RedactionMode,
        redactReviewReport,
      );
      redactedArtifacts.push('review-report.redacted.json');
      if (!includeRaw) excludedFiles.push('review-report.json');
    }

    const statePath = path.join(sessDir, 'session-state.json');
    if (await fileExists(statePath)) {
      await writeRedactedExportArtifact(
        sessDir,
        'session-state.json',
        'session-state.redacted.json',
        redactionMode as RedactionMode,
        redactSessionState,
      );
      redactedArtifacts.push('session-state.redacted.json');
      if (!includeRaw) excludedFiles.push('session-state.json');
    }

    const auditPath = path.join(sessDir, 'audit.jsonl');
    if (await fileExists(auditPath)) {
      await writeRedactedJsonlArtifact(sessDir, redactionMode as RedactionMode);
      redactedArtifacts.push('audit.redacted.jsonl');
      if (!includeRaw) excludedFiles.push('audit.jsonl');
    }
  }

  if (includeRaw) {
    riskFlags.push('raw_export_enabled');
  }

  return { redactedArtifacts, excludedFiles, riskFlags };
}

function isToolCallAuditEvent(event: Record<string, unknown>): boolean {
  const detail = event.detail;
  if (!detail || typeof detail !== 'object') return false;
  return (detail as Record<string, unknown>).kind === 'tool_call';
}

function redactIdentityValues(obj: Record<string, unknown>, mode: RedactionMode): void {
  for (const [key, val] of Object.entries(obj)) {
    if (typeof val === 'string') {
      obj[key] = stableMask(val, mode);
    }
  }
}

async function writeRedactedJsonlArtifact(sessDir: string, mode: RedactionMode): Promise<void> {
  const rawPath = path.join(sessDir, 'audit.jsonl');
  const redactedPath = path.join(sessDir, 'audit.redacted.jsonl');

  let rawContent: string;
  try {
    rawContent = await fs.readFile(rawPath, 'utf-8');
  } catch (err) {
    throw new WorkspaceError(
      'ARCHIVE_FAILED',
      `Audit trail read failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const lines = rawContent.split('\n').filter((line) => line.trim());
  const redactedLines: string[] = [];

  for (const line of lines) {
    redactedLines.push(redactAuditEvent(line, mode));
  }

  await atomicWrite(redactedPath, redactedLines.join('\n') + '\n');
}

function redactAuditEvent(line: string, mode: RedactionMode): string {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    throw new WorkspaceError('ARCHIVE_FAILED', 'Audit trail contains unparseable JSON');
  }

  if (typeof event.actor === 'string') {
    event.actor = stableMask(event.actor, mode);
  }
  if (event.actorInfo && typeof event.actorInfo === 'object') {
    redactIdentityValues(event.actorInfo as Record<string, unknown>, mode);
  }

  const detail = event.detail;
  if (detail && typeof detail === 'object') {
    const detailRecord = detail as Record<string, unknown>;

    if (
      isToolCallAuditEvent(event) &&
      detailRecord.argsSummary &&
      typeof detailRecord.argsSummary === 'object'
    ) {
      detailRecord.argsSummary = summarizeArgs(detailRecord.argsSummary as Record<string, unknown>);
    }

    event.detail = redactAuditDetail(detailRecord, mode);
  }

  return JSON.stringify(event);
}

async function appendArtifactBindingAuditEvent(
  sessDir: string,
  sessionId: string,
  state: import('../../state/schema.js').SessionState | null,
): Promise<void> {
  const artifacts = await collectArtifactBindings(sessDir);
  if (artifacts.length === 0) return;

  // Idempotency (#archive-race): if the audit trail already ends with an
  // artifact-binding event for the SAME artifact set (paths + content hashes),
  // do not append a duplicate. Two archive runs of the same completed session
  // (e.g. the fire-and-forget auto-archive on COMPLETE plus a manual /export)
  // would otherwise each append a binding event, leaving the live trail with one
  // more event than the manifest anchor recorded -> verify reports
  // audit_chain_truncated -> archiveStatus:"failed" on a perfectly valid archive.
  const { events } = await readAuditTrail(sessDir);
  if (artifactBindingMatches(findBindingArtifacts(events), artifacts)) return;

  const body = {
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
  };
  await appendAuditEvent(sessDir, body);
}

/**
 * True when a previously-recorded artifact-binding set (from the last binding
 * event in the trail) is identical to the freshly-collected set, compared by
 * sorted (path, sha256) pairs so ordering is irrelevant.
 */
function artifactBindingMatches(
  previous: unknown[] | undefined,
  current: readonly ArtifactBindingEntry[],
): boolean {
  if (!previous || previous.length !== current.length) return false;
  const key = (p: string, h: string): string => `${p}\u0000${h}`;
  const prevKeys = new Set<string>();
  for (const entry of previous) {
    if (!entry || typeof entry !== 'object') return false;
    const e = entry as Record<string, unknown>;
    if (typeof e.path !== 'string' || typeof e.sha256 !== 'string') return false;
    prevKeys.add(key(e.path, e.sha256));
  }
  return current.every((c) => prevKeys.has(key(c.path, c.sha256)));
}

async function collectArtifactBindings(sessDir: string): Promise<ArtifactBindingEntry[]> {
  const artifactsDir = path.join(sessDir, 'artifacts');
  if (!(await fileExists(artifactsDir))) return [];
  const files = await listFilesUnder(artifactsDir, 'artifacts');
  const entries: ArtifactBindingEntry[] = [];
  for (const relPath of files) {
    const content = await fs.readFile(path.join(sessDir, relPath));
    entries.push({
      path: relPath,
      sha256: hashBuffer(content),
      artifactType: inferArtifactType(relPath),
    });
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

async function listFilesUnder(absDir: string, relPrefix: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await fs.readdir(absDir, { withFileTypes: true });
  for (const entry of entries) {
    const relPath = `${relPrefix}/${entry.name}`;
    const absPath = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesUnder(absPath, relPath)));
    } else if (entry.isFile()) {
      files.push(relPath);
    }
  }
  return files.sort();
}

function inferArtifactType(relPath: string): string | null {
  const filename = path.posix.basename(relPath);
  const match = filename.match(/^([a-z-]+)\./);
  return match?.[1] ?? null;
}

async function createArchiveBundle(
  fingerprint: string,
  validSessionId: string,
  archiveDir: string,
  archivePath: string,
  opts: { excludedFiles: string[] },
): Promise<void> {
  const execFileAsync = promisify(execFile);

  try {
    await fs.mkdir(archiveDir, { recursive: true });
  } catch (err) {
    getAdapterLogger().error('archive', 'Failed to create archive directory', {
      archiveDir,
      sessionId: validSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new WorkspaceError(
      'ARCHIVE_FAILED',
      `Failed to create archive directory: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    const sessionsParent = path.join(workspacesHome(), fingerprint, 'sessions');
    const tarArgs = [
      'czf',
      archivePath,
      '-C',
      sessionsParent,
      ...opts.excludedFiles.map(
        (relPath) => `--exclude=${path.posix.join(validSessionId, relPath)}`,
      ),
      validSessionId,
    ];
    await execFileAsync('tar', tarArgs, {
      timeout: 30_000,
      windowsHide: true,
    });
  } catch (err) {
    getAdapterLogger().error('archive', 'tar command failed', {
      archivePath,
      sessionId: validSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new WorkspaceError(
      'ARCHIVE_FAILED',
      `tar command failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function writeArchiveChecksum(
  archivePath: string,
  checksumPath: string,
  state: import('../../state/schema.js').SessionState | null,
): Promise<void> {
  const validSessionId = path.basename(path.dirname(archivePath));
  try {
    const archiveBuffer = await fs.readFile(archivePath);
    const archiveHash = hashBuffer(archiveBuffer);
    await atomicWrite(checksumPath, `${archiveHash}  ${path.basename(archivePath)}\n`);
  } catch (err) {
    getAdapterLogger().error('archive', 'Checksum sidecar write failed', {
      checksumPath,
      sessionId: validSessionId,
      policyMode: state?.policySnapshot?.mode,
      error: err instanceof Error ? err.message : String(err),
    });
    if (state?.policySnapshot?.mode === 'regulated') {
      throw new WorkspaceError(
        'ARCHIVE_FAILED',
        `Checksum sidecar write failed in regulated mode: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * Build an archive manifest from the session directory contents.
 *
 * Inventories all files, computes SHA-256 digests, and builds
 * a deterministic content digest from sorted file digests.
 */
async function buildArchiveManifest(
  sessDir: string,
  state: import('../../state/schema.js').SessionState | null,
  fingerprint: string,
  sessionId: string,
  redaction: {
    redactionMode: RedactionMode;
    rawIncluded: boolean;
    redactedArtifacts: string[];
    excludedFiles: string[];
    riskFlags: string[];
  },
): Promise<ArchiveManifest> {
  const files = await listSessionFiles(sessDir, new Set(redaction.excludedFiles));
  const fileDigests: Record<string, string> = {};

  for (const relPath of files) {
    const content = await fs.readFile(path.join(sessDir, relPath));
    fileDigests[relPath] = hashBuffer(content);
  }

  // Audit completeness anchor — read AFTER the artifact-binding append so head and
  // count reflect the final, digested audit.jsonl. Truncation anchor (#420).
  const { events } = await readAuditTrail(sessDir);
  const auditChainHead = getLastChainHash(events);
  const auditEventCount = events.length;

  // includedFiles lists only session artifacts — NOT the manifest itself.
  // The manifest is metadata ABOUT the archive content. Self-referential
  // inclusion is impossible (the manifest cannot contain its own digest)
  // and would create fragile accidental-correctness in verification.
  // The manifest file IS physically present in the archive but is not
  // part of the content-digest computation.
  const includedFiles = [...files].sort();
  const policyMode = state?.policySnapshot?.mode ?? MANIFEST_POLICY_MODE_UNKNOWN;
  const discoveryDigest = state?.discoveryDigest ?? null;

  // Content digest binds file digests AND integrity metadata (single SSOT formula).
  const contentDigest = computeArchiveContentDigest({
    includedFiles,
    fileDigests,
    policyMode,
    auditChainHead,
    auditEventCount,
    schemaVersion: ARCHIVE_MANIFEST_SCHEMA_VERSION,
    sessionId,
    fingerprint,
    discoveryDigest,
  });

  return {
    schemaVersion: ARCHIVE_MANIFEST_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    sessionId,
    fingerprint,
    policyMode,
    profileId: state?.activeProfile?.id ?? 'baseline',
    discoveryDigest,
    auditChainHead,
    auditEventCount,
    includedFiles,
    fileDigests,
    contentDigest,
    redactionMode: redaction.redactionMode,
    rawIncluded: redaction.rawIncluded,
    redactedArtifacts: [...redaction.redactedArtifacts],
    excludedFiles: [...redaction.excludedFiles],
    riskFlags: [...redaction.riskFlags],
  };
}

async function writeRedactedExportArtifact(
  sessDir: string,
  rawFile: string,
  redactedFile: string,
  mode: RedactionMode,
  redact: (payload: Record<string, unknown>, mode: RedactionMode) => Record<string, unknown>,
): Promise<void> {
  const rawPath = path.join(sessDir, rawFile);

  let rawContent: string;
  try {
    rawContent = await fs.readFile(rawPath, 'utf-8');
  } catch (err) {
    throw new WorkspaceError(
      'ARCHIVE_FAILED',
      `Redaction source read failed (${rawFile}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawContent) as Record<string, unknown>;
  } catch {
    throw new WorkspaceError('ARCHIVE_FAILED', `Redaction source is invalid JSON: ${rawFile}`);
  }

  let redacted: Record<string, unknown>;
  try {
    redacted = redact(payload, mode);
  } catch (err) {
    throw new WorkspaceError(
      'ARCHIVE_FAILED',
      `Redaction failed for ${rawFile}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  await atomicWrite(path.join(sessDir, redactedFile), JSON.stringify(redacted, null, 2) + '\n');
}
