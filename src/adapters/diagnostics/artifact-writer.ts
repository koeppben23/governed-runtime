/**
 * @module adapters/diagnostics/artifact-writer
 * @description Write-once artifact publication with per-file and total budgets.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { hashBuffer } from '../../shared/hashing.js';
import {
  redactAuditEvent,
  redactDiagnosticPayload,
  redactSessionState,
} from '../../redaction/export-redaction.js';
import { validateSessionId } from '../workspace/types.js';
import { DIAGNOSTIC_EXPORT_SCHEMA_VERSION } from './export-schema.js';
import { DiagnosticExportError } from './errors.js';
import { projectReviewAssurance } from './review-projection.js';
import {
  warning,
  type ArtifactWriteTarget,
  type CaptureAccumulator,
  type SessionCapture,
} from './types.js';

export async function writeArtifact(
  outputDir: string,
  relativePath: string,
  content: string | Buffer,
  acc: CaptureAccumulator,
  options: { readonly enforceTotal?: boolean } = {},
): Promise<boolean> {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  if (
    bytes.byteLength > acc.maxFileBytes ||
    (options.enforceTotal !== false && acc.totalBytes + bytes.byteLength > acc.maxTotalBytes)
  ) {
    acc.warnings.push(
      warning(
        'ARTIFACT_TOO_LARGE',
        `Artifact ${relativePath.replace(/\\/g, '/')} exceeds the per-file or total capture budget and was not written.`,
        null,
        'capture',
      ),
    );
    return false;
  }
  const full = path.join(outputDir, relativePath);
  await mkdir(path.dirname(full), { recursive: true, mode: 0o700 });
  try {
    await writeFile(full, bytes, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    throw new DiagnosticExportError(
      'WRITE_FAILED',
      `Cannot write diagnostic artifact ${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  acc.totalBytes += bytes.byteLength;
  acc.receipts.push({
    path: relativePath.replace(/\\/g, '/'),
    sha256: hashBuffer(bytes),
    bytes: bytes.byteLength,
  });
  return true;
}

function artifactName(
  base: string,
  extension: string,
  mode: ArtifactWriteTarget['redactionMode'],
): string {
  return `${base}${mode === 'none' ? '' : '.redacted'}${extension}`;
}

async function writeStateArtifacts(
  target: ArtifactWriteTarget,
  session: SessionCapture,
  sessionDir: string,
  acc: CaptureAccumulator,
): Promise<void> {
  if (session.state === null) return;
  const redacted = redactSessionState(session.state, target.redactionMode);
  await writeArtifact(
    target.outputDir,
    `${sessionDir}/${artifactName('state', '.json', target.redactionMode)}`,
    `${JSON.stringify(redacted, null, 2)}\n`,
    acc,
  );
  const review = projectReviewAssurance(session.state);
  if (review === null) return;
  await writeArtifact(
    target.outputDir,
    `${sessionDir}/review-assurance.json`,
    `${JSON.stringify(review, null, 2)}\n`,
    acc,
  );
}

async function writeAuditArtifact(
  target: ArtifactWriteTarget,
  session: SessionCapture,
  sessionDir: string,
  acc: CaptureAccumulator,
): Promise<void> {
  if (session.audit.length === 0) return;
  const lines = session.audit.map((event) =>
    JSON.stringify(
      redactAuditEvent(event as unknown as Record<string, unknown>, target.redactionMode),
    ),
  );
  await writeArtifact(
    target.outputDir,
    `${sessionDir}/${artifactName('audit', '.jsonl', target.redactionMode)}`,
    `${lines.join('\n')}\n`,
    acc,
  );
}

async function writeHostArtifact(
  target: ArtifactWriteTarget,
  session: SessionCapture,
  sessionDir: string,
  acc: CaptureAccumulator,
): Promise<void> {
  if (session.host === null) return;
  const redacted = redactDiagnosticPayload(session.host.payload, target.redactionMode);
  await writeArtifact(
    target.outputDir,
    `${sessionDir}/${artifactName('host.transcript', '.json', target.redactionMode)}`,
    `${JSON.stringify(redacted, null, 2)}\n`,
    acc,
  );
}

async function writeSessionMetadata(
  target: ArtifactWriteTarget,
  session: SessionCapture,
  sessionDir: string,
  acc: CaptureAccumulator,
  createdAt: string,
): Promise<void> {
  await writeArtifact(
    target.outputDir,
    `${sessionDir}/session.json`,
    `${JSON.stringify(
      {
        schemaVersion: DIAGNOSTIC_EXPORT_SCHEMA_VERSION,
        sessionId: session.sessionId,
        capturedAt: createdAt,
        authority: session.authority?.status ?? 'unavailable',
        lineage: session.lineage,
        ...(session.authority?.status === 'resolved'
          ? {
              fingerprint: session.authority.fingerprint,
              worktreeName: path.basename(session.authority.worktreeRoot),
            }
          : {}),
        auditChain:
          session.auditValid === null ? 'NOT_VERIFIED' : session.auditValid ? 'valid' : 'invalid',
        hostHistory: session.hostRequested
          ? session.host
            ? 'captured'
            : 'unavailable'
          : 'not_requested',
      },
      null,
      2,
    )}\n`,
    acc,
  );
}

async function writeSessionArtifacts(
  target: ArtifactWriteTarget,
  session: SessionCapture,
  acc: CaptureAccumulator,
  createdAt: string,
): Promise<void> {
  const sessionDir = `sessions/${validateSessionId(session.sessionId)}`;
  await writeStateArtifacts(target, session, sessionDir, acc);
  await writeAuditArtifact(target, session, sessionDir, acc);
  await writeHostArtifact(target, session, sessionDir, acc);
  await writeSessionMetadata(target, session, sessionDir, acc, createdAt);
}

export async function writeAllSessionArtifacts(
  target: ArtifactWriteTarget,
  acc: CaptureAccumulator,
  createdAt: string,
): Promise<void> {
  for (const session of acc.sessions) {
    try {
      await writeSessionArtifacts(target, session, acc, createdAt);
    } catch (error) {
      if (error instanceof DiagnosticExportError) throw error;
      throw new DiagnosticExportError(
        'WRITE_FAILED',
        `Cannot write session artifacts: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
}
