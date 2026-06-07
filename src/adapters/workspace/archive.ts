/**
 * @module workspace/archive
 * @description Session archiving and archive verification.
 *
 * Creates compressed tar.gz archives of completed sessions with:
 * - Archive manifest (file inventory + SHA-256 digests)
 * - SHA-256 checksum sidecar file (fatal in regulated mode — P26)
 * - Discovery snapshot soft-check
 *
 * Fail-closed invariants (P4a):
 * - State read failure (corrupt/unreadable) blocks archive creation.
 * - Audit trail read failure blocks archive creation.
 * - ENOENT (no file yet) is safe — readState returns null, readAuditTrail returns empty.
 *
 * @version v3
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { atomicWrite, readState } from '../persistence.js';
import { appendAuditEvent, readAuditTrail } from '../persistence-audit.js';
import { readConfig } from '../persistence-config.js';
import { getAdapterLogger } from '../../logging/adapter-logger.js';
import {
  verifyChain,
  getLastChainHash,
  type ChainVerification,
  type ChainVerificationReason,
} from '../../audit/integrity.js';
import {
  ArchiveManifestSchema,
  ARCHIVE_MANIFEST_SCHEMA_VERSION,
  MANIFEST_POLICY_MODE_UNKNOWN,
  type ArchiveManifest,
  type ArchiveVerification,
  type ArchiveFinding,
} from '../../archive/types.js';
import { computeArchiveContentDigest } from '../../archive/content-digest.js';
import { isPolicyMode } from '../../state/policy-mode.js';
import { decisionReceipts } from '../../audit/query.js';
import {
  redactDecisionReceipts,
  redactReviewReport,
  type RedactionMode,
} from '../../redaction/export-redaction.js';

import { WorkspaceError, validateFingerprint, validateSessionId } from './types.js';
import { workspacesHome, sessionDir } from './init.js';
import { withSpan, addFingerprint, addSessionId } from '../../telemetry/index.js';
import { verifyEvidenceArtifacts } from './evidence-artifacts.js';
// Timestamp token verification is lazy-imported to avoid requiring optional
// 'asn1js'/'pkijs' packages at module load time. Only needed during archive verification.

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

  return archivePath;
}

interface ArchiveRedactionResult {
  redactedArtifacts: string[];
  excludedFiles: string[];
  riskFlags: string[];
}

interface ArtifactBindingEntry {
  readonly path: string;
  readonly sha256: string;
  readonly artifactType: string | null;
}

const ARTIFACT_BINDING_EVENT = 'archive:artifacts_bound';
const ARTIFACT_BINDING_SCHEMA_VERSION = 'flowguard-archive-artifact-binding.v1';

/**
 * Fail-closed default: when the governed policy mode cannot be resolved from
 * integrity-covered state, verification runs strict. A resolvable non-regulated
 * mode is never escalated.
 */
const STRICT_WHEN_MODE_UNRESOLVED = true;

/** Hex prefix length for logging chain-head fingerprints (never the full hash material). */
const AUDIT_HEAD_LOG_PREFIX_LENGTH = 16;

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
  }

  if (includeRaw) {
    riskFlags.push('raw_export_enabled');
  }

  return { redactedArtifacts, excludedFiles, riskFlags };
}

