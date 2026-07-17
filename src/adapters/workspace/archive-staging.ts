/**
 * @module workspace/archive-staging
 * @description Builds the complete raw-evidence Archive Layout v2 staging tree.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { hashBuffer } from '../../shared/hashing.js';
import { getLastChainHash } from '../../audit/integrity.js';
import { decisionReceipts } from '../../audit/query.js';
import type { AuditEvent } from '../../state/evidence.js';
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

const SOURCE_PATHS: Readonly<Record<string, string>> = {
  'session-state.json': ARCHIVE_LAYOUT.state,
  'audit.jsonl': ARCHIVE_LAYOUT.audit,
  'discovery-snapshot.json': ARCHIVE_LAYOUT.discovery,
  'profile-resolution-snapshot.json': ARCHIVE_LAYOUT.profileResolution,
  'review-report.json': ARCHIVE_LAYOUT.reviewReport,
};

export async function createArchiveStaging(input: {
  archiveDir: string;
  sessionId: string;
  fingerprint: string;
  sessDir: string;
  state: import('../../state/schema.js').SessionState | null;
  events: readonly Record<string, unknown>[];
}): Promise<{ stagingRoot: string; archiveRoot: string; manifest: ArchiveManifest }> {
  const stagingRoot = await fs.mkdtemp(path.join(input.archiveDir, '.staging-'));
  const archiveRoot = path.join(stagingRoot, input.sessionId);
  await fs.mkdir(archiveRoot, { recursive: true });

  for (const [source, target] of Object.entries(SOURCE_PATHS)) {
    await copyIfPresent(path.join(input.sessDir, source), archivePath(archiveRoot, target));
  }
  await writeDecisionReceipts(archiveRoot, input.sessionId, input.events);
  await copyEvidence(input.sessDir, archiveRoot);

  const manifest = await buildManifest(archiveRoot, input);
  await fs.writeFile(
    archivePath(archiveRoot, ARCHIVE_MANIFEST_FILE),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf-8',
  );
  return { stagingRoot, archiveRoot, manifest };
}

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
  input: Parameters<typeof createArchiveStaging>[0],
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
  };
  return {
    ...manifestBase,
    createdAt: new Date().toISOString(),
    profileId: input.state?.activeProfile?.id ?? 'baseline',
    contentDigest: computeArchiveContentDigest(manifestBase),
    rawIncluded: true,
    riskFlags: ['raw_audit_evidence_export'],
  };
}
