/**
 * @module workspace/archive-staging
 * @description Builds the Archive Layout v2 staging tree with redaction support.
 *
 * Ordering is fail-closed:
 *   1. Validate inputs
 *   2. Generate redacted payloads (if mode ≠ none)
 *   3. Copy raw files (if includeRaw)
 *   4. Build and write manifest
 *   Any failure in steps 1-3 leaves the staging tree empty — nothing persisted.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { hashBuffer } from '../../shared/hashing.js';
import { getLastChainHash } from '../../audit/integrity.js';
import { decisionReceipts } from '../../audit/query.js';
import type { AuditEvent } from '../../state/evidence.js';
import type { RedactionMode } from '../../redaction/export-redaction.js';
import {
  redactSessionState,
  redactAuditEvent,
  redactDecisionReceipts,
  redactReviewReport,
} from '../../redaction/export-redaction.js';
import {
  ARCHIVE_LAYOUT_VERSION,
  ARCHIVE_MANIFEST_SCHEMA_VERSION,
  MANIFEST_POLICY_MODE_UNKNOWN,
  type ArchiveManifest,
} from '../../archive/types.js';
import { computeArchiveContentDigest } from '../../archive/content-digest.js';
import { listSessionFiles, fileExists } from './archive-files.js';
import {
  ARCHIVE_LAYOUT,
  ARCHIVE_MANIFEST_FILE,
  archiveArtifactPath,
  archiveImplementationPath,
  archivePath,
} from './archive-layout.js';

const RAW_SOURCE_PATHS: Readonly<Record<string, string>> = {
  'session-state.json': ARCHIVE_LAYOUT.state,
  'audit.jsonl': ARCHIVE_LAYOUT.audit,
  'discovery-snapshot.json': ARCHIVE_LAYOUT.discovery,
  'profile-resolution-snapshot.json': ARCHIVE_LAYOUT.profileResolution,
  'review-report.json': ARCHIVE_LAYOUT.reviewReport,
};

export interface ArchiveStagingInput {
  archiveDir: string;
  sessionId: string;
  fingerprint: string;
  sessDir: string;
  state: import('../../state/schema.js').SessionState | null;
  events: readonly Record<string, unknown>[];
  redactionMode: RedactionMode;
  includeRaw: boolean;
}

export async function createArchiveStaging(
  input: ArchiveStagingInput,
): Promise<{ stagingRoot: string; archiveRoot: string; manifest: ArchiveManifest }> {
  const stagingRoot = await fs.mkdtemp(path.join(input.archiveDir, '.staging-'));
  try {
    return await buildStaging(stagingRoot, input);
  } catch (error) {
    await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function buildStaging(
  stagingRoot: string,
  input: ArchiveStagingInput,
): Promise<{ stagingRoot: string; archiveRoot: string; manifest: ArchiveManifest }> {
  const archiveRoot = path.join(stagingRoot, input.sessionId);
  await fs.mkdir(archiveRoot, { recursive: true });

  const redactedFiles: string[] = [];
  const rawFilesProduced: string[] = [];

  // ── Phase 1: Redacted payloads ──────────────────────────────────────────
  if (input.redactionMode !== 'none') {
    // Session state redaction
    if (input.state) {
      const redactedState = redactSessionState(input.state, input.redactionMode);
      const target = archivePath(archiveRoot, ARCHIVE_LAYOUT.stateRedacted);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, JSON.stringify(redactedState, null, 2) + '\n', 'utf-8');
      redactedFiles.push(ARCHIVE_LAYOUT.stateRedacted);
    }

    // Audit trail redaction
    const redactedEvents: Record<string, unknown>[] = [];
    for (const event of input.events) {
      redactedEvents.push(redactAuditEvent(event, input.redactionMode));
    }
    if (redactedEvents.length > 0) {
      const target = archivePath(archiveRoot, ARCHIVE_LAYOUT.auditRedacted);
      await fs.mkdir(path.dirname(target), { recursive: true });
      const jsonl = redactedEvents.map((e) => JSON.stringify(e)).join('\n') + '\n';
      await fs.writeFile(target, jsonl, 'utf-8');
      redactedFiles.push(ARCHIVE_LAYOUT.auditRedacted);
    }

    // Decision receipts redaction
    const receipts = decisionReceipts(input.events as AuditEvent[]).filter(
      (r) => r.hostSessionId === input.sessionId || r.flowguardSessionId === input.sessionId,
    );
    if (receipts.length > 0) {
      const redactedReceipts = redactDecisionReceipts({ receipts }, input.redactionMode);
      const target = archivePath(archiveRoot, ARCHIVE_LAYOUT.receiptsRedacted);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, JSON.stringify(redactedReceipts, null, 2) + '\n', 'utf-8');
      redactedFiles.push(ARCHIVE_LAYOUT.receiptsRedacted);
    }

    // Review report redaction
    const reviewReportSrc = path.join(input.sessDir, 'review-report.json');
    if (await fileExists(reviewReportSrc)) {
      const raw = JSON.parse(await fs.readFile(reviewReportSrc, 'utf-8'));
      const redacted = redactReviewReport(raw as Record<string, unknown>, input.redactionMode);
      const target = archivePath(archiveRoot, ARCHIVE_LAYOUT.reviewReportRedacted);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, JSON.stringify(redacted, null, 2) + '\n', 'utf-8');
      redactedFiles.push(ARCHIVE_LAYOUT.reviewReportRedacted);
    }
  }

  // ── Phase 2: Raw files (only after successful redaction) ────────────────
  if (input.includeRaw) {
    for (const [source, target] of Object.entries(RAW_SOURCE_PATHS)) {
      const srcPath = path.join(input.sessDir, source);
      if (await fileExists(srcPath)) {
        await copyRawSource(srcPath, archivePath(archiveRoot, target), source, input.events);
        rawFilesProduced.push(target);
      }
    }
    const receiptsExist =
      decisionReceipts(input.events as AuditEvent[]).filter(
        (r) => r.hostSessionId === input.sessionId || r.flowguardSessionId === input.sessionId,
      ).length > 0;
    if (receiptsExist) {
      await writeDecisionReceipts(archiveRoot, input.sessionId, input.events);
      rawFilesProduced.push(ARCHIVE_LAYOUT.receipts);
    }
    await copyEvidence(input.sessDir, archiveRoot, rawFilesProduced);
  }

  // ── Phase 3: Manifest (after all files written) ─────────────────────────
  const excludedFiles = input.includeRaw
    ? []
    : await computeExcludedFiles(input.sessDir, input.events, input.sessionId);

  const manifest = await buildManifest(archiveRoot, {
    ...input,
    redactedFiles,
    excludedFiles,
  });
  await fs.writeFile(
    archivePath(archiveRoot, ARCHIVE_MANIFEST_FILE),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf-8',
  );
  return { stagingRoot, archiveRoot, manifest };
}

async function copyRawSource(
  sourcePath: string,
  targetPath: string,
  source: string,
  events: readonly Record<string, unknown>[],
): Promise<void> {
  if (source !== 'audit.jsonl') return copyIfPresent(sourcePath, targetPath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(
    targetPath,
    events.map((event) => JSON.stringify(event)).join('\n') + '\n',
    'utf-8',
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

async function copyIfPresent(source: string, target: string): Promise<void> {
  if (!(await fileExists(source))) return;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target);
}

async function writeDecisionReceipts(
  archiveRoot: string,
  sessionId: string,
  events: readonly Record<string, unknown>[],
): Promise<void> {
  const receipts = decisionReceipts(events as AuditEvent[]).filter(
    (receipt) => receipt.hostSessionId === sessionId || receipt.flowguardSessionId === sessionId,
  );
  if (receipts.length === 0) return;
  const target = archivePath(archiveRoot, ARCHIVE_LAYOUT.receipts);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(
    target,
    JSON.stringify(
      {
        schemaVersion: 'decision-receipts.v1',
        sessionId,
        generatedAt: new Date().toISOString(),
        count: receipts.length,
        receipts,
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );
}

async function copyEvidence(
  sessDir: string,
  archiveRoot: string,
  produced?: string[],
): Promise<void> {
  const files = await listSessionFiles(sessDir);
  for (const relativePath of files) {
    if (relativePath.startsWith('artifacts/')) {
      const target = archiveArtifactPath(path.posix.basename(relativePath));
      if (await fileExists(path.join(sessDir, relativePath))) {
        await copyIfPresent(path.join(sessDir, relativePath), archivePath(archiveRoot, target));
        produced?.push(target);
      }
    }
    if (/^implementation-diff\.[a-f0-9]+\.patch$/.test(relativePath)) {
      const target = archiveImplementationPath(path.posix.basename(relativePath));
      if (await fileExists(path.join(sessDir, relativePath))) {
        await copyIfPresent(path.join(sessDir, relativePath), archivePath(archiveRoot, target));
        produced?.push(target);
      }
    }
  }
}

/**
 * Compute the full set of raw files that WOULD be included when includeRaw=true.
 * These are the files intentionally excluded when includeRaw=false.
 * Derived from the same canonical inventory used by the raw-copy phase.
 */
