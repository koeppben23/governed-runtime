/**
 * @module adapters/workspace/archive-verify-integrity-mutation.test
 * @description Mutation-focused contract tests for the archive integrity
 * orchestration stage: content-digest match/mismatch/throw-closed behavior and
 * the fail-closed strictness finding for an unresolved policy state.
 *
 * @test-policy HAPPY, BAD, CORNER
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ArchiveFinding, ArchiveManifest } from '../../archive/types.js';
import { computeArchiveContentDigest } from '../../archive/content-digest.js';
import { hashBuffer } from '../../shared/hashing.js';
import { makeState } from '../../fixtures.js';
import type { SessionState } from '../../state/schema.js';
import { verifyArchiveIntegrity } from './archive-verify-integrity.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function baseManifest(): ArchiveManifest {
  return {
    schemaVersion: 'archive-manifest.v3',
    layoutVersion: 2,
    createdAt: '2026-01-01T00:00:00.000Z',
    sessionId: 'session-1',
    fingerprint: 'a'.repeat(64),
    policyMode: 'team',
    profileId: 'default',
    discoveryDigest: null,
    auditChainHead: 'genesis',
    auditEventCount: 0,
    includedFiles: ['state/session-state.json'],
    fileDigests: { 'state/session-state.json': 'c'.repeat(64) },
    contentDigest: 'placeholder',
  };
}

function computedContentDigest(manifest: ArchiveManifest): string {
  return computeArchiveContentDigest({
    includedFiles: manifest.includedFiles,
    fileDigests: manifest.fileDigests,
    policyMode: manifest.policyMode,
    auditChainHead: manifest.auditChainHead,
    auditEventCount: manifest.auditEventCount,
    schemaVersion: manifest.schemaVersion,
    layoutVersion: manifest.layoutVersion,
    sessionId: manifest.sessionId,
    fingerprint: manifest.fingerprint,
    discoveryDigest: manifest.discoveryDigest,
  });
}

async function runIntegrity(
  manifest: ArchiveManifest,
  state: SessionState | null,
): Promise<ArchiveFinding[]> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-integrity-'));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const snapshotPath = path.join(root, 'archive.tar.gz');
  const archiveBytes = Buffer.from('archive snapshot bytes');
  await fs.writeFile(snapshotPath, archiveBytes);
  const checksumSidecarPath = `${snapshotPath}.sha256`;
  await fs.writeFile(checksumSidecarPath, `${hashBuffer(archiveBytes)}  archive.tar.gz\n`, 'utf8');

  const findings: ArchiveFinding[] = [];
  await verifyArchiveIntegrity(
    { sessDir: root, fingerprint: 'a'.repeat(64), validSessionId: 'session-1' },
    manifest,
    findings,
    state,
    { snapshotPath, archivePath: path.join(root, 'archive.tar.gz'), checksumSidecarPath },
  );
  return findings;
}

function contentDigestFindings(findings: ArchiveFinding[]): ArchiveFinding[] {
  return findings.filter((finding) => finding.code === 'content_digest_mismatch');
}

describe('verifyArchiveIntegrity content digest binding', () => {
  it('accepts a manifest whose content digest matches the computed digest', async () => {
    const manifest = baseManifest();
    manifest.contentDigest = computedContentDigest(manifest);

    const findings = await runIntegrity(manifest, makeState('COMPLETE'));

    expect(contentDigestFindings(findings)).toEqual([]);
  });

  it('fails closed when the manifest content digest disagrees with the computed digest', async () => {
    const manifest = baseManifest();
    manifest.contentDigest = 'b'.repeat(64);

    const findings = await runIntegrity(manifest, makeState('COMPLETE'));

    expect(contentDigestFindings(findings)).toEqual([
      {
        code: 'content_digest_mismatch',
        severity: 'error',
        message:
          'Content digest does not match computed value from file digests and integrity header',
      },
    ]);
  });

  it('fails closed when the content digest cannot be computed from the manifest', async () => {
    const manifest = baseManifest();
    manifest.includedFiles = ['state/session-state.json', 'missing/missing.txt'];
    manifest.contentDigest = 'b'.repeat(64);

    const findings = await runIntegrity(manifest, makeState('COMPLETE'));

    expect(contentDigestFindings(findings)).toEqual([
      {
        code: 'content_digest_mismatch',
        severity: 'error',
        message:
          "Content digest could not be computed: Missing file digest for included archive file 'missing/missing.txt'",
      },
    ]);
  });
});

describe('verifyArchiveIntegrity strictness resolution', () => {
  it('flags an unresolved policy state and fails closed', async () => {
    const manifest = baseManifest();
    manifest.contentDigest = computedContentDigest(manifest);

    const findings = await runIntegrity(manifest, null);

    expect(findings).toContainEqual({
      code: 'policy_state_unresolved',
      severity: 'error',
      message:
        'Trusted policy state is unavailable; archive verification is running in fail-closed strict mode',
      file: 'state/session-state.json',
    });
  });
});
