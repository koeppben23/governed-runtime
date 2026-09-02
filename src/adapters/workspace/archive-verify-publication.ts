import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { verifyChain } from '../../audit/integrity.js';
import type { ArchiveFinding, ArchiveManifest } from '../../archive/types.js';
import { readAuditTrail } from '../persistence-audit.js';
import { archivePublicationBinding } from './archive-artifact-binding.js';
import { findPublicationBinding } from './archive-verify-helpers.js';
import { sessionDir } from './init.js';

export async function verifyExternalPublicationBinding(
  location: { fingerprint: string; validSessionId: string },
  manifest: ArchiveManifest,
  archive: {
    readonly snapshotPath: string;
    readonly archivePath: string;
    readonly checksumSidecarPath: string;
  },
  findings: ArchiveFinding[],
): Promise<void> {
  let externalAudit: Awaited<ReturnType<typeof readAuditTrail>>;
  try {
    externalAudit = await readAuditTrail(sessionDir(location.fingerprint, location.validSessionId));
  } catch (error) {
    findings.push({
      code: 'archive_publication_binding_invalid',
      severity: 'error',
      message: `External publication binding audit trail could not be read: ${error instanceof Error ? error.message : String(error)}`,
    });
    return;
  }
  if (externalAudit.skipped > 0 || !verifyChain(externalAudit.events).valid) {
    findings.push({
      code: 'archive_publication_binding_invalid',
      severity: 'error',
      message: 'External publication binding audit trail is incomplete or fails chain verification',
      file: 'audit.jsonl',
    });
    return;
  }
  try {
    const [snapshot, sidecar] = await Promise.all([
      fs.readFile(archive.snapshotPath),
      fs.readFile(archive.checksumSidecarPath),
    ]);
    const expected = archivePublicationBinding(
      snapshot,
      sidecar,
      path.basename(archive.archivePath),
      manifest.contentDigest,
    );
    if (findPublicationBinding(externalAudit.events, expected)) return;
  } catch (error) {
    findings.push({
      code: 'archive_publication_binding_invalid',
      severity: 'error',
      message: `Published archive binding could not be evaluated: ${error instanceof Error ? error.message : String(error)}`,
    });
    return;
  }
  findings.push({
    code: 'archive_publication_unbound',
    severity: 'error',
    message: 'Published archive and checksum have no exact external audit publication binding',
  });
}