async function computeExcludedFiles(
  sessDir: string,
  events: readonly Record<string, unknown>[],
  sessionId: string,
): Promise<string[]> {
  const excluded: string[] = [];

  // RAW_SOURCE_PATHS — files that exist at source
  for (const [source, target] of Object.entries(RAW_SOURCE_PATHS)) {
    if (await fileExists(path.join(sessDir, source))) {
      excluded.push(target);
    }
  }

  // Decision receipts — if events contain decision events for this session
  const receipts = decisionReceipts(events as AuditEvent[]).filter(
    (r) => r.hostSessionId === sessionId || r.flowguardSessionId === sessionId,
  );
  if (receipts.length > 0) {
    excluded.push(ARCHIVE_LAYOUT.receipts);
  }

  // Evidence files from session dir (artifacts, implementation diffs)
  const files = await listSessionFiles(sessDir);
  for (const relativePath of files) {
    if (relativePath.startsWith('artifacts/')) {
      excluded.push(archiveArtifactPath(path.posix.basename(relativePath)));
    }
    if (/^implementation-diff\.[a-f0-9]+\.patch$/.test(relativePath)) {
      excluded.push(archiveImplementationPath(path.posix.basename(relativePath)));
    }
  }

  return excluded;
}

async function computeFileDigests(
  archiveRoot: string,
  includedFiles: string[],
): Promise<Record<string, string>> {
  const digests: Record<string, string> = {};
  for (const file of includedFiles) {
    digests[file] = hashBuffer(await fs.readFile(path.join(archiveRoot, file)));
  }
  return digests;
}

