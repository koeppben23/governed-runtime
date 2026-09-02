/** Audit-chain, timestamp, content-digest, and archive-checksum verification. */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hashBuffer } from '../../shared/hashing.js';
import { readState } from '../persistence.js';
import { readAuditTrail } from '../persistence-audit.js';
import { getAdapterLogger } from '../../logging/adapter-logger.js';
import { verifyChain, getLastChainHash, type ChainVerification } from '../../audit/integrity.js';
import { logAuditChainVerificationFailure } from './archive-verify-logging.js';
import {
  type ArchiveManifest,
  type ArchiveVerification,
  type ArchiveFinding,
} from '../../archive/types.js';
import { computeArchiveContentDigest } from '../../archive/content-digest.js';
import {
  findBindingArtifacts,
  isArtifactBindingEntry,
  hasTimestampEvidence,
  isCurrentChainIntegrityFailure,
  isAuditFormatFailure,
  auditReadFailureFindingCode,
  resolveArchiveStrictness,
  timestampFindingCode,
} from './archive-verify-helpers.js';
import { isPolicyMode } from '../../state/policy-mode.js';
import { validateFingerprint, validateSessionId } from './types.js';
import { workspacesHome } from './init.js';
import { withSpan, addFingerprint, addSessionId } from '../../telemetry/index.js';
import {
  loadArchiveManifest,
  verifyManifestFiles,
  checkUnexpectedFiles,
} from './archive-verify-manifest.js';
import { fileExists, snapshotArchive } from './archive-files.js';
import { type ArtifactBindingEntry } from './archive-artifact-binding.js';
import { archiveFileName } from './archive.js';
import { inspectArchiveTar } from './archive-tar.js';
import { verifyExternalPublicationBinding } from './archive-verify-publication.js';

// Timestamp token verification is lazy-imported to avoid requiring optional
// 'asn1js'/'pkijs' packages at module load time. Only needed during archive verification.

// ─── Constants ────────────────────────────────────────────────────────────────

/** Hex prefix length for logging chain-head fingerprints (never the full hash material). */
const AUDIT_HEAD_LOG_PREFIX_LENGTH = 16;

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
      return verifyArchiveImpl(fingerprint, sessionId, false);
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
      return verifyArchiveImpl(fingerprint, sessionId, true);
    },
    { 'flowguard.fingerprint': fingerprint, 'flowguard.session_id': sessionId },
  );
}

// ─── Artifact Binding ─────────────────────────────────────────────────────────

