/**
 * @module adapters/workspace/evidence-artifact-core
 * @description Shared evidence-artifact primitives: schema constants, metadata
 * shape, typed errors, artifact path derivation, and immutable write helpers.
 *
 * @version v1
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SessionState } from '../../state/schema.js';
import { atomicWrite } from '../persistence.js';

export const EVIDENCE_ARTIFACT_SCHEMA_VERSION = 'flowguard-evidence-artifact.v1';
export const EVIDENCE_ARTIFACTS_DIR = 'artifacts';

export type ArtifactType =
  'ticket' | 'plan' | 'plan-review-card' | 'review-report-card' | 'architecture-review-card';

export interface EvidenceArtifactMeta {
  readonly schemaVersion: typeof EVIDENCE_ARTIFACT_SCHEMA_VERSION;
  readonly artifactType: ArtifactType;
  readonly version: number;
  readonly sessionId: string;
  readonly createdAt: string;
  readonly phase: SessionState['phase'];
  readonly sourceStateHash: string;
  readonly contentHash: string;
  readonly markdownHash: string;
  readonly derivedFrom: 'session-state.json';
  readonly markdownPath: string;
  /**
   * Plan revision lineage identity (`PlanEvidence.recordDigest`). Artifact
   * identity is this lineage digest — never content equality. A session may
   * traverse several plan lineages (e.g. a rejected evidence review restarts
   * from the ticket), so the flat append-only artifact chain can contain
   * revisions that share `planVersion`, body, or timestamp. Absent on
   * ticket artifacts and on artifacts materialized before revision identity
   * existed; such historical entries are never used as identity for a current
   * revision.
   */
  readonly recordDigest?: string;
}

export interface ArtifactFile {
  readonly markdownRelPath: string;
  readonly jsonRelPath: string;
  readonly markdownAbsPath: string;
  readonly jsonAbsPath: string;
}

/**
 * Typed evidence artifact error codes.
 * Compile-time validated — no arbitrary strings allowed.
 */
export type EvidenceArtifactErrorCode =
  'EVIDENCE_ARTIFACT_MISSING' | 'EVIDENCE_ARTIFACT_MISMATCH' | 'EVIDENCE_ARTIFACT_IMMUTABLE';

export class EvidenceArtifactError extends Error {
  readonly code: EvidenceArtifactErrorCode;

  constructor(code: EvidenceArtifactErrorCode, message: string) {
    super(message);
    this.name = 'EvidenceArtifactError';
    this.code = code;
  }
}

export function artifactFile(
  artifactsDir: string,
  artifactType: ArtifactType,
  version: number,
): ArtifactFile {
  const base = `${artifactType}.v${version}`;
  const markdownRelPath = `${EVIDENCE_ARTIFACTS_DIR}/${base}.md`;
  const jsonRelPath = `${EVIDENCE_ARTIFACTS_DIR}/${base}.json`;
  return {
    markdownRelPath,
    jsonRelPath,
    markdownAbsPath: path.join(artifactsDir, `${base}.md`),
    jsonAbsPath: path.join(artifactsDir, `${base}.json`),
  };
}

export async function writeImmutableFile(
  filePath: string,
  content: string,
  createdPaths: string[],
): Promise<void> {
  try {
    const current = await fs.readFile(filePath, 'utf-8');
    if (current === content) return;
    throw new EvidenceArtifactError(
      'EVIDENCE_ARTIFACT_IMMUTABLE',
      `Refusing to overwrite immutable artifact: ${filePath}`,
    );
  } catch (err) {
    if (isNotFound(err)) {
      await atomicWrite(filePath, content);
      createdPaths.push(filePath);
      return;
    }
    throw err;
  }
}

export async function cleanupCreatedArtifacts(createdPaths: string[]): Promise<void> {
  for (let i = createdPaths.length - 1; i >= 0; i -= 1) {
    const filePath = createdPaths[i];
    if (filePath === undefined) continue;
    try {
      await fs.unlink(filePath);
    } catch {
      /* best effort cleanup */
    }
  }
}

export function isNotFound(err: unknown): boolean {
  return Boolean(
    err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === 'ENOENT',
  );
}
