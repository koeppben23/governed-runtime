/**
 * @module workspace/archive
 * @description Session archiving and archive verification.
 *
 * Creates compressed tar.gz archives of completed sessions with:
 * - Archive manifest (file inventory + SHA-256 digests)
 * - SHA-256 checksum sidecar file
 * - Discovery snapshot soft-check
 *
 * @version v1
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { readAuditTrail, readConfig, readState } from "../persistence";
import { DEFAULT_CONFIG } from "../../config/flowguard-config";
import {
  ArchiveManifestSchema,
  ARCHIVE_MANIFEST_SCHEMA_VERSION,
  type ArchiveManifest,
  type ArchiveVerification,
  type ArchiveFinding,
} from "../../archive/types";
import { decisionReceipts } from "../../audit/query";
import {
  redactDecisionReceipts,
  redactReviewReport,
  type RedactionMode,
} from "../../redaction/export-redaction";

import {
  WorkspaceError,
  validateFingerprint,
  validateSessionId,
} from "./types";
import { workspacesHome, sessionDir, workspaceDir } from "./init";

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
export async function archiveSession(
  fingerprint: string,
  sessionId: string,
): Promise<string> {
  validateFingerprint(fingerprint);
  const validSessionId = validateSessionId(sessionId);

  const sessDir = sessionDir(fingerprint, validSessionId);
  const wsDir = workspaceDir(fingerprint);
  const archiveDir = path.join(workspacesHome(), fingerprint, "sessions", "archive");
  const archivePath = path.join(archiveDir, `${validSessionId}.tar.gz`);
  const checksumPath = `${archivePath}.sha256`;

  // Verify session directory exists
  try {
    await fs.access(sessDir);
  } catch {
    throw new WorkspaceError(
      "ARCHIVE_FAILED",
      `Session directory does not exist: ${sessDir}`,
    );
  }

  // ── Soft-check: warn if discovery snapshots are missing ────────
  const state = await readState(sessDir).catch(() => null);
  if (state?.discoveryDigest) {
    const snapshotPath = path.join(sessDir, "discovery-snapshot.json");
    try {
      await fs.access(snapshotPath);
    } catch {
      // Soft warning — log but don't fail. The archive will just lack the snapshot.
      // In a real system this would go to a logger; here we proceed gracefully.
    }
  }

  const config = await readConfig(wsDir).catch(() => DEFAULT_CONFIG);
  const redactionMode = config.archive.redaction.mode;
  const includeRaw = config.archive.redaction.includeRaw;

  // ── Build and write archive manifest ──────────────────────────
  const { events } = await readAuditTrail(sessDir).catch(() => ({ events: [] }));
  const receipts = decisionReceipts(events).filter((r) => r.sessionId === validSessionId);
  const receiptsPayload = {
    schemaVersion: "decision-receipts.v1",
    sessionId: validSessionId,
    generatedAt: new Date().toISOString(),
    count: receipts.length,
    receipts,
  };
  await fs.writeFile(
    path.join(sessDir, "decision-receipts.v1.json"),
    JSON.stringify(receiptsPayload, null, 2) + "\n",
    "utf-8",
  );

  const redactedArtifacts: string[] = [];
  const excludedFiles: string[] = [];
  const riskFlags: string[] = [];

  if (redactionMode !== "none") {
    await writeRedactedExportArtifact(
      sessDir,
      "decision-receipts.v1.json",
      "decision-receipts.redacted.v1.json",
      redactionMode,
      redactDecisionReceipts,
    );
    redactedArtifacts.push("decision-receipts.redacted.v1.json");
    if (!includeRaw) excludedFiles.push("decision-receipts.v1.json");

    const reviewPath = path.join(sessDir, "review-report.json");
    if (await fileExists(reviewPath)) {
      await writeRedactedExportArtifact(
        sessDir,
        "review-report.json",
        "review-report.redacted.json",
        redactionMode,
        redactReviewReport,
      );
      redactedArtifacts.push("review-report.redacted.json");
      if (!includeRaw) excludedFiles.push("review-report.json");
    }
  }

  if (includeRaw) {
    riskFlags.push("raw_export_enabled");
  }

  const manifest = await buildArchiveManifest(
    sessDir,
    state,
    fingerprint,
    validSessionId,
    {
      redactionMode,
      rawIncluded: includeRaw || redactionMode === "none",
      redactedArtifacts,
      excludedFiles,
      riskFlags,
    },
  );
  const manifestJson = JSON.stringify(manifest, null, 2) + "\n";
  await fs.writeFile(path.join(sessDir, "archive-manifest.json"), manifestJson, "utf-8");

  // Create archive directory
  try {
    await fs.mkdir(archiveDir, { recursive: true });
  } catch (err) {
    throw new WorkspaceError(
      "ARCHIVE_FAILED",
      `Failed to create archive directory: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Create tar.gz using system tar (available on Windows 10+, macOS, Linux)
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  try {
    // Use -C to change to parent directory, archive the session subdirectory
    const sessionsParent = path.join(workspacesHome(), fingerprint, "sessions");
    const tarArgs = [
      "czf",
      archivePath,
      "-C",
      sessionsParent,
      ...excludedFiles.map((relPath) => `--exclude=${path.posix.join(validSessionId, relPath)}`),
      validSessionId,
    ];
    await execFileAsync("tar", tarArgs, {
      timeout: 30_000,
      windowsHide: true,
    });
  } catch (err) {
    throw new WorkspaceError(
      "ARCHIVE_FAILED",
      `tar command failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── Write .sha256 sidecar ─────────────────────────────────────
  try {
    const archiveBuffer = await fs.readFile(archivePath);
    const archiveHash = crypto.createHash("sha256").update(archiveBuffer).digest("hex");
    await fs.writeFile(checksumPath, `${archiveHash}  ${path.basename(archivePath)}\n`, "utf-8");
  } catch {
    // Non-fatal: archive was created but checksum sidecar failed.
    // The archive is still usable, just not externally verifiable.
  }

  return archivePath;
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
 *
 * @param fingerprint - Workspace fingerprint.
 * @param sessionId - Session ID to verify.
 * @returns Structured verification result with findings.
 */
