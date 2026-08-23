import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { timestampFindingCode } from './archive-verify-helpers.js';
import { snapshotArchive } from './archive-files.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('timestampFindingCode', () => {
  it('maps TSA imprint/token failures to tsa_verification_failed', () => {
    expect(timestampFindingCode('TSA_MESSAGE_IMPRINT_MISMATCH')).toBe('tsa_verification_failed');
    expect(timestampFindingCode('TOKEN_VERIFICATION_REQUIRED')).toBe('tsa_verification_failed');
  });

  it('AC2: maps downgraded evidence to its own diagnostic code', () => {
    expect(timestampFindingCode('TSA_EVIDENCE_DOWNGRADED')).toBe('tsa_evidence_downgraded');
  });

  it('maps other timestamp failures to timestamp_unanchored', () => {
    expect(timestampFindingCode('TIMESTAMP_NON_MONOTONIC')).toBe('timestamp_unanchored');
    expect(timestampFindingCode('TIMESTAMP_EVIDENCE_MISSING')).toBe('timestamp_unanchored');
  });
});

describe('snapshotArchive', () => {
  it('preserves inspected archive bytes when the source path is later replaced', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-snapshot-'));
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const source = path.join(root, 'source.tar.gz');
    const snapshot = path.join(root, 'snapshot.tar.gz');
    await fs.writeFile(source, 'verified archive bytes', 'utf8');

    await snapshotArchive(source, snapshot);
    await fs.writeFile(source, 'replaced archive bytes', 'utf8');

    await expect(fs.readFile(snapshot, 'utf8')).resolves.toBe('verified archive bytes');
    await expect(fs.readFile(source, 'utf8')).resolves.toBe('replaced archive bytes');
  });
});
