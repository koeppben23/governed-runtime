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
  const archiveRoot = path.join(stagingRoot, input.sessionId);
  await fs.mkdir(archiveRoot, { recursive: true });

  const redactedFiles: string[] = [];

  // ── Phase 1: Redacted payloads ──────────────────────────────────────────
  if (input.redactionMode !== 'none') {
    // Session state redaction
    if (input.state) {
      const redactedState = redactSessionState(
        input.state as unknown as Record<string, unknown>,
        input.redactionMode,
      );
      const target = archivePath(archiveRoot, ARCHIVE_LAYOUT.stateRedacted);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, JSON.stringify(redactedState, null, 2) + '\n', 'utf-8');
      redactedFiles.push(ARCHIVE_LAYOUT.stateRedacted);
    }

    // Audit trail redaction
    const redactedEvents: Record<string, unknown>[] = [];
    for (const event of input.events) {
      redactedEvents.push(redactAuditEvent(event as Record<string, unknown>, input.redactionMode));
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
      (r) => r.sessionId === input.sessionId,
    );
    if (receipts.length > 0) {
      const redactedReceipts = redactDecisionReceipts(
        { receipts } as Record<string, unknown>,
        input.redactionMode,
      );
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
      await copyIfPresent(path.join(input.sessDir, source), archivePath(archiveRoot, target));
    }
    await writeDecisionReceipts(archiveRoot, input.sessionId, input.events);
    await copyEvidence(input.sessDir, archiveRoot);
  }

  // ── Phase 3: Manifest (after all files written) ─────────────────────────
  const excludedFiles = input.includeRaw
    ? []
    : Object.values(RAW_SOURCE_PATHS).filter((p) => !redactedFiles.includes(p));

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
    (receipt) => receipt.sessionId === sessionId,
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

async function copyEvidence(sessDir: string, archiveRoot: string): Promise<void> {
  const files = await listSessionFiles(sessDir);
  for (const relativePath of files) {
    if (relativePath.startsWith('artifacts/')) {
      await copyIfPresent(
        path.join(sessDir, relativePath),
        archivePath(archiveRoot, archiveArtifactPath(path.posix.basename(relativePath))),
      );
    }
    if (/^implementation-diff\.[a-f0-9]+\.patch$/.test(relativePath)) {
      await copyIfPresent(
        path.join(sessDir, relativePath),
        archivePath(archiveRoot, archiveImplementationPath(path.posix.basename(relativePath))),
      );
    }
  }
}

async function buildManifest(
  archiveRoot: string,
  input: ArchiveStagingInput & { redactedFiles: string[]; excludedFiles: string[] },
): Promise<ArchiveManifest> {
  const includedFiles = await listSessionFiles(archiveRoot);
  const fileDigests: Record<string, string> = {};
  for (const file of includedFiles)
    fileDigests[file] = hashBuffer(await fs.readFile(path.join(archiveRoot, file)));
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
    redactedArtifacts: input.redactedFiles.length > 0 ? input.redactedFiles : undefined,
    excludedFiles: input.excludedFiles.length > 0 ? input.excludedFiles : undefined,
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
    redactedArtifacts: input.redactedFiles.length > 0 ? input.redactedFiles : undefined,
    excludedFiles: input.excludedFiles.length > 0 ? input.excludedFiles : undefined,
  };
}