async function checkBoundArtifacts(
  sessDir: string,
  manifest: ArchiveManifest,
  bound: Map<string, ArtifactBindingEntry>,
  manifestArtifacts: string[],
  findings: ArchiveFinding[],
): Promise<void> {
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
    const actual = hashBuffer(content);
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

async function verifyArtifactBinding(
  sessDir: string,
  manifest: ArchiveManifest,
  events: readonly Record<string, unknown>[],
  findings: ArchiveFinding[],
): Promise<void> {
  const manifestArtifacts = manifest.includedFiles.filter((file) => file.startsWith('artifacts/'));
  const artifacts = findBindingArtifacts(events);
  if (manifestArtifacts.length === 0 && !artifacts) return;
  if (!artifacts) {
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
    if (isArtifactBindingEntry(entry)) bound.set(entry.path, entry);
  }

  await checkBoundArtifacts(sessDir, manifest, bound, manifestArtifacts, findings);
}

// ─── Audit Chain Logging & Findings ───────────────────────────────────────────

function addAuditFormatFindings(chainResult: ChainVerification, findings: ArchiveFinding[]): void {
  if (chainResult.reason !== 'AUDIT_ENVELOPE_INVALID') return;
  findings.push({
    code: 'audit_chain_invalid_event',
    severity: 'error',
    message:
      'Audit chain contains records that violate the canonical audit-chain.v3 event ' +
      'envelope. Non-v3 assurance artifacts cannot be treated as verifiable evidence.',
    file: 'audit.jsonl',
  });
}

// ─── Policy Mode ──────────────────────────────────────────────────────────────

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

// ─── Audit Completeness ───────────────────────────────────────────────────────

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

// ─── Timestamp Findings ───────────────────────────────────────────────────────

/**
 * Map a chain timestamp reason to the archive finding code (AC2): downgraded
 * evidence gets its own diagnostic code — a degraded status is never silently
 * folded into the generic unanchored bucket.
 */
function addTimestampMismatchFindings(
  chainResult: ReturnType<typeof verifyChain>,
  fatal: boolean,
  findings: ArchiveFinding[],
): void {
  if (
    !chainResult.valid &&
    !isCurrentChainIntegrityFailure(chainResult.reason) &&
    !isAuditFormatFailure(chainResult.reason)
  ) {
    const code = timestampFindingCode(chainResult.reason);
    findings.push({
      code,
      severity: fatal ? 'error' : 'warning',
      message: `Timestamp verification failed (${chainResult.reason}): ${chainResult.totalEvents} total, ${chainResult.verifiedCount} verified`,
      file: 'audit.jsonl',
    });
  }
  if (chainResult.timestampMonotonicity && !chainResult.timestampMonotonicity.valid) {
    findings.push({
      code: 'timestamp_unanchored',
      severity: fatal ? 'error' : 'warning',
      message: `Timestamp monotonicity violation: ${chainResult.timestampMonotonicity.message}`,
      file: 'audit.jsonl',
    });
  }
}

function addEvidenceGapFindings(
  chainResult: ReturnType<typeof verifyChain>,
  fatal: boolean,
  findings: ArchiveFinding[],
): void {
  if (chainResult.missingTimestampEvidence.length > 0) {
    findings.push({
      code: 'timestamp_unanchored',
      severity: fatal ? 'error' : 'warning',
      message: `${chainResult.missingTimestampEvidence.length} critical event(s) lack timestamp assurance evidence (indices: ${chainResult.missingTimestampEvidence.join(', ')})`,
      file: 'audit.jsonl',
    });
  }
  if (chainResult.tsaImprintMismatches.length > 0) {
    findings.push({
      code: 'tsa_verification_failed',
      severity: fatal ? 'error' : 'warning',
      message: `${chainResult.tsaImprintMismatches.length} event(s) have TSA messageImprint mismatch (indices: ${chainResult.tsaImprintMismatches.join(', ')})`,
      file: 'audit.jsonl',
    });
  }
}

function addTimestampFindings(
  chainResult: ReturnType<typeof verifyChain>,
  timestampFailuresAreFatal: boolean,
  findings: ArchiveFinding[],
): void {
  if (!chainResult.valid && isCurrentChainIntegrityFailure(chainResult.reason)) {
    findings.push({
      code: 'audit_chain_invalid',
      severity: 'error',
      message: `Audit chain verification failed (${chainResult.reason}): ${chainResult.totalEvents} total, ${chainResult.verifiedCount} verified, ${chainResult.skippedCount} skipped`,
      file: 'audit.jsonl',
    });
  }
  addTimestampMismatchFindings(chainResult, timestampFailuresAreFatal, findings);
  addEvidenceGapFindings(chainResult, timestampFailuresAreFatal, findings);
}

// ─── Chain Verification ───────────────────────────────────────────────────────

async function verifyTimestampChain(
  events: Awaited<ReturnType<typeof readAuditTrail>>['events'],
  state: import('../../state/schema.js').SessionState | null,
  manifest: ArchiveManifest,
  findings: ArchiveFinding[],
  strict: boolean,
): Promise<void> {
  const timestampPolicy = state?.policySnapshot.audit.timestampAssurance;
  const strictTimestamps = events.some(hasTimestampEvidence) || timestampPolicy?.enabled === true;
  const timestampFailuresAreFatal = strict || timestampPolicy?.strict === true;
  const chainResult = verifyChain(events, {
    strictTimestamps,
    ...(state ? { expectedFlowguardSessionId: state.flowguardSessionId } : {}),
  });
  logAuditChainVerificationFailure(chainResult);
  addAuditFormatFindings(chainResult, findings);
  addTimestampFindings(chainResult, timestampFailuresAreFatal, findings);

  const { verifyArchiveTimestampTokens } = await import('./archive-timestamp-verification.js');
  await verifyArchiveTimestampTokens({ events, state, manifest, findings, strict });
}

async function verifyAuditChainIntegrity(
  archiveRoot: string,
  manifest: ArchiveManifest,
  findings: ArchiveFinding[],
  state: import('../../state/schema.js').SessionState | null,
  strict: boolean,
): Promise<void> {
  try {
    const { events, skipped } = await readAuditTrail(path.join(archiveRoot, 'audit'));
    verifyAuditCompleteness(manifest, events, findings);

    if (skipped > 0) {
      findings.push({
        code: 'audit_records_skipped',
        severity: strict ? 'error' : 'warning',
        message: `Audit trail contains ${skipped} unparseable line(s)`,
        file: 'audit.jsonl',
      });
    }

    await verifyArtifactBinding(archiveRoot, manifest, events, findings);

    if (events.length > 0) {
      await verifyTimestampChain(events, state, manifest, findings, strict);
    }
  } catch (error) {
    // Fail closed in every mode: malformed or non-v3 audit records are never
    // silently tolerated just because verification is non-strict.
    findings.push({
      code: auditReadFailureFindingCode(error),
      severity: 'error',
      message: `Audit chain verification could not read audit.jsonl: ${
        error instanceof Error ? error.message : String(error)
      }`,
      file: 'audit.jsonl',
    });
  }
}

// ─── Archive Integrity & Top-Level Orchestration ────────────────────────────

function addContentDigestFindings(manifest: ArchiveManifest, findings: ArchiveFinding[]): void {
  // Content digest is ALWAYS verified — including an empty archive (no included
  // files). The integrity header (policy mode, audit anchor, identity) is part of
  // the digest, so a tampered header on a 0-file manifest must still fail closed.
  let computedContentDigest: string | null = null;
  try {
    computedContentDigest = computeArchiveContentDigest({
      includedFiles: manifest.includedFiles,
      fileDigests: manifest.fileDigests,
      policyMode: manifest.policyMode,
      auditChainHead: manifest.auditChainHead,
      auditEventCount: manifest.auditEventCount,
      schemaVersion: manifest.schemaVersion,
      layoutVersion: manifest.layoutVersion,
      sessionId: manifest.sessionId,
      fingerprint: manifest.fingerprint,
      discoveryDigest: manifest.discoveryDigest,
    });
  } catch (error) {
    findings.push({
      code: 'content_digest_mismatch',
      severity: 'error',
      message: `Content digest could not be computed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }

  if (computedContentDigest !== null && computedContentDigest !== manifest.contentDigest) {
    findings.push({
      code: 'content_digest_mismatch',
      severity: 'error',
      message:
        'Content digest does not match computed value from file digests and integrity header',
    });
  }
}

function isMalformedChecksumSidecar(expectedHash: string, tokens: string[]): boolean {
  const digestTokens = tokens.filter((token) => /^[a-f0-9]{64}$/i.test(token));
  return !/^[a-f0-9]{64}$/i.test(expectedHash) || digestTokens.length !== 1;
}

function readFailureCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
}

function archiveReadFailureReason(error: unknown): string {
  const code = readFailureCode(error);
  return code === 'ENOENT' ? 'Archive tarball is missing' : 'Archive tarball is unreadable';
}

function addArchiveChecksumMismatch(findings: ArchiveFinding[], message: string): void {
  findings.push({
    code: 'archive_checksum_mismatch',
    severity: 'error',
    message,
  });
}

async function verifyArchiveChecksum(
  archiveTarPath: string,
  checksumSidecarPath: string,
  strict: boolean,
  findings: ArchiveFinding[],
): Promise<void> {
  const checksumExists = await fileExists(checksumSidecarPath);
  if (!checksumExists) {
    findings.push({
      code: 'archive_checksum_missing',
      severity: strict ? 'error' : 'warning',
      message: 'Archive checksum sidecar (.sha256) not found',
    });
    return;
  }

  let sidecarContent: string;
  try {
    sidecarContent = await fs.readFile(checksumSidecarPath, 'utf-8');
  } catch (error) {
    addArchiveChecksumMismatch(
      findings,
      `Archive checksum sidecar is unreadable; archive checksum could not be verified: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }

  const sidecarTokens = sidecarContent.trim().split(/\s+/).filter(Boolean);
  const expectedHash = sidecarTokens[0];
  if (!expectedHash || isMalformedChecksumSidecar(expectedHash, sidecarTokens)) {
    addArchiveChecksumMismatch(
      findings,
      'Archive checksum sidecar is malformed or ambiguous; expected exactly one SHA-256 digest',
    );
    return;
  }

  try {
    const archiveBuffer = await fs.readFile(archiveTarPath);
    const actualHash = hashBuffer(archiveBuffer);
    if (expectedHash !== actualHash) {
      addArchiveChecksumMismatch(
        findings,
        `Archive checksum mismatch: sidecar says ${expectedHash.slice(0, 12)}..., actual is ${actualHash.slice(0, 12)}...`,
      );
    }
  } catch (error) {
    addArchiveChecksumMismatch(
      findings,
      `${archiveReadFailureReason(error)}; archive checksum could not be verified: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function verifyArchiveIntegrity(
  location: { sessDir: string; fingerprint: string; validSessionId: string },
  manifest: ArchiveManifest,
  findings: ArchiveFinding[],
  state: import('../../state/schema.js').SessionState | null,
  archive: {
    readonly snapshotPath: string;
    readonly archivePath: string;
    readonly checksumSidecarPath: string;
  },
): Promise<void> {
  const { sessDir } = location;
  // Strict authority and completeness checks run BEFORE the content digest so a
  // mode/anchor tamper surfaces explicitly rather than only as a digest mismatch.
  const strictness = resolveArchiveStrictness(state);
  const { strict } = strictness;
  if (!strictness.policyStateResolved) {
    findings.push({
      code: 'policy_state_unresolved',
      severity: 'error',
      message:
        'Trusted policy state is unavailable; archive verification is running in fail-closed strict mode',
      file: 'state/session-state.json',
    });
  }
  verifyManifestPolicyMode(manifest, state, findings);
  await verifyAuditChainIntegrity(sessDir, manifest, findings, state, strict);
  addContentDigestFindings(manifest, findings);

  await verifyArchiveChecksum(archive.snapshotPath, archive.checksumSidecarPath, strict, findings);
  await verifyExternalPublicationBinding(location, manifest, archive, findings);
}

// Extraction, manifest validation, and cleanup must stay in one transaction.
// eslint-disable-next-line max-lines-per-function, complexity -- each branch maps a distinct archive integrity finding.
async function verifyArchiveImpl(
  fingerprint: string,
  sessionId: string,
  regulatedEvidence: boolean,
): Promise<ArchiveVerification> {
  validateFingerprint(fingerprint);
  const validSessionId = validateSessionId(sessionId);

  const archiveCheckDir = path.join(workspacesHome(), fingerprint, 'sessions', 'archive');
  const archiveTarPath = path.join(
    archiveCheckDir,
    archiveFileName(validSessionId, regulatedEvidence),
  );
  const findings: ArchiveFinding[] = [];
  const extractionRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'flowguard-archive-verify-'));
  const sessDir = path.join(extractionRoot, validSessionId);
  const archiveSnapshotPath = path.join(extractionRoot, 'archive.tar.gz');
  try {
    await snapshotArchive(archiveTarPath, archiveSnapshotPath);
  } catch (error) {
    findings.push({
      code: 'missing_manifest',
      severity: 'error',
      message: `Archive snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    await fs.rm(extractionRoot, { recursive: true, force: true });
    return buildVerificationResult(findings, null);
  }

  const inspection = await inspectArchiveTar(archiveSnapshotPath, validSessionId);
  if (inspection.kind === 'blocked') {
    findings.push({
      code: 'unexpected_file',
      severity: 'error',
      message: `Archive member policy violation: ${inspection.reason}`,
    });
    await fs.rm(extractionRoot, { recursive: true, force: true });
    return buildVerificationResult(findings, null);
  }

  try {
    await promisify(execFile)('tar', ['xzf', archiveSnapshotPath, '-C', extractionRoot], {
      timeout: 30_000,
      windowsHide: true,
    });
  } catch (error) {
    findings.push({
      code: 'missing_manifest',
      severity: 'error',
      message: `Archive extraction failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    await fs.rm(extractionRoot, { recursive: true, force: true });
    return buildVerificationResult(findings, null);
  }

  try {
    const manifest = await loadArchiveManifest(sessDir, findings);
    if (!manifest) return buildVerificationResult(findings, null);

    const stateDir = path.join(sessDir, 'state');
    const stateExists = await fileExists(path.join(stateDir, 'session-state.json'));
    let state: import('../../state/schema.js').SessionState | null = null;
    if (stateExists) {
      try {
        state = await readState(stateDir);
      } catch (error) {
        findings.push({
          code: 'state_invalid',
          severity: 'error',
          message: `Session state file could not be parsed or validated: ${
            error instanceof Error ? error.message : String(error)
          }`,
          file: 'state/session-state.json',
        });
      }
    }
    if (!stateExists) {
      findings.push({
        code: 'state_missing',
        severity: 'error',
        message: 'Session state file not found',
        file: 'state/session-state.json',
      });
    }

    if (manifest.discoveryDigest) {
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
        checksumSidecarPath: `${archiveTarPath}.sha256`,
      },
    );

    const result = buildVerificationResult(findings, manifest);
    getAdapterLogger().info('archive', 'archive_verified', {
      sessionId: validSessionId,
      passed: result.passed,
      findingCount: result.findings.length,
    });
    return result;
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
