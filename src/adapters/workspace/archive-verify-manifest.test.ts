import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { hashBuffer } from '../../shared/hashing.js';
import type { ArchiveFinding, ArchiveManifest } from '../../archive/types.js';
import { checkUnexpectedFiles, verifyManifestFiles } from './archive-verify-manifest.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function createSession(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-manifest-'));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  await Promise.all(
    Object.entries(files).map(async ([file, content]) => {
      const fullPath = path.join(root, file);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content, 'utf8');
    }),
  );
  return root;
}

function manifest(files: Record<string, string>): ArchiveManifest {
  return {
    schemaVersion: 'archive-manifest.v2',
    layoutVersion: 2,
    createdAt: '2026-01-01T00:00:00.000Z',
    sessionId: 'session',
    fingerprint: 'a'.repeat(64),
    policyMode: 'regulated',
    profileId: 'default',
    discoveryDigest: null,
    auditChainHead: 'genesis',
    auditEventCount: 0,
    includedFiles: Object.keys(files),
    fileDigests: Object.fromEntries(
      Object.entries(files).map(([file, content]) => [file, hashBuffer(Buffer.from(content))]),
    ),
    contentDigest: 'digest',
  };
}

describe('archive manifest payload verification', () => {
  it('reports every missing declared file and digest mismatch', async () => {
    const root = await createSession({ 'present.txt': 'changed' });
    const findings: ArchiveFinding[] = [];
    await verifyManifestFiles(
      root,
      manifest({ 'present.txt': 'original', 'missing.txt': 'missing' }),
      findings,
    );

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'file_digest_mismatch', file: 'present.txt' }),
        expect.objectContaining({ code: 'missing_file', file: 'missing.txt' }),
      ]),
    );
  });

  it('rejects undeclared regular files and non-regular filesystem entries', async () => {
    const root = await createSession({ 'declared.txt': 'declared', 'extra.txt': 'extra' });
    await fs.symlink('declared.txt', path.join(root, 'linked.txt'));
    const findings: ArchiveFinding[] = [];
    await checkUnexpectedFiles(root, manifest({ 'declared.txt': 'declared' }), findings);

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'unexpected_file', file: 'extra.txt', severity: 'error' }),
        expect.objectContaining({ code: 'unexpected_file', file: 'linked.txt', severity: 'error' }),
      ]),
    );
  });

  it('fails closed with an inconclusive inventory finding when the payload cannot be read', async () => {
    const root = await createSession({ 'not-a-directory': 'content' });
    const findings: ArchiveFinding[] = [];

    await checkUnexpectedFiles(path.join(root, 'not-a-directory'), manifest({}), findings);

    expect(findings).toEqual([
      expect.objectContaining({ code: 'archive_inventory_inconclusive', severity: 'error' }),
    ]);
  });
});
