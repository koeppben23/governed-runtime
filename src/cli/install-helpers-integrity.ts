/**
 * @module cli/install-helpers-integrity
 * @description Tarball integrity verification for the FlowGuard CLI installer.
 *
 * Split from install-helpers.ts following the file-size budget; behavior is
 * unchanged.
 *
 * @version v1
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { hashFile } from '../shared/hashing.js';
import { InstallError } from './install-recovery.js';

// ---- Tarball Integrity Verification ----

const SHA256_HEX_RE = /^[0-9a-fA-F]{64}$/;
const CHECKSUM_LINE_RE = /^([0-9a-fA-F]{64})\s+[*]?\s*(.+)$/;

function safeHashHexEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

interface ParsedChecksumEntry {
  readonly hashHex: string;
  readonly filename: string;
}

function parseChecksumEntry(line: string): ParsedChecksumEntry | null {
  const match = CHECKSUM_LINE_RE.exec(line);
  if (!match) return null;
  const hashHex = match[1];
  const filename = match[2];
  if (hashHex === undefined || filename === undefined) return null;
  if (!SHA256_HEX_RE.test(hashHex)) return null;
  return { hashHex, filename };
}

export async function verifyTarballChecksum(
  tarballPath: string,
  checksumsFilePath: string,
): Promise<void> {
  const tarballName = basename(tarballPath);

  let content: string;
  try {
    content = readFileSync(checksumsFilePath, 'utf-8');
  } catch (err) {
    throw new InstallError(
      'TARBALL_CHECKSUMS_UNREADABLE',
      `Cannot read checksums file: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const lines = content.split('\n');
  let matchedHash: string | undefined;

  for (const line of lines) {
    const entry = parseChecksumEntry(line.trim());
    if (entry === null) continue;

    if (basename(entry.filename) === tarballName) {
      if (matchedHash !== undefined) {
        throw new InstallError(
          'TARBALL_DUPLICATE_ENTRY',
          `Duplicate entry for "${tarballName}" in checksums file. ` +
            `Ambiguous integrity verification is denied.`,
        );
      }
      matchedHash = entry.hashHex.toLowerCase();
    }
  }

  if (matchedHash === undefined) {
    throw new InstallError(
      'TARBALL_NOT_FOUND',
      `Tarball "${tarballName}" not found in checksums file "${checksumsFilePath}".`,
    );
  }

  const expectedHash = matchedHash;
  const actualHash = await hashFile(tarballPath);

  if (!safeHashHexEqual(actualHash, expectedHash)) {
    throw new InstallError(
      'TARBALL_SHA256_MISMATCH',
      `Tarball SHA-256 mismatch.\n` +
        `  Expected: ${expectedHash}\n` +
        `  Actual:   ${actualHash}\n` +
        `  The tarball may be corrupted or tampered.`,
    );
  }
}
