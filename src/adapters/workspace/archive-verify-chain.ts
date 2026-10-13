/** Audit-chain, timestamp, content-digest, and archive-checksum verification. */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readState } from '../persistence.js';
import { readAuditTrail } from '../persistence-audit.js';
import { getAdapterLogger } from '../../logging/adapter-logger.js';
import {
  type ArchiveManifest,
  type ArchiveVerification,
  type ArchiveFinding,
} from '../../archive/types.js';
import { validateFingerprint, validateSessionId } from './types.js';
import { workspacesHome } from './init.js';
import { withSpan, addFingerprint, addSessionId } from '../../telemetry/index.js';
import {
  loadArchiveManifest,
  verifyManifestFiles,
  checkUnexpectedFiles,
} from './archive-verify-manifest.js';
import { fileExists, snapshotArchive } from './archive-files.js';
import { archiveFileName, type ArchivePurpose } from './archive-layout.js';
import { inspectArchiveTar } from './archive-tar.js';
import { readArchiveSidecarDigest } from './archive-verify-checksum.js';
import { verifyArchiveIntegrity } from './archive-verify-integrity.js';
import { hashFile } from '../../shared/hashing.js';
import type { SessionState } from '../../state/schema.js';
import type { AuditEvent } from '../../state/evidence.js';

// Timestamp token verification is lazy-imported to avoid requiring optional
// 'asn1js'/'pkijs' packages at module load time. Only needed during archive verification.

// ─── Public API ───────────────────────────────────────────────────────────────

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
 * 9. Audit chain integrity (strict in regulated mode, envelope-fail-closed otherwise)
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
      return (await runArchiveVerification(fingerprint, sessionId, 'archive')).verification;
    },
    { 'flowguard.fingerprint': fingerprint, 'flowguard.session_id': sessionId },
  );
}

/** Verify the immutable raw-evidence archive created during regulated completion. */
export async function verifyRegulatedArchive(
  fingerprint: string,
  sessionId: string,
): Promise<ArchiveVerification> {
  return withSpan(
    'archive.verify',
    async () => {
      addFingerprint(fingerprint);
      addSessionId(sessionId);
      return (await runArchiveVerification(fingerprint, sessionId, 'regulated')).verification;
    },
    { 'flowguard.fingerprint': fingerprint, 'flowguard.session_id': sessionId },
  );
}

/** Verify the completion export created by the canonical `/export` rail. */
export async function verifyCompletionExport(
  fingerprint: string,
  sessionId: string,
): Promise<ArchiveVerification> {
  return withSpan(
    'archive.verify',
    async () => {
      addFingerprint(fingerprint);
      addSessionId(sessionId);
      return (await runArchiveVerification(fingerprint, sessionId, 'export')).verification;
    },
    { 'flowguard.fingerprint': fingerprint, 'flowguard.session_id': sessionId },
  );
}

/**
 * Contents read from the exact extracted snapshot that was verified.
 *
 * Every field is captured BEFORE the temporary extraction directory is
 * removed, so a later read of the mutable original package cannot diverge from
 * what was verified. `packageSha256` is the SHA-256 of the snapshot tarball
 * (the same bytes the checksum sidecar is compared against); `null` means the
 * snapshot could not be read at all.
 */
export interface VerifiedArchiveCapture {
  readonly state: SessionState | null;
  readonly events: AuditEvent[] | null;
  readonly packageSha256: string | null;
  readonly sidecarSha256: string | null;
  readonly sidecarPresent: boolean;
}

/** A verification run plus the snapshot contents captured during it. */
export interface CapturedArchiveVerification {
  readonly verification: ArchiveVerification;
  readonly capture: VerifiedArchiveCapture;
}

/**
 * Verify the canonical completion export and capture the verified snapshot
 * contents in the same transaction.
 *
 * This function exists for read-only projections that must bind derived
 * findings to verified bytes (e.g. evidence-to-control mapping). It is NOT a
 * second verifier: it runs the identical pipeline as
 * {@link verifyCompletionExport}, and the capture is read from the same
 * private extraction copy before that copy is discarded.
 */
