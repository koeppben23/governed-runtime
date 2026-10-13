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

/**
 * Read and shape-check the `.sha256` sidecar.
 *
 * This is the single sidecar parser: the archive verification stage and the
 * verified-export reader both consume it, so a malformed sidecar has exactly
 * one interpretation. The reader never treats a missing or malformed sidecar
 * as a valid digest — callers decide the severity for their trust boundary.
 */
export type ArchiveSidecarRead =
  | { readonly kind: 'ok'; readonly digest: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'unreadable'; readonly message: string };

export async function readArchiveSidecarDigest(
  checksumSidecarPath: string,
): Promise<ArchiveSidecarRead> {
  if (!(await fileExists(checksumSidecarPath))) return { kind: 'missing' };

  let sidecarContent: string;
  try {
    sidecarContent = await fs.readFile(checksumSidecarPath, 'utf-8');
  } catch (error) {
    return {
      kind: 'unreadable',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const sidecarTokens = sidecarContent.trim().split(/\s+/).filter(Boolean);
  const expectedHash = sidecarTokens[0];
  if (!expectedHash || isMalformedChecksumSidecar(expectedHash, sidecarTokens)) {
    return { kind: 'malformed' };
  }

  return { kind: 'ok', digest: expectedHash };
}

export async function verifyArchiveChecksum(
  archiveTarPath: string,
  checksumSidecarPath: string,
  strict: boolean,
  findings: ArchiveFinding[],
): Promise<void> {
  const sidecar = await readArchiveSidecarDigest(checksumSidecarPath);
  if (sidecar.kind === 'missing') {
    findings.push({
      code: 'archive_checksum_missing',
      severity: strict ? 'error' : 'warning',
      message: 'Archive checksum sidecar (.sha256) not found',
    });
    return;
  }
  if (sidecar.kind === 'unreadable') {
    addArchiveChecksumMismatch(
      findings,
      `Archive checksum sidecar is unreadable; archive checksum could not be verified: ${sidecar.message}`,
    );
    return;
  }
  if (sidecar.kind === 'malformed') {
    addArchiveChecksumMismatch(
      findings,
      'Archive checksum sidecar is malformed or ambiguous; expected exactly one SHA-256 digest',
    );
    return;
  }

  const expectedHash = sidecar.digest;
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
