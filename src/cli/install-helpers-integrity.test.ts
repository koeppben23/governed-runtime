import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { verifyTarballChecksum } from './install-helpers.js';
import { hashFile } from '../shared/hashing.js';

describe('hashFile', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-hashfile-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns 64-char hex string for binary content', async () => {
    const filePath = path.join(tmpDir, 'test.bin');
    await fs.writeFile(filePath, Buffer.from([0x1f, 0x8b, 0x08, 0x00]));
    const result = await hashFile(filePath);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for same content', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    await fs.writeFile(filePath, 'hello world');
    const a = await hashFile(filePath);
    const b = await hashFile(filePath);
    expect(a).toBe(b);
  });

  it('returns different hashes for different content', async () => {
    const fileA = path.join(tmpDir, 'a.txt');
    const fileB = path.join(tmpDir, 'b.txt');
    await fs.writeFile(fileA, 'hello');
    await fs.writeFile(fileB, 'world');
    const hashA = await hashFile(fileA);
    const hashB = await hashFile(fileB);
    expect(hashA).not.toBe(hashB);
  });

  it('hashes empty file', async () => {
    const filePath = path.join(tmpDir, 'empty.bin');
    await fs.writeFile(filePath, '');
    const result = await hashFile(filePath);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
    // Known SHA-256 of empty input
    expect(result).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

// ─── verifyTarballChecksum ────────────────────────────────────────────────────

async function writeChecksumsFile(
  dir: string,
  entries: Array<{ filename: string; hash: string }>,
): Promise<string> {
  const filePath = path.join(dir, 'checksums.sha256');
  const content = entries.map((e) => `${e.hash}  ${e.filename}`).join('\n') + '\n';
  await fs.writeFile(filePath, content);
  return filePath;
}

describe('verifyTarballChecksum', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-verify-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ─── HAPPY ──────────────────────────────────────────────────

  it('passes when tarball hash matches checksums file (text format)', async () => {
    const tarballPath = path.join(tmpDir, 'flowguard-core-1.2.0.tgz');
    await fs.writeFile(tarballPath, 'release content');
    const actualHash = await hashFile(tarballPath);
    const checksumsPath = await writeChecksumsFile(tmpDir, [
      { filename: 'flowguard-core-1.2.0.tgz', hash: actualHash },
    ]);
    await expect(verifyTarballChecksum(tarballPath, checksumsPath)).resolves.toBeUndefined();
  });

  it('passes when tarball hash matches checksums file (binary marker format)', async () => {
    const tarballPath = path.join(tmpDir, 'flowguard-core-1.2.0.tgz');
    await fs.writeFile(tarballPath, 'release content');
    const actualHash = await hashFile(tarballPath);
    const checksumsPath = path.join(tmpDir, 'checksums.sha256');
    await fs.writeFile(checksumsPath, `${actualHash} *flowguard-core-1.2.0.tgz\n`);
    await expect(verifyTarballChecksum(tarballPath, checksumsPath)).resolves.toBeUndefined();
  });

  it('matches tarball by basename regardless of path prefix in checksums file', async () => {
    const tarballPath = path.join(tmpDir, 'flowguard-core-1.2.0.tgz');
    await fs.writeFile(tarballPath, 'release content');
    const actualHash = await hashFile(tarballPath);
    const checksumsPath = await writeChecksumsFile(tmpDir, [
      { filename: `./${path.basename(tarballPath)}`, hash: actualHash },
    ]);
    await expect(verifyTarballChecksum(tarballPath, checksumsPath)).resolves.toBeUndefined();
  });

  // ─── BAD ────────────────────────────────────────────────────

  it('fails when tarball content is tampered (hash mismatch)', async () => {
    const tarballPath = path.join(tmpDir, 'flowguard-core-1.2.0.tgz');
    await fs.writeFile(tarballPath, 'original content');
    const checksumsPath = path.join(tmpDir, 'checksums.sha256');
    const wrongHash = '0'.repeat(64);
    await fs.writeFile(checksumsPath, `${wrongHash}  flowguard-core-1.2.0.tgz\n`);
    await expect(verifyTarballChecksum(tarballPath, checksumsPath)).rejects.toThrow(
      'SHA-256 mismatch',
    );
  });

  it('fails when tarball not listed in checksums file', async () => {
    const tarballPath = path.join(tmpDir, 'flowguard-core-1.2.0.tgz');
    await fs.writeFile(tarballPath, 'content');
    const checksumsPath = await writeChecksumsFile(tmpDir, [
      { filename: 'other-package.tgz', hash: '0'.repeat(64) },
    ]);
    await expect(verifyTarballChecksum(tarballPath, checksumsPath)).rejects.toThrow('not found');
  });

  it('fails when checksums file has duplicate filename entries', async () => {
    const tarballPath = path.join(tmpDir, 'flowguard-core-1.2.0.tgz');
    await fs.writeFile(tarballPath, 'content');
    const actualHash = await hashFile(tarballPath);
    const checksumsPath = path.join(tmpDir, 'checksums.sha256');
    await fs.writeFile(
      checksumsPath,
      `${actualHash}  flowguard-core-1.2.0.tgz\n${actualHash}  flowguard-core-1.2.0.tgz\n`,
    );
    await expect(verifyTarballChecksum(tarballPath, checksumsPath)).rejects.toThrow(
      'Duplicate entry',
    );
  });

  it('fails when checksums file does not exist', async () => {
    const tarballPath = path.join(tmpDir, 'flowguard-core-1.2.0.tgz');
    await fs.writeFile(tarballPath, 'content');
    const checksumsPath = path.join(tmpDir, 'nonexistent.sha256');
    await expect(verifyTarballChecksum(tarballPath, checksumsPath)).rejects.toThrow(
      'Cannot read checksums file',
    );
  });

  // ─── CORNER ─────────────────────────────────────────────────

  it('ignores malformed hash lines (not 64 hex chars)', async () => {
    const tarballPath = path.join(tmpDir, 'flowguard-core-1.2.0.tgz');
    await fs.writeFile(tarballPath, 'content');
    const actualHash = await hashFile(tarballPath);
    const checksumsPath = path.join(tmpDir, 'checksums.sha256');
    await fs.writeFile(
      checksumsPath,
      `short  flowguard-core-1.2.0.tgz\n${actualHash}  flowguard-core-1.2.0.tgz\n`,
    );
    // Two entries with same filename: one malformed (ignored), one valid (accepted)
    await expect(verifyTarballChecksum(tarballPath, checksumsPath)).resolves.toBeUndefined();
  });

  it('substring match does not falsely match', async () => {
    const tarballPath = path.join(tmpDir, 'flowguard-core-1.2.0.tgz');
    await fs.writeFile(tarballPath, 'content');
    const actualHash = await hashFile(tarballPath);
    const checksumsPath = await writeChecksumsFile(tmpDir, [
      { filename: 'flowguard-core.tgz', hash: actualHash },
    ]);
    await expect(verifyTarballChecksum(tarballPath, checksumsPath)).rejects.toThrow('not found');
  });

  it('empty checksums file fails', async () => {
    const tarballPath = path.join(tmpDir, 'flowguard-core-1.2.0.tgz');
    await fs.writeFile(tarballPath, 'content');
    const checksumsPath = path.join(tmpDir, 'checksums.sha256');
    await fs.writeFile(checksumsPath, '');
    await expect(verifyTarballChecksum(tarballPath, checksumsPath)).rejects.toThrow('not found');
  });

  it('whitespace-only checksums file fails', async () => {
    const tarballPath = path.join(tmpDir, 'flowguard-core-1.2.0.tgz');
    await fs.writeFile(tarballPath, 'content');
    const checksumsPath = path.join(tmpDir, 'checksums.sha256');
    await fs.writeFile(checksumsPath, '  \n  \n  ');
    await expect(verifyTarballChecksum(tarballPath, checksumsPath)).rejects.toThrow('not found');
  });

  it('case-insensitive hash comparison', async () => {
    const tarballPath = path.join(tmpDir, 'flowguard-core-1.2.0.tgz');
    await fs.writeFile(tarballPath, 'content');
    const actualHash = await hashFile(tarballPath);
    const upperHash = actualHash.toUpperCase();
    const checksumsPath = path.join(tmpDir, 'checksums.sha256');
    await fs.writeFile(checksumsPath, `${upperHash}  flowguard-core-1.2.0.tgz\n`);
    await expect(verifyTarballChecksum(tarballPath, checksumsPath)).resolves.toBeUndefined();
  });
});
