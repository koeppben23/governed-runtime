/**
 * @module adapters/workspace/archive-verify-artifact-binding
 * @description Artifact-binding verification stage: every archive evidence
 * artifact must be bound into the audit chain, and both the file bytes and the
 * manifest digest must match that binding.
 *
 * @version v1
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { hashBuffer } from '../../shared/hashing.js';
import { type ArchiveManifest, type ArchiveFinding } from '../../archive/types.js';
import { findBindingArtifacts, isArtifactBindingEntry } from './archive-verify-helpers.js';
import { type ArtifactBindingEntry } from './archive-artifact-binding.js';

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

export async function verifyArtifactBinding(
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
