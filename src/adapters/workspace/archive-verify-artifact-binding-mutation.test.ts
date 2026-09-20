/**
 * @module adapters/workspace/archive-verify-artifact-binding-mutation.test
 * @description Mutation-focused contract tests for the archive artifact-binding
 * verification stage: audit-bound artifacts missing from the manifest, manifest
 * digest gaps for bound paths, and the empty-manifest/no-binding-event branches.
 *
 * @test-policy HAPPY, BAD, CORNER
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ArchiveFinding, ArchiveManifest } from '../../archive/types.js';
import { verifyArtifactBinding } from './archive-verify-artifact-binding.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const AT = '2026-01-01T00:00:00.000Z';

async function createRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-binding-'));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function manifest(overrides: Partial<ArchiveManifest> = {}): ArchiveManifest {
  return {
    schemaVersion: 'archive-manifest.v3',
    layoutVersion: 2,
    createdAt: AT,
    sessionId: 'session-1',
    fingerprint: 'a'.repeat(24),
    policyMode: 'team',
    profileId: 'default',
    discoveryDigest: null,
    auditChainHead: 'genesis',
    auditEventCount: 0,
    includedFiles: [],
    fileDigests: {},
    contentDigest: 'a'.repeat(64),
    ...overrides,
  };
}

function bindingEvent(artifacts: unknown[]): Record<string, unknown> {
  return {
    event: 'archive:artifacts_bound',
    detail: { schemaVersion: 'flowguard-archive-artifact-binding.v1', artifacts },
  };
}

describe('verifyArtifactBinding manifest cross-checks', () => {
  it('reports an audit-bound artifact that the manifest never listed', async () => {
    const root = await createRoot();
    const findings: ArchiveFinding[] = [];

    await verifyArtifactBinding(
      root,
      manifest({ includedFiles: ['state/session-state.json'] }),
      [
        bindingEvent([
          { path: 'artifacts/ghost.json', sha256: 'b'.repeat(64), artifactType: null },
        ]),
      ],
      findings,
    );

    expect(findings).toEqual([
      {
        code: 'artifact_binding_mismatch',
        severity: 'error',
        message:
          'Audit-bound evidence artifact is missing from archive manifest: artifacts/ghost.json',
        file: 'artifacts/ghost.json',
      },
    ]);
  });

  it('reports a bound artifact that the manifest lists without a digest entry', async () => {
    const root = await createRoot();
    await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
    await fs.writeFile(path.join(root, 'artifacts/bound.json'), 'bound bytes', 'utf8');
    const findings: ArchiveFinding[] = [];

    await verifyArtifactBinding(
      root,
      manifest({ includedFiles: ['artifacts/bound.json'], fileDigests: {} }),
      [
        bindingEvent([
          { path: 'artifacts/bound.json', sha256: 'b'.repeat(64), artifactType: null },
        ]),
      ],
      findings,
    );

    expect(findings).toContainEqual({
      code: 'artifact_binding_mismatch',
      severity: 'error',
      message:
        'Audit-bound evidence artifact is missing from archive manifest: artifacts/bound.json',
      file: 'artifacts/bound.json',
    });
  });
});

describe('verifyArtifactBinding binding-event presence', () => {
  it('fails closed when the manifest lists artifacts but the audit chain has no binding event', async () => {
    const root = await createRoot();
    const findings: ArchiveFinding[] = [];

    await verifyArtifactBinding(
      root,
      manifest({ includedFiles: ['artifacts/listed.json'] }),
      [],
      findings,
    );

    expect(findings).toEqual([
      {
        code: 'artifact_binding_missing',
        severity: 'error',
        message:
          'Archive contains evidence artifacts but no valid audit-chain artifact binding event',
        file: 'audit.jsonl',
      },
    ]);
  });

  it('accepts an artifact-free manifest with no binding event at all', async () => {
    const root = await createRoot();
    const findings: ArchiveFinding[] = [];

    await verifyArtifactBinding(root, manifest(), [], findings);

    expect(findings).toEqual([]);
  });

  it('treats a binding event with the wrong schema version as absent', async () => {
    const root = await createRoot();
    const findings: ArchiveFinding[] = [];

    await verifyArtifactBinding(
      root,
      manifest(),
      [{ event: 'archive:artifacts_bound', detail: { schemaVersion: 'v0', artifacts: [] } }],
      findings,
    );

    expect(findings).toEqual([]);
  });
});
