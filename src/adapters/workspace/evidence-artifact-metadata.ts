/**
 * @module adapters/workspace/evidence-artifact-metadata
 * @description Evidence artifact metadata read/validation and markdown
 * integrity checks. Parsed entries are the only read model for the
 * append-only `artifacts/` directory.
 *
 * @version v1
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { hashFile } from '../../shared/hashing.js';
import { getAdapterLogger } from '../../logging/adapter-logger.js';
import {
  EvidenceArtifactError,
  EVIDENCE_ARTIFACT_SCHEMA_VERSION,
  EVIDENCE_ARTIFACTS_DIR,
  type ArtifactType,
  type EvidenceArtifactMeta,
} from './evidence-artifact-core.js';

export async function readArtifactVersions(
  artifactsDir: string,
  artifactType: ArtifactType,
): Promise<Array<{ meta: EvidenceArtifactMeta; relPath: string }>> {
  let files: string[];
  try {
    files = await fs.readdir(artifactsDir);
  } catch {
    return [];
  }

  const pattern = new RegExp(`^${artifactType}\\.v(\\d+)\\.json$`);
  const jsonFiles = files.filter((name) => pattern.test(name));
  const parsed: Array<{ meta: EvidenceArtifactMeta; relPath: string }> = [];

  for (const jsonFile of jsonFiles) {
    const match = pattern.exec(jsonFile);
    if (!match) continue;
    const expectedVersion = Number(match[1]);
    const expectedMarkdownPath = `${EVIDENCE_ARTIFACTS_DIR}/${artifactType}.v${expectedVersion}.md`;
    const relPath = `${EVIDENCE_ARTIFACTS_DIR}/${jsonFile}`;
    const fullPath = path.join(artifactsDir, jsonFile);
    const raw = await fs.readFile(fullPath, 'utf-8');
    const meta = parseArtifactMeta(
      raw,
      artifactType,
      relPath,
      expectedVersion,
      expectedMarkdownPath,
    );
    parsed.push({ meta, relPath });
  }

  return parsed.sort((a, b) => a.meta.version - b.meta.version);
}

function parseArtifactMeta(
  raw: string,
  expectedType: ArtifactType,
  relPath: string,
  expectedVersion: number,
  expectedMarkdownPath: string,
): EvidenceArtifactMeta {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new EvidenceArtifactError(
      'EVIDENCE_ARTIFACT_MISMATCH',
      `Artifact metadata is not valid JSON: ${relPath}`,
    );
  }

  if (!isArtifactMeta(parsed)) {
    throw new EvidenceArtifactError(
      'EVIDENCE_ARTIFACT_MISMATCH',
      `Artifact metadata has invalid shape: ${relPath}`,
    );
  }

  if (parsed.artifactType !== expectedType) {
    throw new EvidenceArtifactError(
      'EVIDENCE_ARTIFACT_MISMATCH',
      `Artifact type mismatch in ${relPath}: expected ${expectedType}, got ${parsed.artifactType}`,
    );
  }

  if (parsed.schemaVersion !== EVIDENCE_ARTIFACT_SCHEMA_VERSION) {
    throw new EvidenceArtifactError(
      'EVIDENCE_ARTIFACT_MISMATCH',
      `Artifact schema version mismatch in ${relPath}: ${parsed.schemaVersion}`,
    );
  }

  if (parsed.version !== expectedVersion) {
    throw new EvidenceArtifactError(
      'EVIDENCE_ARTIFACT_MISMATCH',
      `Artifact version mismatch in ${relPath}: expected v${expectedVersion}, got v${parsed.version}`,
    );
  }

  if (parsed.markdownPath !== expectedMarkdownPath) {
    throw new EvidenceArtifactError(
      'EVIDENCE_ARTIFACT_MISMATCH',
      `Artifact markdownPath mismatch in ${relPath}: expected ${expectedMarkdownPath}, got ${parsed.markdownPath}`,
    );
  }

  return parsed;
}

function isValidString(v: unknown): v is string {
  return typeof v === 'string';
}
function isValidNumber(v: unknown): v is number {
  return typeof v === 'number';
}
function isSha256Hex(v: unknown): boolean {
  return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
}
function isValidArtifactType(v: unknown): v is 'ticket' | 'plan' {
  return v === 'ticket' || v === 'plan';
}

function isArtifactMeta(input: unknown): input is EvidenceArtifactMeta {
  if (!input || typeof input !== 'object') return false;
  const c = input as Partial<EvidenceArtifactMeta>;
  return checkBaseArtifactFields(c) && checkHashAndDerivedFields(c);
}

function checkBaseArtifactFields(c: Partial<EvidenceArtifactMeta>): boolean {
  return (
    isValidString(c.schemaVersion) &&
    isValidArtifactType(c.artifactType) &&
    isValidNumber(c.version) &&
    c.version > 0 &&
    isValidString(c.sessionId) &&
    isValidString(c.createdAt) &&
    isValidString(c.phase)
  );
}

function checkHashAndDerivedFields(c: Partial<EvidenceArtifactMeta>): boolean {
  return (
    isSha256Hex(c.sourceStateHash) &&
    isValidString(c.contentHash) &&
    c.contentHash.length > 0 &&
    isSha256Hex(c.markdownHash) &&
    c.derivedFrom === 'session-state.json' &&
    isValidString(c.markdownPath) &&
    (c.recordDigest === undefined || isSha256Hex(c.recordDigest))
  );
}

export async function assertMarkdownIntegrity(
  artifactsDir: string,
  meta: EvidenceArtifactMeta,
  artifactType: ArtifactType,
): Promise<void> {
  const markdownRelPath = meta.markdownPath;
  const fileName = path.basename(markdownRelPath);
  const markdownPath = path.join(artifactsDir, fileName);
  const actualHash = await hashFile(markdownPath).catch((err) => {
    getAdapterLogger().warn('evidence-artifacts', 'Failed to hash evidence artifact', {
      markdownPath,
      artifactType,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  });
  if (!actualHash) {
    throw new EvidenceArtifactError(
      'EVIDENCE_ARTIFACT_MISSING',
      `${artifactType} markdown artifact is missing: ${markdownRelPath}`,
    );
  }
  if (actualHash !== meta.markdownHash) {
    throw new EvidenceArtifactError(
      'EVIDENCE_ARTIFACT_MISMATCH',
      `${artifactType} markdown artifact hash mismatch for ${markdownRelPath}`,
    );
  }
}
