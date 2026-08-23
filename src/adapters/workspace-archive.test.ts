import { afterEach, describe, expect, it } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { archiveSession, initWorkspace, verifyArchive } from './workspace/index.js';
import { archiveRegulatedEvidence } from './workspace/archive.js';
import { verifyRegulatedArchive } from './workspace/archive-verify-chain.js';
import { writeState } from './persistence.js';
import { appendAuditEvent, readAuditTrail } from './persistence-audit.js';
import { makeState, REGULATED_POLICY_SNAPSHOT } from '../fixtures.js';
import { withTestEnv } from '../integration/test-helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function createArchive() {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-v2-'));
  const restore = withTestEnv({ OPENCODE_CONFIG_DIR: configDir });
  cleanups.push(async () => {
    restore();
    await fs.rm(configDir, { recursive: true, force: true });
  });
  const sessionId = '550e8400-e29b-41d4-a716-446655440000';
  const worktree = path.resolve('.');
  const initialized = await initWorkspace(worktree, sessionId);
  await writeState(initialized.sessionDir, makeState('COMPLETE'));

  // Write config to both global and repo-scoped locations.
  const configBody = {
    schemaVersion: 'v1' as const,
    archive: { redaction: { allowedModes: ['none'] as const, allowRawExport: true } },
  };
  await fs.writeFile(path.join(configDir, 'flowguard.json'), JSON.stringify(configBody), 'utf8');
  const repoOpenCode = path.join(worktree, '.opencode');
  await fs.mkdir(repoOpenCode, { recursive: true });
  await fs.writeFile(path.join(repoOpenCode, 'flowguard.json'), JSON.stringify(configBody), 'utf8');
  cleanups.push(async () => {
    await fs.rm(path.join(repoOpenCode, 'flowguard.json'), { force: true });
  });

  const archivePath = await archiveSession(initialized.fingerprint, sessionId, {
    redactionMode: 'none',
    includeRaw: true,
  });
  return { ...initialized, sessionId, archivePath };
}

async function writeConfigForTest(
  configDir: string,
  redactionMode: string,
  allowRawExport: boolean,
  worktree?: string,
): Promise<void> {
  const config = {
    schemaVersion: 'v1',
    archive: {
      redaction: {
        allowedModes: [redactionMode],
        allowRawExport,
      },
    },
  };
  // Write global config
  await fs.writeFile(path.join(configDir, 'flowguard.json'), JSON.stringify(config), 'utf8');
  // Also write repo-scoped config (takes priority over global)
  if (worktree) {
    const repoDir = path.join(worktree, '.opencode');
    await fs.mkdir(repoDir, { recursive: true });
    await fs.writeFile(path.join(repoDir, 'flowguard.json'), JSON.stringify(config), 'utf8');
  }
}

async function extract(archivePath: string): Promise<string> {
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-v2-extract-'));
  cleanups.push(async () => fs.rm(destination, { recursive: true, force: true }));
  await promisify(execFile)('tar', ['xzf', archivePath, '-C', destination]);
  return destination;
}

async function appendCompletionAuditEvent(sessDir: string, sessionId: string): Promise<void> {
  await appendAuditEvent(sessDir, {
    id: crypto.randomUUID(),
    sessionId,
    phase: 'COMPLETE',
    event: 'lifecycle:session_completed',
    timestamp: '2026-01-01T00:00:00.000Z',
    actor: 'machine',
    detail: { action: 'session_completed' },
  });
}