async function appendArtifactBindingAuditEvent(
  sessDir: string,
  sessionId: string,
  state: import('../../state/schema.js').SessionState | null,
): Promise<void> {
  const artifacts = await collectArtifactBindings(sessDir);
  if (artifacts.length === 0) return;

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

async function collectArtifactBindings(sessDir: string): Promise<ArtifactBindingEntry[]> {
  const artifactsDir = path.join(sessDir, 'artifacts');
  if (!(await fileExists(artifactsDir))) return [];
  const files = await listFilesUnder(artifactsDir, 'artifacts');
  const entries: ArtifactBindingEntry[] = [];
  for (const relPath of files) {
    const content = await fs.readFile(path.join(sessDir, relPath));
    entries.push({
      path: relPath,
      sha256: crypto.createHash('sha256').update(content).digest('hex'),
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
    const archiveHash = crypto.createHash('sha256').update(archiveBuffer).digest('hex');
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
 * Verify an archived session's integrity.
 *
 * Checks:
 * 1. Archive manifest exists and is valid
 * 2. All files listed in manifest exist in session dir
 * 3. No unexpected files in session dir (not in manifest)
 * 4. File digests match
 * 5. Content digest matches
 * 6. Archive .sha256 sidecar matches (if available)
 * 7. Discovery snapshots present (if state has discoveryDigest)
 * 8. Session state file present
 * 9. Audit chain integrity (strict in regulated mode, legacy-tolerant otherwise)
 *
 * @param fingerprint - Workspace fingerprint.
 * @param sessionId - Session ID to verify.
 * @returns Structured verification result with findings.
 */
export async function verifyArchive(
  fingerprint: string,
  sessionId: string,
): Promise<ArchiveVerification> {
  return withSpan(
    'archive.verify',
    async () => {
      addFingerprint(fingerprint);
      addSessionId(sessionId);
      return verifyArchiveImpl(fingerprint, sessionId);
    },
    { 'flowguard.fingerprint': fingerprint, 'flowguard.session_id': sessionId },
  );
}

async function loadArchiveManifest(
  sessDir: string,
  findings: ArchiveFinding[],
): Promise<ArchiveManifest | null> {
  const manifestPath = path.join(sessDir, 'archive-manifest.json');
  let manifestRaw: string;
  try {
    manifestRaw = await fs.readFile(manifestPath, 'utf-8');
  } catch {
    findings.push({
      code: 'missing_manifest',
      severity: 'error',
      message: 'Archive manifest not found in session directory',
      file: 'archive-manifest.json',
    });
    return null;
  }

  try {
    const parsed = JSON.parse(manifestRaw);
    const result = ArchiveManifestSchema.safeParse(parsed);
    if (!result.success) {
      findings.push({
        code: 'manifest_parse_error',
        severity: 'error',
        message: `Manifest schema validation failed: ${result.error.message}`,
        file: 'archive-manifest.json',
      });
      return null;
    }
    return result.data;
  } catch {
    findings.push({
      code: 'manifest_parse_error',
      severity: 'error',
      message: 'Manifest is not valid JSON',
      file: 'archive-manifest.json',
    });
    return null;
  }
}

async function verifyManifestFiles(
  sessDir: string,
  manifest: ArchiveManifest,
  findings: ArchiveFinding[],
): Promise<void> {
  for (const relPath of manifest.includedFiles) {
    const fullPath = path.join(sessDir, relPath);
    const exists = await fileExists(fullPath);
    if (!exists) {
      findings.push({
        code: 'missing_file',
        severity: 'error',
        message: `File listed in manifest is missing: ${relPath}`,
        file: relPath,
      });
      continue;
    }

    const expectedDigest = manifest.fileDigests[relPath];
    if (expectedDigest) {
      const content = await fs.readFile(fullPath);
      const actualDigest = crypto.createHash('sha256').update(content).digest('hex');
      if (actualDigest !== expectedDigest) {
        findings.push({
          code: 'file_digest_mismatch',
          severity: 'error',
          message: `File digest mismatch for ${relPath}: expected ${expectedDigest.slice(0, 12)}..., got ${actualDigest.slice(0, 12)}...`,
          file: relPath,
        });
      }
    }
  }
}

async function checkUnexpectedFiles(
  sessDir: string,
  manifest: ArchiveManifest,
  findings: ArchiveFinding[],
): Promise<void> {
  const manifestFileSet = new Set(manifest.includedFiles);
  const excludedSet = new Set(manifest.excludedFiles ?? []);
  try {
    const actualFiles = await listSessionFiles(sessDir);
    for (const file of actualFiles) {
      if (excludedSet.has(file)) continue;
      if (!manifestFileSet.has(file)) {
        findings.push({
          code: 'unexpected_file',
          severity: 'warning',
          message: `File not listed in manifest: ${file}`,
          file,
        });
      }
    }
  } catch {
    // Can't list files — skip unexpected file check
  }
}

async function verifyArtifactBinding(
  sessDir: string,
  manifest: ArchiveManifest,
  events: readonly Record<string, unknown>[],
  findings: ArchiveFinding[],
): Promise<void> {
  const manifestArtifacts = manifest.includedFiles.filter((file) => file.startsWith('artifacts/'));
  const binding = [...events].reverse().find((event) => event.event === ARTIFACT_BINDING_EVENT);
  const detail = binding?.detail as Record<string, unknown> | undefined;
  const artifacts = detail?.artifacts;
  if (manifestArtifacts.length === 0 && !Array.isArray(artifacts)) return;
  if (detail?.schemaVersion !== ARTIFACT_BINDING_SCHEMA_VERSION || !Array.isArray(artifacts)) {
    findings.push({
      code: 'artifact_binding_missing',
      severity: 'error',
      message:
        'Archive contains evidence artifacts but no valid audit-chain artifact binding event',
      file: 'audit.jsonl',
    });
    return;
  }

  const bound = new Map<string, ArtifactBindingEntry>();
  for (const entry of artifacts) {
    if (!isArtifactBindingEntry(entry)) continue;
    bound.set(entry.path, entry);
  }

  const manifestArtifactSet = new Set(manifestArtifacts);
  for (const entry of bound.values()) {
    if (!manifestArtifactSet.has(entry.path) || manifest.fileDigests[entry.path] === undefined) {
      findings.push({
        code: 'artifact_binding_mismatch',
        severity: 'error',
        message: `Audit-bound evidence artifact is missing from archive manifest: ${entry.path}`,
        file: entry.path,
      });
    }
  }

  for (const relPath of manifestArtifacts) {
    const entry = bound.get(relPath);
    if (!entry) {
      findings.push({
        code: 'artifact_binding_missing',
        severity: 'error',
        message: `Evidence artifact is not bound into audit chain: ${relPath}`,
        file: relPath,
      });
      continue;
    }

    const content = await fs.readFile(path.join(sessDir, relPath));
    const actual = crypto.createHash('sha256').update(content).digest('hex');
    if (actual !== entry.sha256) {
      findings.push({
        code: 'artifact_binding_mismatch',
        severity: 'error',
        message: `Evidence artifact hash does not match audit binding: ${relPath}`,
        file: relPath,
      });
    }
    if (manifest.fileDigests[relPath] !== entry.sha256) {
      findings.push({
        code: 'artifact_binding_mismatch',
        severity: 'error',
        message: `Archive manifest digest is not consistent with audit binding: ${relPath}`,
        file: relPath,
      });
    }
  }
}

function isArtifactBindingEntry(value: unknown): value is ArtifactBindingEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.path === 'string' &&
    entry.path.startsWith('artifacts/') &&
    typeof entry.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(entry.sha256) &&
    (entry.artifactType === null || typeof entry.artifactType === 'string')
  );
}

function hasTimestampEvidence(event: Record<string, unknown>): boolean {
  const evidence = event.timestampEvidence;
  return typeof evidence === 'object' && evidence !== null;
}

function isCurrentChainIntegrityFailure(reason: ChainVerificationReason | null): boolean {
  return reason === 'CHAIN_BREAK' || reason === 'LEGACY_EVENTS_NOT_ALLOWED_IN_STRICT_MODE';
}

function isAuditFormatFailure(reason: ChainVerificationReason | null): boolean {
  return (
    reason === 'LEGACY_AUDIT_CHAIN_NOT_VERIFIABLE_WITH_V2' ||
    reason === 'UNSUPPORTED_AUDIT_FORMAT_VERSION'
  );
}

function logAuditChainVerificationFailure(chainResult: ChainVerification): void {
  if (chainResult.valid) return;

  if (chainResult.reason === 'TSA_MESSAGE_IMPRINT_MISMATCH') {
    const mismatchIndex = chainResult.tsaImprintMismatches[0];
    getAdapterLogger().error('archive', 'TSA timestamp verification failed', {
      eventId:
        typeof mismatchIndex === 'number' ? chainResult.results[mismatchIndex]?.eventId : null,
      reason: 'tsa_imprint_mismatch',
    });
    return;
  }

  if (chainResult.reason === 'TOKEN_VERIFICATION_REQUIRED') {
    const tokenIndex = chainResult.tokenVerificationRequired[0];
    getAdapterLogger().error('archive', 'TSA token verification required', {
      eventId: typeof tokenIndex === 'number' ? chainResult.results[tokenIndex]?.eventId : null,
      reason: 'token_verification_required',
    });
    return;
  }

  if (!chainResult.firstBreak) return;

  const logExtra: Record<string, unknown> = {
    eventId: chainResult.firstBreak.eventId,
    reason: chainResult.reason,
  };
  if (chainResult.firstBreak.expectedChainHash) {
    logExtra.expectedChainHash = chainResult.firstBreak.expectedChainHash;
  }
  if (chainResult.firstBreak.actualChainHash) {
    logExtra.actualChainHash = chainResult.firstBreak.actualChainHash;
  }

  const log = getAdapterLogger();
  if (chainResult.reason === 'CHAIN_BREAK') {
    log.error('archive', 'Audit chain verification failed', logExtra);
    return;
  }
  log.warn('archive', 'Audit chain format is not verifiable with current v2 verifier', logExtra);
}

function addAuditFormatFindings(chainResult: ChainVerification, findings: ArchiveFinding[]): void {
  if (chainResult.reason === 'LEGACY_AUDIT_CHAIN_NOT_VERIFIABLE_WITH_V2') {
    findings.push({
      code: 'audit_chain_legacy_format',
      severity: 'error',
      message:
        'Audit chain uses a legacy/pre-v2 hash format and is not verifiable under the recursive v2 tamper-evidence guarantee; migrate or re-seal before treating it as current-format evidence',
      file: 'audit.jsonl',
    });
  }
  if (chainResult.reason === 'UNSUPPORTED_AUDIT_FORMAT_VERSION') {
    findings.push({
      code: 'audit_chain_unsupported_format',
      severity: 'error',
      message:
        'Audit chain declares an unsupported auditFormatVersion and cannot be verified by this runtime',
      file: 'audit.jsonl',
    });
  }
}

/**
 * Resolve whether verification runs in strict mode.
 *
 * SSOT: strict is derived from the integrity-covered `state.policySnapshot.mode`,
 * NOT from the mutable, unsigned `manifest.policyMode`. Fail-closed: when the mode
 * cannot be safely resolved to a known PolicyMode (missing/invalid state), strict
 * is assumed. A resolvable non-regulated mode is NOT escalated.
 */
function resolveStrictMode(state: import('../../state/schema.js').SessionState | null): boolean {
  const mode = state?.policySnapshot?.mode;
  if (!isPolicyMode(mode)) {
    return STRICT_WHEN_MODE_UNRESOLVED;
  }
  return mode === 'regulated';
}

/**
 * Cross-check the unsigned manifest.policyMode against the integrity-covered
 * state mode. A mismatch is a tamper signal (e.g. flipping regulated→team to
 * weaken verification) and fails closed. Skipped when state is unresolvable —
 * that is already surfaced by state_missing/state_invalid.
 */
function verifyManifestPolicyMode(
  manifest: ArchiveManifest,
  state: import('../../state/schema.js').SessionState | null,
  findings: ArchiveFinding[],
): void {
  const stateMode = state?.policySnapshot?.mode;
  if (!isPolicyMode(stateMode)) return;
  if (manifest.policyMode === stateMode) return;

  getAdapterLogger().error('archive', 'Manifest policy mode does not match governed state', {
    reason: 'manifest_policy_mode_mismatch',
    manifestMode: manifest.policyMode,
    stateMode,
  });
  findings.push({
    code: 'manifest_policy_mode_mismatch',
    severity: 'error',
    message: `Manifest policyMode '${manifest.policyMode}' does not match governed state mode '${stateMode}'`,
    file: 'archive-manifest.json',
  });
}

/**
 * Verify the audit tail anchor (head + count) against the manifest.
 *
 * A truncated trail is still a valid hash-chain prefix, so chain verification
 * alone cannot detect a missing tail. The manifest anchor makes truncation
 * explicit (defense-in-depth above file_digest_mismatch).
 */
function verifyAuditCompleteness(
  manifest: ArchiveManifest,
  events: readonly Record<string, unknown>[],
  findings: ArchiveFinding[],
): void {
  const actualCount = events.length;
  const actualHead = getLastChainHash([...events]);
  if (actualCount === manifest.auditEventCount && actualHead === manifest.auditChainHead) {
    return;
  }

  getAdapterLogger().error('archive', 'Audit trail completeness anchor mismatch', {
    reason: 'audit_chain_truncated',
    expectedCount: manifest.auditEventCount,
    actualCount,
    expectedHead: manifest.auditChainHead.slice(0, AUDIT_HEAD_LOG_PREFIX_LENGTH),
    actualHead: actualHead.slice(0, AUDIT_HEAD_LOG_PREFIX_LENGTH),
  });
  findings.push({
    code: 'audit_chain_truncated',
    severity: 'error',
    message:
      `Audit trail does not match manifest anchor: expected ${manifest.auditEventCount} event(s), ` +
      `found ${actualCount}`,
    file: 'audit.jsonl',
  });
}

async function verifyTimestampChain(
  events: Parameters<typeof verifyChain>[0],
  state: import('../../state/schema.js').SessionState | null,
  manifest: ArchiveManifest,
  findings: ArchiveFinding[],
  strict: boolean,
): Promise<void> {
  const timestampPolicy = state?.policySnapshot.audit.timestampAssurance;
  const hasTsaEvidence = events.some(hasTimestampEvidence);
  const strictTimestamps = hasTsaEvidence || timestampPolicy?.enabled === true;
  const timestampFailuresAreFatal = strict || timestampPolicy?.strict === true;
  const chainResult = verifyChain(events, { strict, strictTimestamps });
  logAuditChainVerificationFailure(chainResult);
  addAuditFormatFindings(chainResult, findings);

  if (!chainResult.valid && isCurrentChainIntegrityFailure(chainResult.reason)) {
    findings.push({
      code: 'audit_chain_invalid',
      severity: 'error',
      message: `Audit chain verification failed (${chainResult.reason}): ${chainResult.totalEvents} total, ${chainResult.verifiedCount} verified, ${chainResult.skippedCount} skipped`,
      file: 'audit.jsonl',
    });
  }

  if (
    !chainResult.valid &&
    !isCurrentChainIntegrityFailure(chainResult.reason) &&
    !isAuditFormatFailure(chainResult.reason)
  ) {
    const code =
      chainResult.reason === 'TSA_MESSAGE_IMPRINT_MISMATCH' ||
      chainResult.reason === 'TOKEN_VERIFICATION_REQUIRED'
        ? 'tsa_verification_failed'
        : 'timestamp_unanchored';
    findings.push({
      code,
      severity: timestampFailuresAreFatal ? 'error' : 'warning',
      message: `Timestamp verification failed (${chainResult.reason}): ${chainResult.totalEvents} total, ${chainResult.verifiedCount} verified`,
      file: 'audit.jsonl',
    });
  }

  if (chainResult.missingTimestampEvidence.length > 0) {
    findings.push({
      code: 'timestamp_unanchored',
      severity: timestampFailuresAreFatal ? 'error' : 'warning',
      message: `${chainResult.missingTimestampEvidence.length} critical event(s) lack timestamp assurance evidence (indices: ${chainResult.missingTimestampEvidence.join(', ')})`,
      file: 'audit.jsonl',
    });
  }

  if (chainResult.tsaImprintMismatches.length > 0) {
    findings.push({
      code: 'tsa_verification_failed',
      severity: timestampFailuresAreFatal ? 'error' : 'warning',
      message: `${chainResult.tsaImprintMismatches.length} event(s) have TSA messageImprint mismatch (indices: ${chainResult.tsaImprintMismatches.join(', ')})`,
      file: 'audit.jsonl',
    });
  }

  if (chainResult.timestampMonotonicity && !chainResult.timestampMonotonicity.valid) {
    findings.push({
      code: 'timestamp_unanchored',
      severity: timestampFailuresAreFatal ? 'error' : 'warning',
      message: `Timestamp monotonicity violation: ${chainResult.timestampMonotonicity.message}`,
      file: 'audit.jsonl',
    });
  }

  const { verifyArchiveTimestampTokens } = await import('./archive-timestamp-verification.js');
  await verifyArchiveTimestampTokens({ events, state, manifest, findings });
}

async function verifyAuditChainIntegrity(
  sessDir: string,
  manifest: ArchiveManifest,
  findings: ArchiveFinding[],
  state: import('../../state/schema.js').SessionState | null,
  strict: boolean,
): Promise<void> {
  try {
    const { events, skipped } = await readAuditTrail(sessDir);
    verifyAuditCompleteness(manifest, events, findings);

    if (strict && skipped > 0) {
      findings.push({
        code: 'audit_chain_invalid',
        severity: 'error',
        message: `Audit trail contains ${skipped} unparseable line(s) in regulated mode`,
        file: 'audit.jsonl',
      });
    }

    await verifyArtifactBinding(sessDir, manifest, events, findings);

    if (events.length > 0) {
      await verifyTimestampChain(events, state, manifest, findings, strict);
    }
  } catch (error) {
    if (strict) {
      findings.push({
        code: 'audit_chain_invalid',
        severity: 'error',
        message: `Audit chain verification could not read audit.jsonl: ${
          error instanceof Error ? error.message : String(error)
        }`,
        file: 'audit.jsonl',
      });
    }
  }
}

async function verifyArchiveIntegrity(
  location: { sessDir: string; fingerprint: string; validSessionId: string },
  manifest: ArchiveManifest,
  findings: ArchiveFinding[],
  state: import('../../state/schema.js').SessionState | null,
): Promise<void> {
  const { sessDir, fingerprint, validSessionId } = location;
  // Strict authority and completeness checks run BEFORE the content digest so a
  // mode/anchor tamper surfaces explicitly rather than only as a digest mismatch.
  const strict = resolveStrictMode(state);
  verifyManifestPolicyMode(manifest, state, findings);
  await verifyAuditChainIntegrity(sessDir, manifest, findings, state, strict);

  // Content digest is ALWAYS verified — including an empty archive (no included
  // files). The integrity header (policy mode, audit anchor, identity) is part of
  // the digest, so a tampered header on a 0-file manifest must still fail closed.
  const computedContentDigest = computeArchiveContentDigest({
    includedFiles: manifest.includedFiles,
    fileDigests: manifest.fileDigests,
    policyMode: manifest.policyMode,
    auditChainHead: manifest.auditChainHead,
    auditEventCount: manifest.auditEventCount,
    schemaVersion: manifest.schemaVersion,
    sessionId: manifest.sessionId,
    fingerprint: manifest.fingerprint,
    discoveryDigest: manifest.discoveryDigest,
  });
  if (computedContentDigest !== manifest.contentDigest) {
    findings.push({
      code: 'content_digest_mismatch',
      severity: 'error',
      message:
        'Content digest does not match computed value from file digests and integrity header',
    });
  }

  const archiveCheckDir = path.join(workspacesHome(), fingerprint, 'sessions', 'archive');
  const archiveTarPath = path.join(archiveCheckDir, `${validSessionId}.tar.gz`);
  const checksumSidecarPath = `${archiveTarPath}.sha256`;

  const checksumExists = await fileExists(checksumSidecarPath);
  if (!checksumExists) {
    findings.push({
      code: 'archive_checksum_missing',
      severity: strict ? 'error' : 'warning',
      message: 'Archive checksum sidecar (.sha256) not found',
    });
  } else {
    try {
      const sidecarContent = await fs.readFile(checksumSidecarPath, 'utf-8');
      const expectedHash = sidecarContent.trim().split(/\s+/)[0];
      const archiveBuffer = await fs.readFile(archiveTarPath);
      const actualHash = crypto.createHash('sha256').update(archiveBuffer).digest('hex');
      if (expectedHash !== actualHash) {
        findings.push({
          code: 'archive_checksum_mismatch',
          severity: 'error',
          message: `Archive checksum mismatch: sidecar says ${expectedHash?.slice(0, 12)}..., actual is ${actualHash.slice(0, 12)}...`,
        });
      }
    } catch {
      // Can't read archive or sidecar — skip
    }
  }
}

async function verifyArchiveImpl(
  fingerprint: string,
  sessionId: string,
): Promise<ArchiveVerification> {
  validateFingerprint(fingerprint);
  const validSessionId = validateSessionId(sessionId);

  const sessDir = sessionDir(fingerprint, validSessionId);
  const findings: ArchiveFinding[] = [];

  const manifest = await loadArchiveManifest(sessDir, findings);
  if (!manifest) {
    return buildVerificationResult(findings, null);
  }

  const stateExists = await fileExists(path.join(sessDir, 'session-state.json'));
  let state: import('../../state/schema.js').SessionState | null = null;
  if (stateExists) {
    try {
      state = await readState(sessDir);
    } catch (error) {
      findings.push({
        code: 'state_invalid',
        severity: 'error',
        message: `Session state file could not be parsed or validated: ${
          error instanceof Error ? error.message : String(error)
        }`,
        file: 'session-state.json',
      });
    }
  }
  if (!stateExists) {
    findings.push({
      code: 'state_missing',
      severity: 'error',
      message: 'Session state file not found',
      file: 'session-state.json',
    });
  }

  if (manifest.discoveryDigest) {
    for (const snapshotFile of ['discovery-snapshot.json', 'profile-resolution-snapshot.json']) {
      const exists = await fileExists(path.join(sessDir, snapshotFile));
      if (!exists) {
        findings.push({
          code: 'snapshot_missing',
          severity: 'warning',
          message: `Discovery snapshot not found: ${snapshotFile}`,
          file: snapshotFile,
        });
      }
    }
  }

  await verifyManifestFiles(sessDir, manifest, findings);
  await checkUnexpectedFiles(sessDir, manifest, findings);
  await verifyArchiveIntegrity({ sessDir, fingerprint, validSessionId }, manifest, findings, state);

  return buildVerificationResult(findings, manifest);
}

// -- Internals ----------------------------------------------------------------

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
    fileDigests[relPath] = crypto.createHash('sha256').update(content).digest('hex');
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

/**
 * List all files in a session directory (relative paths, sorted).
 * Excludes the archive-manifest.json itself (it's added separately).
 */
async function listSessionFiles(sessDir: string, excluded = new Set<string>()): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), relPath);
      } else if (entry.isFile() && entry.name !== 'archive-manifest.json') {
        if (!excluded.has(relPath)) {
          files.push(relPath);
        }
      }
    }
  }

  await walk(sessDir, '');
  return files.sort();
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

/** Check if a file exists (non-throwing). */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Build the final verification result from findings. */
function buildVerificationResult(
  findings: ArchiveFinding[],
  manifest: ArchiveManifest | null,
): ArchiveVerification {
  const hasError = findings.some((f) => f.severity === 'error');
  return {
    passed: !hasError,
    findings,
    manifest,
    verifiedAt: new Date().toISOString(),
  };
}
