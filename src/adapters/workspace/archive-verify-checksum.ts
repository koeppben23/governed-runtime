/**
 * @module adapters/workspace/archive-verify-checksum
 * @description Archive tarball checksum verification stage: reads the `.sha256`
 * sidecar, validates its shape, and compares it with the tarball's SHA-256.
 *
 * @version v1
 */

import * as fs from 'node:fs/promises';
import { hashBuffer } from '../../shared/hashing.js';
import { type ArchiveFinding } from '../../archive/types.js';
import { fileExists } from './archive-files.js';

function isMalformedChecksumSidecar(expectedHash: string, tokens: string[]): boolean {
  const digestTokens = tokens.filter((token) => /^[a-f0-9]{64}$/i.test(token));
  return !/^[a-f0-9]{64}$/i.test(expectedHash) || digestTokens.length !== 1;
}

function readFailureCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
}

function archiveReadFailureReason(error: unknown): string {
  const code = readFailureCode(error);
  return code === 'ENOENT' ? 'Archive tarball is missing' : 'Archive tarball is unreadable';
}

function addArchiveChecksumMismatch(findings: ArchiveFinding[], message: string): void {
  findings.push({
    code: 'archive_checksum_mismatch',
    severity: 'error',
    message,
  });
}

export async function verifyArchiveChecksum(
  archiveTarPath: string,
  checksumSidecarPath: string,
  strict: boolean,
  findings: ArchiveFinding[],
): Promise<void> {
  const checksumExists = await fileExists(checksumSidecarPath);
  if (!checksumExists) {
    findings.push({
      code: 'archive_checksum_missing',
      severity: strict ? 'error' : 'warning',
      message: 'Archive checksum sidecar (.sha256) not found',
    });
    return;
  }

  let sidecarContent: string;
  try {
    sidecarContent = await fs.readFile(checksumSidecarPath, 'utf-8');
  } catch (error) {
    addArchiveChecksumMismatch(
      findings,
      `Archive checksum sidecar is unreadable; archive checksum could not be verified: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }

  const sidecarTokens = sidecarContent.trim().split(/\s+/).filter(Boolean);
  const expectedHash = sidecarTokens[0];
  if (!expectedHash || isMalformedChecksumSidecar(expectedHash, sidecarTokens)) {
    addArchiveChecksumMismatch(
      findings,
      'Archive checksum sidecar is malformed or ambiguous; expected exactly one SHA-256 digest',
    );
    return;
  }

  try {
    const archiveBuffer = await fs.readFile(archiveTarPath);
    const actualHash = hashBuffer(archiveBuffer);
    if (expectedHash !== actualHash) {
      addArchiveChecksumMismatch(
        findings,
        `Archive checksum mismatch: sidecar says ${expectedHash.slice(0, 12)}..., actual is ${actualHash.slice(0, 12)}...`,
      );
    }
  } catch (error) {
    addArchiveChecksumMismatch(
      findings,
      `${archiveReadFailureReason(error)}; archive checksum could not be verified: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