export async function verifyCompletionExportCaptured(
  fingerprint: string,
  sessionId: string,
): Promise<CapturedArchiveVerification> {
  return withSpan(
    'archive.verify',
    async () => {
      addFingerprint(fingerprint);
      addSessionId(sessionId);
      return runArchiveVerification(fingerprint, sessionId, 'export', true);
    },
    { 'flowguard.fingerprint': fingerprint, 'flowguard.session_id': sessionId },
  );
}

// ─── Verification Stages ──────────────────────────────────────────────────────

// The audit-chain, artifact-binding, checksum, and content-digest stages live
// in sibling modules; only the extraction/assembly flow remains here.

/**
 * Project a chain verification result into archive findings.
 *
 * Re-exported from the audit-chain stage so the canonical import surface
 * (`./archive-verify-chain.js`) keeps this tested projection.
 */
export { addTimestampFindings } from './archive-verify-audit-chain.js';

// ─── Extraction & Assembly ────────────────────────────────────────────────────

// Extraction, manifest validation, and cleanup must stay in one transaction.
async function prepareArchiveForVerification(
  archiveTarPath: string,
  archiveSnapshotPath: string,
  validSessionId: string,
  extractionRoot: string,
  findings: ArchiveFinding[],
): Promise<boolean> {
  try {
    await snapshotArchive(archiveTarPath, archiveSnapshotPath);
  } catch (error) {
    findings.push({
      code: 'missing_manifest',
      severity: 'error',
      message: `Archive snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    return false;
  }
  const inspection = await inspectArchiveTar(archiveSnapshotPath, validSessionId);
  if (inspection.kind === 'blocked') {
    findings.push({
      code: 'unexpected_file',
      severity: 'error',
      message: `Archive member policy violation: ${inspection.reason}`,
    });
    return false;
  }
  try {
    await promisify(execFile)('tar', ['xzf', archiveSnapshotPath, '-C', extractionRoot], {
      timeout: 30_000,
      windowsHide: true,
    });
    return true;
  } catch (error) {
    findings.push({
      code: 'missing_manifest',
      severity: 'error',
      message: `Archive extraction failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    return false;
  }
}

async function loadArchiveState(
  sessDir: string,
  findings: ArchiveFinding[],
): Promise<import('../../state/schema.js').SessionState | null> {
  const stateDir = path.join(sessDir, 'state');
  const stateExists = await fileExists(path.join(stateDir, 'session-state.json'));
  if (!stateExists) {
    findings.push({
      code: 'state_missing',
      severity: 'error',
      message: 'Session state file not found',
      file: 'state/session-state.json',
    });
    return null;
  }
  try {
    return await readState(stateDir);
  } catch (error) {
    findings.push({
      code: 'state_invalid',
      severity: 'error',
      message: `Session state file could not be parsed or validated: ${
        error instanceof Error ? error.message : String(error)
      }`,
      file: 'state/session-state.json',
    });
    return null;
  }
}

async function checkDiscoverySnapshots(
  sessDir: string,
  manifest: ArchiveManifest,
  findings: ArchiveFinding[],
): Promise<void> {
  if (!manifest.discoveryDigest) return;
  for (const snapshotFile of ['discovery-snapshot.json', 'profile-resolution-snapshot.json']) {
    const archivePath = `context/${snapshotFile}`;
    const exists = await fileExists(path.join(sessDir, archivePath));
    if (!exists) {
      findings.push({
        code: 'snapshot_missing',
        severity: 'warning',
        message: `Discovery snapshot not found: ${snapshotFile}`,
        file: archivePath,
      });
    }
  }
}

/** A capture with no snapshot material — used on every early failure path. */
function emptyCapture(packageSha256: string | null = null): VerifiedArchiveCapture {
  return {
    state: null,
    events: null,
    packageSha256,
    sidecarSha256: null,
    sidecarPresent: false,
  };
}

/**
 * Read the snapshot contents for a capture request.
 *
 * Runs AFTER all verification stages, from the private extraction copy, and
 * never throws: an unreadable state, audit trail, or sidecar yields `null`
 * fields that the caller must treat as a blocked capture. A missing or
 * malformed sidecar is surfaced explicitly — the capture consumer owns the
 * fail-closed severity for its trust boundary.
 */
async function captureVerifiedContents(input: {
  readonly sessDir: string;
  readonly archiveSnapshotPath: string;
  readonly checksumSidecarPath: string;
}): Promise<VerifiedArchiveCapture> {
  let packageSha256: string | null = null;
  try {
    packageSha256 = await hashFile(input.archiveSnapshotPath);
  } catch {
    packageSha256 = null;
  }

  const sidecar = await readArchiveSidecarDigest(input.checksumSidecarPath);
  const sidecarPresent = sidecar.kind !== 'missing';

  let state: SessionState | null = null;
  try {
    state = await readState(path.join(input.sessDir, 'state'));
  } catch {
    state = null;
  }

  let events: AuditEvent[] | null = null;
  try {
    events = await readAuditTrail(path.join(input.sessDir, 'audit'));
  } catch {
    events = null;
  }

  return {
    state,
    events,
    packageSha256,
    sidecarSha256: sidecar.kind === 'ok' ? sidecar.digest : null,
    sidecarPresent,
  };
}

async function runArchiveVerification(
  fingerprint: string,
  sessionId: string,
  purpose: ArchivePurpose,
  capture = false,
): Promise<CapturedArchiveVerification> {
  validateFingerprint(fingerprint);
  const validSessionId = validateSessionId(sessionId);

  const archiveCheckDir = path.join(workspacesHome(), fingerprint, 'sessions', 'archive');
  const archiveTarPath = path.join(archiveCheckDir, archiveFileName(validSessionId, purpose));
  const checksumSidecarPath = `${archiveTarPath}.sha256`;
  const findings: ArchiveFinding[] = [];
  const extractionRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'flowguard-archive-verify-'));
  const sessDir = path.join(extractionRoot, validSessionId);
  const archiveSnapshotPath = path.join(extractionRoot, 'archive.tar.gz');

  const prepared = await prepareArchiveForVerification(
    archiveTarPath,
    archiveSnapshotPath,
    validSessionId,
    extractionRoot,
    findings,
  );
  if (!prepared) {
    // Capture the snapshot digest BEFORE the extraction root is discarded, so
    // a blocked package is still identifiable as an unverifiable package
    // rather than reported as missing on platforms where tar inspection
    // rejects tampered bytes before extraction.
    let packageSha256: string | null = null;
    if (capture) {
      try {
        packageSha256 = await hashFile(archiveSnapshotPath);
      } catch {
        packageSha256 = null;
      }
    }
    await fs.rm(extractionRoot, { recursive: true, force: true });
    return {
      verification: buildVerificationResult(findings, null),
      capture: capture ? emptyCapture(packageSha256) : emptyCapture(),
    };
  }

  try {
    const manifest = await loadArchiveManifest(sessDir, findings);
    if (!manifest) {
      return {
        verification: buildVerificationResult(findings, null),
        capture: capture
          ? await captureVerifiedContents({
              sessDir,
              archiveSnapshotPath,
              checksumSidecarPath,
            })
          : emptyCapture(),
      };
    }

    const state = await loadArchiveState(sessDir, findings);
    await checkDiscoverySnapshots(sessDir, manifest, findings);
    await verifyManifestFiles(sessDir, manifest, findings);
    await checkUnexpectedFiles(sessDir, manifest, findings);
    await verifyArchiveIntegrity(
      { sessDir, fingerprint, validSessionId },
      manifest,
      findings,
      state,
      {
        snapshotPath: archiveSnapshotPath,
        archivePath: archiveTarPath,
        checksumSidecarPath,
      },
    );

    const result = buildVerificationResult(findings, manifest);
    const captured = capture
      ? await captureVerifiedContents({ sessDir, archiveSnapshotPath, checksumSidecarPath })
      : emptyCapture();
    getAdapterLogger().info('archive', 'archive_verified', {
      sessionId: validSessionId,
      passed: result.passed,
      findingCount: result.findings.length,
    });
    return { verification: result, capture: captured };
  } finally {
    await fs.rm(extractionRoot, { recursive: true, force: true });
  }
}

// ─── Result Construction ──────────────────────────────────────────────────────

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