describe('Archive Layout v2', () => {
  it('exports complete canonical evidence into the structured archive tree', async () => {
    const { archivePath, sessionId } = await createArchive();
    const root = path.join(await extract(archivePath), sessionId);
    const manifest = JSON.parse(
      await fs.readFile(path.join(root, 'archive-manifest.json'), 'utf8'),
    );
    expect(manifest.layoutVersion).toBe(2);
    expect(manifest.rawIncluded).toBe(true);
    expect(manifest.includedFiles).toContain('state/session-state.json');
    // Decision receipts are only written when decision events exist.
    // This test does not append any audit events, so receipts are skipped.
    await expect(fs.access(path.join(root, 'state/session-state.json'))).resolves.toBeUndefined();
  });

  it('packs only manifest-declared regular files', async () => {
    const { archivePath, sessionId } = await createArchive();
    const { stdout: manifestRaw } = await promisify(execFile)('tar', [
      'xOf',
      archivePath,
      `${sessionId}/archive-manifest.json`,
    ]);
    const manifest = JSON.parse(manifestRaw) as { includedFiles: string[] };
    const expectedMembers = [
      ...manifest.includedFiles.map((file) => `${sessionId}/${file}`),
      `${sessionId}/archive-manifest.json`,
    ];
    const { stdout: names } = await promisify(execFile)('tar', ['tzf', archivePath]);
    const { stdout: details } = await promisify(execFile)('tar', ['tvzf', archivePath]);

    expect(names.split(/\r?\n/).filter(Boolean)).toEqual(expectedMembers);
    const detailLines = details.split(/\r?\n/).filter(Boolean);
    expect(detailLines).toHaveLength(expectedMembers.length);
    expect(detailLines.every((detail) => detail.startsWith('-'))).toBe(true);
  });

  it('projects canonical decision events into decision receipts', async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-v2-'));
    const restore = withTestEnv({ OPENCODE_CONFIG_DIR: configDir });
    cleanups.push(async () => {
      restore();
      await fs.rm(configDir, { recursive: true, force: true });
    });
    // Write config with raw export enabled.
    await fs.writeFile(
      path.join(configDir, 'flowguard.json'),
      JSON.stringify({
        schemaVersion: 'v1',
        archive: { redaction: { allowedModes: ['none'], allowRawExport: true } },
      }),
      'utf8',
    );
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const initialized = await initWorkspace(path.resolve('.'), sessionId);
    await writeState(initialized.sessionDir, makeState('COMPLETE'));
    await appendAuditEvent(initialized.sessionDir, {
      id: '11111111-1111-4111-8111-111111111111',
      sessionId,
      phase: 'PLAN_REVIEW',
      event: 'decision:DEC-ARCHIVE-001',
      timestamp: '2026-01-01T00:00:00.000Z',
      actor: 'human',
      detail: {
        kind: 'decision',
        decisionId: 'DEC-ARCHIVE-001',
        decisionSequence: 1,
        gatePhase: 'PLAN_REVIEW',
        verdict: 'approve',
        rationale: 'Approved for archive projection test.',
        decidedBy: 'reviewer-1',
        decidedAt: '2026-01-01T00:00:00.000Z',
        fromPhase: 'PLAN_REVIEW',
        toPhase: 'VALIDATION',
        transitionEvent: 'APPROVE',
        policyMode: 'team',
      },
    });

    const archivePath = await archiveSession(initialized.fingerprint, sessionId, {
      redactionMode: 'none',
      includeRaw: true,
    });
    const root = path.join(await extract(archivePath), sessionId);
    const receipts = JSON.parse(
      await fs.readFile(path.join(root, 'audit', 'decision-receipts.v1.json'), 'utf8'),
    );

    expect(receipts.count).toBe(1);
    expect(receipts.receipts).toEqual([
      expect.objectContaining({
        decisionId: 'DEC-ARCHIVE-001',
        gatePhase: 'PLAN_REVIEW',
        verdict: 'approve',
        decidedBy: 'reviewer-1',
        transitionEvent: 'APPROVE',
      }),
    ]);
  });

  it.each([
    { mode: 'basic' as const, includeRaw: false },
    { mode: 'pseudonymous' as const, includeRaw: true },
  ])('creates archive with redaction $mode includeRaw=$includeRaw', async (redaction) => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-v2-'));
    const restore = withTestEnv({ OPENCODE_CONFIG_DIR: configDir });
    cleanups.push(async () => {
      restore();
      await fs.rm(configDir, { recursive: true, force: true });
    });
    await fs.writeFile(
      path.join(configDir, 'flowguard.json'),
      JSON.stringify({
        schemaVersion: 'v1',
        archive: {
          redaction: {
            allowedModes: [redaction.mode],
            allowRawExport: redaction.includeRaw,
          },
        },
      }),
      'utf8',
    );
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const initialized = await initWorkspace(path.resolve('.'), sessionId);
    await writeState(initialized.sessionDir, makeState('COMPLETE'));

    await expect(
      archiveSession(initialized.fingerprint, sessionId, {
        redactionMode: redaction.mode,
        includeRaw: redaction.includeRaw,
      }),
    ).resolves.toBeDefined();
  });

  it('rejects archive with redactionMode=none and includeRaw=false', async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-v2-'));
    const restore = withTestEnv({ OPENCODE_CONFIG_DIR: configDir });
    cleanups.push(async () => {
      restore();
      await fs.rm(configDir, { recursive: true, force: true });
    });
    await fs.writeFile(
      path.join(configDir, 'flowguard.json'),
      JSON.stringify({
        schemaVersion: 'v1',
        archive: { redaction: { allowedModes: ['none'], allowRawExport: true } },
      }),
      'utf8',
    );
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const initialized = await initWorkspace(path.resolve('.'), sessionId);
    await writeState(initialized.sessionDir, makeState('COMPLETE'));

    await expect(
      archiveSession(initialized.fingerprint, sessionId, {
        redactionMode: 'none',
        includeRaw: false,
      }),
    ).rejects.toMatchObject({ code: 'ARCHIVE_FAILED' });
  });

  it('rejects sharing exports outside the configured redaction and raw-export policy', async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-v2-'));
    const restore = withTestEnv({ OPENCODE_CONFIG_DIR: configDir });
    cleanups.push(async () => {
      restore();
      await fs.rm(configDir, { recursive: true, force: true });
    });
    await writeConfigForTest(configDir, 'basic', false);

    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const initialized = await initWorkspace(path.resolve('.'), sessionId);
    await writeState(initialized.sessionDir, makeState('COMPLETE'));

    await expect(
      archiveSession(initialized.fingerprint, sessionId, {
        redactionMode: 'pseudonymous',
        includeRaw: false,
      }),
    ).rejects.toMatchObject({ code: 'ARCHIVE_FAILED' });
    await expect(
      archiveSession(initialized.fingerprint, sessionId, {
        redactionMode: 'basic',
        includeRaw: true,
      }),
    ).rejects.toMatchObject({ code: 'ARCHIVE_FAILED' });
  });

  it('allows the regulated completion chain to create required raw evidence in a sharing-only configuration', async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-v2-'));
    const restore = withTestEnv({ OPENCODE_CONFIG_DIR: configDir });
    cleanups.push(async () => {
      restore();
      await fs.rm(configDir, { recursive: true, force: true });
    });
    await writeConfigForTest(configDir, 'basic', false);

    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const initialized = await initWorkspace(path.resolve('.'), sessionId);
    await writeState(
      initialized.sessionDir,
      makeState('COMPLETE', { policySnapshot: REGULATED_POLICY_SNAPSHOT }),
    );
    await appendCompletionAuditEvent(initialized.sessionDir, sessionId);

    await expect(
      archiveRegulatedEvidence(initialized.fingerprint, sessionId),
    ).resolves.toBeDefined();
  });

  it('preserves immutable regulated evidence when a later sharing export is created', async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-v2-'));
    const restore = withTestEnv({ OPENCODE_CONFIG_DIR: configDir });
    cleanups.push(async () => {
      restore();
      await fs.rm(configDir, { recursive: true, force: true });
    });
    await writeConfigForTest(configDir, 'basic', false);

    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const initialized = await initWorkspace(path.resolve('.'), sessionId);
    await writeState(
      initialized.sessionDir,
      makeState('COMPLETE', { policySnapshot: REGULATED_POLICY_SNAPSHOT }),
    );
    await appendCompletionAuditEvent(initialized.sessionDir, sessionId);

    const regulatedPath = await archiveRegulatedEvidence(initialized.fingerprint, sessionId);
    const sharingPath = await archiveSession(initialized.fingerprint, sessionId, {
      redactionMode: 'basic',
      includeRaw: false,
    });

    expect(regulatedPath).not.toBe(sharingPath);
    await expect(fs.access(regulatedPath)).resolves.toBeUndefined();
    expect((await verifyRegulatedArchive(initialized.fingerprint, sessionId)).passed).toBe(true);
  });

  it('rejects the regulated evidence path for a non-regulated session', async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-v2-'));
    const restore = withTestEnv({ OPENCODE_CONFIG_DIR: configDir });
    cleanups.push(async () => {
      restore();
      await fs.rm(configDir, { recursive: true, force: true });
    });
    await writeConfigForTest(configDir, 'none', false);

    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const initialized = await initWorkspace(path.resolve('.'), sessionId);
    await writeState(initialized.sessionDir, makeState('COMPLETE'));

    await expect(
      archiveRegulatedEvidence(initialized.fingerprint, sessionId),
    ).rejects.toMatchObject({ code: 'ARCHIVE_FAILED' });
  });

  it('rejects the regulated evidence path without a clean regulated state', async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-v2-'));
    const restore = withTestEnv({ OPENCODE_CONFIG_DIR: configDir });
    cleanups.push(async () => {
      restore();
      await fs.rm(configDir, { recursive: true, force: true });
    });
    await writeConfigForTest(configDir, 'basic', false);

    const missingStateSession = '550e8400-e29b-41d4-a716-446655440000';
    const missingState = await initWorkspace(path.resolve('.'), missingStateSession);
    await expect(
      archiveRegulatedEvidence(missingState.fingerprint, missingStateSession),
    ).rejects.toMatchObject({ code: 'ARCHIVE_FAILED' });

    const abortedSession = '550e8400-e29b-41d4-a716-446655440001';
    const aborted = await initWorkspace(path.resolve('.'), abortedSession);
    await writeState(
      aborted.sessionDir,
      makeState('COMPLETE', {
        policySnapshot: REGULATED_POLICY_SNAPSHOT,
        error: {
          code: 'ABORTED',
          message: 'emergency exit',
          recoveryHint: 'start a new session',
          occurredAt: '2026-01-01T00:00:00.000Z',
        },
      }),
    );
    await expect(
      archiveRegulatedEvidence(aborted.fingerprint, abortedSession),
    ).rejects.toMatchObject({ code: 'ARCHIVE_FAILED' });
  });

  it('requires the canonical regulated completion event', async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-v2-'));
    const restore = withTestEnv({ OPENCODE_CONFIG_DIR: configDir });
    cleanups.push(async () => {
      restore();
      await fs.rm(configDir, { recursive: true, force: true });
    });
    await writeConfigForTest(configDir, 'basic', false);

    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const initialized = await initWorkspace(path.resolve('.'), sessionId);
    await writeState(
      initialized.sessionDir,
      makeState('COMPLETE', { policySnapshot: REGULATED_POLICY_SNAPSHOT }),
    );
    await appendAuditEvent(initialized.sessionDir, {
      id: crypto.randomUUID(),
      sessionId,
      phase: 'COMPLETE',
      event: 'lifecycle:session_completed',
      timestamp: '2026-01-01T00:00:00.000Z',
      actor: 'machine',
      detail: { action: 'other_action' },
    });

    await expect(
      archiveRegulatedEvidence(initialized.fingerprint, sessionId),
    ).rejects.toMatchObject({ code: 'ARCHIVE_FAILED' });
  });

  it('binds evidence artifacts once and rebinds when their inventory changes', async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-v2-'));
    const restore = withTestEnv({ OPENCODE_CONFIG_DIR: configDir });
    cleanups.push(async () => {
      restore();
      await fs.rm(configDir, { recursive: true, force: true });
    });
    await writeConfigForTest(configDir, 'none', true);

    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const initialized = await initWorkspace(path.resolve('.'), sessionId);
    await writeState(initialized.sessionDir, makeState('COMPLETE'));
    await fs.mkdir(path.join(initialized.sessionDir, 'artifacts'), { recursive: true });
    await fs.writeFile(path.join(initialized.sessionDir, 'artifacts', 'proof.json'), '{}', 'utf8');

    const options = { redactionMode: 'none' as const, includeRaw: true };
    await archiveSession(initialized.fingerprint, sessionId, options);
    await archiveSession(initialized.fingerprint, sessionId, options);
    let bindings = (await readAuditTrail(initialized.sessionDir)).events.filter(
      (event) => event.event === 'archive:artifacts_bound',
    );
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.detail).toMatchObject({
      artifactCount: 1,
      artifacts: [
        expect.objectContaining({ path: 'artifacts/other/proof.json', artifactType: 'proof' }),
      ],
    });

    await fs.writeFile(
      path.join(initialized.sessionDir, 'artifacts', 'report.txt'),
      'report',
      'utf8',
    );
    await archiveSession(initialized.fingerprint, sessionId, options);
    bindings = (await readAuditTrail(initialized.sessionDir)).events.filter(
      (event) => event.event === 'archive:artifacts_bound',
    );
    expect(bindings).toHaveLength(2);
    expect(bindings[1]?.detail).toMatchObject({ artifactCount: 2 });
  });

  it('verifies the tarball independently of later live-session mutations', async () => {
    const { fingerprint, sessionId, sessionDir } = await createArchive();
    await fs.writeFile(path.join(sessionDir, 'session-state.json'), 'tampered', 'utf8');
    expect((await verifyArchive(fingerprint, sessionId)).passed).toBe(true);
  });
});
