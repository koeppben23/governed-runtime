/**
 * @module adapters/workspace/evidence-artifact-ticket
 * @description Ticket evidence artifact materialization and verification.
 *
 * @version v1
 */

import { hashText } from '../../shared/hashing.js';
import type { SessionState } from '../../state/schema.js';
import {
  EvidenceArtifactError,
  EVIDENCE_ARTIFACT_SCHEMA_VERSION,
  artifactFile,
  writeImmutableFile,
  type EvidenceArtifactMeta,
} from './evidence-artifact-core.js';
import { assertMarkdownIntegrity, readArtifactVersions } from './evidence-artifact-metadata.js';
import { formatTicketMarkdown } from './evidence-artifact-format.js';

export async function materializeTicketArtifact(
  artifactsDir: string,
  state: SessionState,
  sourceStateHash: string,
  createdPaths: string[],
): Promise<void> {
  const ticket = state.ticket;
  if (!ticket) return;

  const existing = await readArtifactVersions(artifactsDir, 'ticket');
  const matching = existing.find((entry) => entry.meta.contentHash === ticket.digest);
  if (matching) return;

  const version = (existing[existing.length - 1]?.meta.version ?? 0) + 1;
  const file = artifactFile(artifactsDir, 'ticket', version);
  const markdown = formatTicketMarkdown(version, ticket.text, ticket.createdAt, state.id);
  const meta: EvidenceArtifactMeta = {
    schemaVersion: EVIDENCE_ARTIFACT_SCHEMA_VERSION,
    artifactType: 'ticket',
    version,
    sessionId: state.id,
    createdAt: ticket.createdAt,
    phase: state.phase,
    sourceStateHash,
    contentHash: ticket.digest,
    markdownHash: hashText(markdown),
    derivedFrom: 'session-state.json',
    markdownPath: file.markdownRelPath,
  };

  await writeImmutableFile(file.markdownAbsPath, markdown, createdPaths);
  await writeImmutableFile(file.jsonAbsPath, JSON.stringify(meta, null, 2) + '\n', createdPaths);
}

export async function verifyTicketArtifacts(
  artifactsDir: string,
  state: SessionState,
): Promise<void> {
  const ticket = state.ticket;
  if (!ticket) return;

  const entries = await readArtifactVersions(artifactsDir, 'ticket');
  const latest = entries[entries.length - 1];
  if (!latest) {
    throw new EvidenceArtifactError(
      'EVIDENCE_ARTIFACT_MISSING',
      'Ticket evidence artifacts are missing for current state',
    );
  }

  for (const entry of entries) {
    await assertMarkdownIntegrity(artifactsDir, entry.meta, 'ticket');
  }

  if (latest.meta.contentHash !== ticket.digest) {
    throw new EvidenceArtifactError(
      'EVIDENCE_ARTIFACT_MISMATCH',
      `Ticket artifact hash mismatch: state=${ticket.digest.slice(0, 12)} artifact=${latest.meta.contentHash.slice(0, 12)}`,
    );
  }
}