function optionalArray(arr: string[]): string[] | undefined {
  return arr.length > 0 ? arr : undefined;
}

async function buildManifest(
  archiveRoot: string,
  input: ArchiveStagingInput & { redactedFiles: string[]; excludedFiles: string[] },
): Promise<ArchiveManifest> {
  const includedFiles = await listSessionFiles(archiveRoot);
  const fileDigests = await computeFileDigests(archiveRoot, includedFiles);
  const policyMode = input.state?.policySnapshot?.mode ?? MANIFEST_POLICY_MODE_UNKNOWN;
  const auditChainHead = getLastChainHash([...input.events]);
  const manifestBase = {
    includedFiles,
    fileDigests,
    policyMode,
    auditChainHead,
    auditEventCount: input.events.length,
    schemaVersion: ARCHIVE_MANIFEST_SCHEMA_VERSION,
    layoutVersion: ARCHIVE_LAYOUT_VERSION,
    sessionId: input.sessionId,
    fingerprint: input.fingerprint,
    discoveryDigest: input.state?.discoveryDigest ?? null,
    redactionMode: input.redactionMode,
    rawIncluded: input.includeRaw,
    redactedArtifacts: optionalArray(input.redactedFiles),
    excludedFiles: optionalArray(input.excludedFiles),
    riskFlags: input.includeRaw ? ['raw_audit_evidence_export'] : undefined,
  };
  return {
    ...manifestBase,
    createdAt: new Date().toISOString(),
    profileId: input.state?.activeProfile?.id ?? 'baseline',
    contentDigest: computeArchiveContentDigest(manifestBase),
    rawIncluded: input.includeRaw,
    riskFlags: input.includeRaw ? ['raw_audit_evidence_export'] : [],
    redactionMode: input.redactionMode,
    redactedArtifacts: optionalArray(input.redactedFiles),
    excludedFiles: optionalArray(input.excludedFiles),
  };
}