export async function verifyArchive(
  fingerprint: string,
  sessionId: string,
): Promise<ArchiveVerification> {
  validateFingerprint(fingerprint);
  const validSessionId = validateSessionId(sessionId);

  const sessDir = sessionDir(fingerprint, validSessionId);
  const findings: ArchiveFinding[] = [];
  let manifest: ArchiveManifest | null = null;

  // 1. Read and parse manifest
  const manifestPath = path.join(sessDir, "archive-manifest.json");
  let manifestRaw: string;
  try {
    manifestRaw = await fs.readFile(manifestPath, "utf-8");
  } catch {
    findings.push({
      code: "missing_manifest",
      severity: "error",
      message: "Archive manifest not found in session directory",
      file: "archive-manifest.json",
    });
    return buildVerificationResult(findings, null);
  }

  try {
    const parsed = JSON.parse(manifestRaw);
    const result = ArchiveManifestSchema.safeParse(parsed);
    if (!result.success) {
      findings.push({
        code: "manifest_parse_error",
        severity: "error",
        message: `Manifest schema validation failed: ${result.error.message}`,
        file: "archive-manifest.json",
      });
      return buildVerificationResult(findings, null);
    }
    manifest = result.data;
  } catch {
    findings.push({
      code: "manifest_parse_error",
      severity: "error",
      message: "Manifest is not valid JSON",
      file: "archive-manifest.json",
    });
    return buildVerificationResult(findings, null);
  }

  // 2. Check state file
  const stateExists = await fileExists(path.join(sessDir, "session-state.json"));
  if (!stateExists) {
    findings.push({
      code: "state_missing",
      severity: "error",
      message: "Session state file not found",
      file: "session-state.json",
    });
  }

  // 3. Check discovery snapshots (if discoveryDigest is set)
  if (manifest.discoveryDigest) {
    for (const snapshotFile of [
      "discovery-snapshot.json",
      "profile-resolution-snapshot.json",
    ]) {
      const exists = await fileExists(path.join(sessDir, snapshotFile));
      if (!exists) {
        findings.push({
          code: "snapshot_missing",
          severity: "warning",
          message: `Discovery snapshot not found: ${snapshotFile}`,
          file: snapshotFile,
        });
      }
    }
  }

  // 4. Check each file in manifest
  for (const relPath of manifest.includedFiles) {
    const fullPath = path.join(sessDir, relPath);
    const exists = await fileExists(fullPath);
    if (!exists) {
      findings.push({
        code: "missing_file",
        severity: "error",
        message: `File listed in manifest is missing: ${relPath}`,
        file: relPath,
      });
      continue;
    }

    // Check file digest
    const expectedDigest = manifest.fileDigests[relPath];
    if (expectedDigest) {
      const content = await fs.readFile(fullPath);
      const actualDigest = crypto.createHash("sha256").update(content).digest("hex");
      if (actualDigest !== expectedDigest) {
        findings.push({
          code: "file_digest_mismatch",
          severity: "error",
          message: `File digest mismatch for ${relPath}: expected ${expectedDigest.slice(0, 12)}..., got ${actualDigest.slice(0, 12)}...`,
          file: relPath,
        });
      }
    }
  }

  // 5. Check for unexpected files
  const manifestFileSet = new Set(manifest.includedFiles);
  const excludedSet = new Set(manifest.excludedFiles ?? []);
  try {
    const actualFiles = await listSessionFiles(sessDir);
    for (const file of actualFiles) {
      if (excludedSet.has(file)) continue;
      if (!manifestFileSet.has(file)) {
        findings.push({
          code: "unexpected_file",
          severity: "warning",
          message: `File not listed in manifest: ${file}`,
          file,
        });
      }
    }
  } catch {
    // Can't list files — skip unexpected file check
  }

  // 6. Verify content digest
  if (manifest.includedFiles.length > 0) {
    const digestValues = manifest.includedFiles
      .map((f) => manifest.fileDigests[f])
      .filter(Boolean)
      .sort();
    const computedContentDigest = crypto
      .createHash("sha256")
      .update(digestValues.join(""))
      .digest("hex");
    if (computedContentDigest !== manifest.contentDigest) {
      findings.push({
        code: "content_digest_mismatch",
        severity: "error",
        message: "Content digest does not match computed value from file digests",
      });
    }
  }

  // 7. Verify archive checksum sidecar
  const archiveCheckDir = path.join(workspacesHome(), fingerprint, "sessions", "archive");
  const archiveTarPath = path.join(archiveCheckDir, `${validSessionId}.tar.gz`);
  const checksumSidecarPath = `${archiveTarPath}.sha256`;

  const checksumExists = await fileExists(checksumSidecarPath);
  if (!checksumExists) {
    findings.push({
      code: "archive_checksum_missing",
      severity: "warning",
      message: "Archive checksum sidecar (.sha256) not found",
    });
  } else {
    try {
      const sidecarContent = await fs.readFile(checksumSidecarPath, "utf-8");
      const expectedHash = sidecarContent.trim().split(/\s+/)[0];
      const archiveBuffer = await fs.readFile(archiveTarPath);
      const actualHash = crypto.createHash("sha256").update(archiveBuffer).digest("hex");
      if (expectedHash !== actualHash) {
        findings.push({
          code: "archive_checksum_mismatch",
          severity: "error",
          message: `Archive checksum mismatch: sidecar says ${expectedHash?.slice(0, 12)}..., actual is ${actualHash.slice(0, 12)}...`,
        });
      }
    } catch {
      // Can't read archive or sidecar — skip
    }
  }

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
  state: import("../../state/schema").SessionState | null,
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
    fileDigests[relPath] = crypto.createHash("sha256").update(content).digest("hex");
  }

  // Content digest: SHA-256 of sorted, concatenated file digest values
  const sortedDigestValues = files
    .map((f) => fileDigests[f])
    .filter(Boolean)
    .sort();
  const contentDigest = crypto
    .createHash("sha256")
    .update(sortedDigestValues.join(""))
    .digest("hex");

  // includedFiles lists only session artifacts — NOT the manifest itself.
  // The manifest is metadata ABOUT the archive content. Self-referential
  // inclusion is impossible (the manifest cannot contain its own digest)
  // and would create fragile accidental-correctness in verification.
  // The manifest file IS physically present in the archive but is not
  // part of the content-digest computation.
  const includedFiles = [...files].sort();

  return {
    schemaVersion: ARCHIVE_MANIFEST_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    sessionId,
    fingerprint,
    policyMode: state?.policySnapshot?.mode ?? "unknown",
    profileId: state?.activeProfile?.id ?? "baseline",
    discoveryDigest: state?.discoveryDigest ?? null,
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
      } else if (entry.isFile() && entry.name !== "archive-manifest.json") {
        if (!excluded.has(relPath)) {
          files.push(relPath);
        }
      }
    }
  }

  await walk(sessDir, "");
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
    rawContent = await fs.readFile(rawPath, "utf-8");
  } catch (err) {
    throw new WorkspaceError(
      "ARCHIVE_FAILED",
      `Redaction source read failed (${rawFile}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawContent) as Record<string, unknown>;
  } catch {
    throw new WorkspaceError("ARCHIVE_FAILED", `Redaction source is invalid JSON: ${rawFile}`);
  }

  let redacted: Record<string, unknown>;
  try {
    redacted = redact(payload, mode);
  } catch (err) {
    throw new WorkspaceError(
      "ARCHIVE_FAILED",
      `Redaction failed for ${rawFile}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  await fs.writeFile(path.join(sessDir, redactedFile), JSON.stringify(redacted, null, 2) + "\n", "utf-8");
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
  const hasError = findings.some((f) => f.severity === "error");
  return {
    passed: !hasError,
    findings,
    manifest,
    verifiedAt: new Date().toISOString(),
  };
}
