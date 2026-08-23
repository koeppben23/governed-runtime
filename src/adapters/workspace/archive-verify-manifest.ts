/**
 * @module workspace/archive-verify-manifest
 * @description File-inventory and digest verification only.
 *
 * Verifies every manifest-listed file exists and matches its declared SHA-256
 * digest. Detects unexpected files in the session directory. Does NOT verify
 * audit chain, timestamps, content digest, or archive checksums — those are
 * owned by archive-verify-chain.ts.
 *
 * @version v1
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { hashBuffer } from '../../shared/hashing.js';
import {
  ArchiveManifestSchema,
  type ArchiveManifest,
  type ArchiveFinding,
} from '../../archive/types.js';
import { fileExists } from './archive-files.js';

export async function loadArchiveManifest(
  sessDir: string,
  findings: ArchiveFinding[],
): Promise<ArchiveManifest | null> {
  const manifestPath = path.join(sessDir, 'archive-manifest.json');
  let manifestRaw: string;
  try {
    manifestRaw = await fs.readFile(manifestPath, 'utf-8');
  } catch {
    findings.push({
      code: 'missing_manifest',
      severity: 'error',
      message: 'Archive manifest not found in session directory',
      file: 'archive-manifest.json',
    });
    return null;
  }

  try {
    const parsed = JSON.parse(manifestRaw);
    const result = ArchiveManifestSchema.safeParse(parsed);
    if (!result.success) {
      findings.push({
        code: 'manifest_parse_error',
        severity: 'error',
        message: `Manifest schema validation failed: ${result.error.message}`,
        file: 'archive-manifest.json',
      });
      return null;
    }
    return result.data;
  } catch {
    findings.push({
      code: 'manifest_parse_error',
      severity: 'error',
      message: 'Manifest is not valid JSON',
      file: 'archive-manifest.json',
    });
    return null;
  }
}

export async function verifyManifestFiles(
  sessDir: string,
  manifest: ArchiveManifest,
  findings: ArchiveFinding[],
): Promise<void> {
  for (const relPath of manifest.includedFiles) {
    const fullPath = path.join(sessDir, relPath);
    const exists = await fileExists(fullPath);
    if (!exists) {
      findings.push({
        code: 'missing_file',
        severity: 'error',
        message: `File listed in manifest is missing: ${relPath}`,
        file: relPath,
      });
      continue;
    }

    const expectedDigest = manifest.fileDigests[relPath];
    if (expectedDigest) {
      const content = await fs.readFile(fullPath);
      const actualDigest = hashBuffer(content);
      if (actualDigest !== expectedDigest) {
        findings.push({
          code: 'file_digest_mismatch',
          severity: 'error',
          message: `File digest mismatch for ${relPath}: expected ${expectedDigest.slice(0, 12)}..., got ${actualDigest.slice(0, 12)}...`,
          file: relPath,
        });
      }
    }
  }
}

export async function checkUnexpectedFiles(
  sessDir: string,
  manifest: ArchiveManifest,
  findings: ArchiveFinding[],
): Promise<void> {
  const manifestFileSet = new Set(manifest.includedFiles);
  try {
    await walkArchiveFiles(sessDir, '', (file, regular) => {
      if (!regular || !manifestFileSet.has(file)) {
        findings.push({
          code: 'unexpected_file',
          severity: 'error',
          message: regular
            ? `File not listed in manifest: ${file}`
            : `Archive contains non-regular filesystem entry: ${file}`,
          file,
        });
      }
    });
  } catch (error) {
    findings.push({
      code: 'unexpected_file',
      severity: 'error',
      message: `Archive payload inventory could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }
}

async function walkArchiveFiles(
  dir: string,
  prefix: string,
  visit: (file: string, regular: boolean) => void,
): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await walkArchiveFiles(path.join(dir, entry.name), relPath, visit);
    } else if (entry.name !== 'archive-manifest.json') {
      visit(relPath, entry.isFile());
    }
  }
}
