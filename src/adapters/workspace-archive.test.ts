import { afterEach, describe, expect, it, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { archiveSession, initWorkspace, verifyArchive } from './workspace/index.js';
import { archiveFileName, archiveRegulatedEvidence } from './workspace/archive.js';
import { verifyRegulatedArchive } from './workspace/archive-verify-chain.js';
import { writeState, readState } from './persistence.js';
import { appendAuditEvent, readAuditTrail } from './persistence-audit.js';
import * as persistenceAudit from './persistence-audit.js';
import { computeCanonicalEventDigest } from '../audit/canonical-digest.js';
import { computeChainHash, type ChainedAuditEvent } from '../audit/types.js';
import { verifyChain } from '../audit/integrity.js';
import { makeState, REGULATED_POLICY_SNAPSHOT } from '../fixtures.js';
import type { SessionState } from '../state/schema.js';
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

async function repack(archivePath: string, root: string, sessionId: string): Promise<void> {
  const manifest = JSON.parse(
    await fs.readFile(path.join(root, sessionId, 'archive-manifest.json'), 'utf8'),
  ) as { includedFiles: string[] };
  const members = [...manifest.includedFiles, 'archive-manifest.json'].map(
    (file) => `${sessionId}/${file}`,
  );
  await promisify(execFile)('tar', ['--format=ustar', '-czf', archivePath, '-C', root, ...members]);
}

async function appendCompletionAuditEvent(sessDir: string, sessionId: string): Promise<void> {
  const state = await readState(sessDir);
  await appendAuditEvent(sessDir, {
    id: crypto.randomUUID(),
    flowguardSessionId: state!.flowguardSessionId,
    hostSessionId: sessionId,
    phase: 'COMPLETE',
    event: 'lifecycle:session_completed',
    occurredAt: '2026-01-01T00:00:00.000Z',
    actor: 'machine',
    detail: { action: 'session_completed' },
  });
}

function resealAuditTrailWithClockAnomaly(
  events: readonly ChainedAuditEvent[],
): ChainedAuditEvent[] {
  let previousHash = 'genesis';
  return events.map((event, index) => {
    const { chainHash: _chainHash, semanticEventDigest: _semanticEventDigest, ...body } = event;
    const recordedAt =
      index === events.length - 2
        ? '2026-01-02T00:00:00.000Z'
        : index === events.length - 1
          ? '2026-01-01T00:00:00.000Z'
          : body.recordedAt;
    const finalized = {
      ...body,
      recordedAt,
      prevHash: previousHash,
    };
    const resealed = {
      ...finalized,
      semanticEventDigest: computeCanonicalEventDigest(finalized),
    };
    const chained = {
      ...resealed,
      chainHash: computeChainHash(previousHash, resealed),
    } as ChainedAuditEvent;
    previousHash = chained.chainHash;
    return chained;
  });
}

describe('Archive Layout v2', () => {
  it('uses a distinct filename for mandatory regulated evidence', () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';

    expect(archiveFileName(sessionId)).toBe(`${sessionId}.tar.gz`);
    expect(archiveFileName(sessionId, true)).toBe(`regulated-${sessionId}.tar.gz`);
  });

  it('fails closed when the session directory disappears during archive setup', async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-v2-'));
    const restore = withTestEnv({ OPENCODE_CONFIG_DIR: configDir });
    cleanups.push(async () => {
      restore();
      await fs.rm(configDir, { recursive: true, force: true });
    });
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const initialized = await initWorkspace(path.resolve('.'), sessionId);
    await writeConfigForTest(configDir, 'none', true);
    await fs.rm(initialized.sessionDir, { recursive: true, force: true });

    await expect(
      archiveSession(initialized.fingerprint, sessionId, {
        redactionMode: 'none',
        includeRaw: true,
      }),
    ).rejects.toMatchObject({ code: 'ARCHIVE_FAILED' });
  });

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
      flowguardSessionId: makeState().flowguardSessionId,
      hostSessionId: sessionId,
      phase: 'PLAN_REVIEW',
      event: 'decision:DEC-ARCHIVE-001',
      occurredAt: '2026-01-01T00:00:00.000Z',
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

  it('fails closed for an unparseable audit-trail record', async () => {
    const { fingerprint, sessionId, sessionDir } = await createArchive();
    await fs.writeFile(path.join(sessionDir, 'audit.jsonl'), 'not valid json\n', 'utf8');

    await expect(
      archiveSession(fingerprint, sessionId, { redactionMode: 'none', includeRaw: true }),
    ).rejects.toMatchObject({
      code: 'AUDIT_ENVELOPE_INVALID',
    });
  });

  it('allows a redacted archive at the configured audit-event limit', async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-v2-'));
    const restore = withTestEnv({ OPENCODE_CONFIG_DIR: configDir });
    cleanups.push(async () => {
      restore();
      await fs.rm(configDir, { recursive: true, force: true });
    });
    const config = JSON.stringify({
      schemaVersion: 'v1',
      archive: {
        redaction: { allowedModes: ['basic'], allowRawExport: false, maxAuditEvents: 1 },
      },
    });
    await fs.writeFile(path.join(configDir, 'flowguard.json'), config, 'utf8');
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const initialized = await initWorkspace(path.resolve('.'), sessionId);
    await writeState(initialized.sessionDir, makeState('COMPLETE'));
    await appendCompletionAuditEvent(initialized.sessionDir, sessionId);

    await expect(
      archiveSession(initialized.fingerprint, sessionId, {
        redactionMode: 'basic',
        includeRaw: false,
      }),
    ).resolves.toBeDefined();
    await appendCompletionAuditEvent(initialized.sessionDir, sessionId);

    await expect(
      archiveSession(initialized.fingerprint, sessionId, {
        redactionMode: 'basic',
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
    const state = await readState(initialized.sessionDir);
    await appendAuditEvent(initialized.sessionDir, {
      id: crypto.randomUUID(),
      flowguardSessionId: state!.flowguardSessionId,
      hostSessionId: sessionId,
      phase: 'COMPLETE',
      event: 'lifecycle:session_completed',
      occurredAt: '2026-01-01T00:00:00.000Z',
      actor: 'machine',
      detail: { action: 'preparation_completed' },
    });
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
    await appendCompletionAuditEvent(initialized.sessionDir, sessionId);

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
      flowguardSessionId: makeState().flowguardSessionId,
      hostSessionId: sessionId,
      phase: 'COMPLETE',
      event: 'lifecycle:session_completed',
      occurredAt: '2026-01-01T00:00:00.000Z',
      actor: 'machine',
      detail: { action: 'other_action' },
    });

    await expect(
      archiveRegulatedEvidence(initialized.fingerprint, sessionId),
    ).rejects.toMatchObject({ code: 'ARCHIVE_FAILED' });
  });

  it('binds evidence artifacts once and publishes every changed archive candidate', async () => {
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
    const archivePath = await archiveSession(initialized.fingerprint, sessionId, options);
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
    const publications = (await readAuditTrail(initialized.sessionDir)).events.filter(
      (event) => event.event === 'archive:publication_bound',
    );
    expect(publications).toHaveLength(3);
    expect(publications[2]?.detail).toMatchObject({
      schemaVersion: 'flowguard-archive-publication-binding.v1',
      archiveFile: path.basename(archivePath),
    });
  });

  it('rebinds artifacts when their bytes change without changing their count', async () => {
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
    const proofPath = path.join(initialized.sessionDir, 'artifacts', 'proof.json');
    await fs.mkdir(path.dirname(proofPath), { recursive: true });
    await fs.writeFile(proofPath, '{"version":1}', 'utf8');
    await fs.writeFile(path.join(path.dirname(proofPath), 'report.txt'), 'unchanged', 'utf8');
    const options = { redactionMode: 'none' as const, includeRaw: true };
    await archiveSession(initialized.fingerprint, sessionId, options);
    await fs.writeFile(proofPath, '{"version":2}', 'utf8');

    await archiveSession(initialized.fingerprint, sessionId, options);

    const bindings = (await readAuditTrail(initialized.sessionDir)).events.filter(
      (event) => event.event === 'archive:artifacts_bound',
    );
    expect(bindings).toHaveLength(2);
    expect(bindings[1]?.detail).toMatchObject({ artifactCount: 2 });
  });

  it('fails closed when a published archive has no external publication binding', async () => {
    const { fingerprint, sessionId, sessionDir } = await createArchive();
    await fs.writeFile(path.join(sessionDir, 'audit.jsonl'), '', 'utf8');

    const verification = await verifyArchive(fingerprint, sessionId);
    expect(verification.passed).toBe(false);
    expect(
      verification.findings.some((finding) => finding.code === 'archive_publication_unbound'),
    ).toBe(true);
  });

  it('detects a valid but truncated audit-chain prefix in a tampered archive', async () => {
    const { archivePath, fingerprint, sessionId, sessionDir } = await createArchive();
    await appendCompletionAuditEvent(sessionDir, sessionId);
    await appendCompletionAuditEvent(sessionDir, sessionId);
    await archiveSession(fingerprint, sessionId, { redactionMode: 'none', includeRaw: true });
    const extracted = await extract(archivePath);
    const auditPath = path.join(extracted, sessionId, 'audit', 'audit.jsonl');
    const events = (await fs.readFile(auditPath, 'utf8')).trim().split('\n');
    expect(events.length).toBeGreaterThan(1);
    await fs.writeFile(auditPath, `${events.slice(0, -1).join('\n')}\n`, 'utf8');
    await repack(archivePath, extracted, sessionId);

    const verification = await verifyArchive(fingerprint, sessionId);

    expect(verification.passed).toBe(false);
    expect(
      verification.findings.slice(0, 2).map(({ code, severity, file }) => ({
        code,
        severity,
        file,
      })),
    ).toEqual([
      { code: 'file_digest_mismatch', severity: 'error', file: 'audit/audit.jsonl' },
      { code: 'audit_chain_truncated', severity: 'error', file: 'audit.jsonl' },
    ]);
    expect(verification.findings[1]).toEqual({
      code: 'audit_chain_truncated',
      severity: 'error',
      message: `Audit trail does not match manifest anchor: expected ${events.length} event(s), found ${events.length - 1}`,
      file: 'audit.jsonl',
    });
  });

  it('fails closed when the manifest policy mode differs from governed state', async () => {
    const { archivePath, fingerprint, sessionId } = await createArchive();
    const extracted = await extract(archivePath);
    const manifestPath = path.join(extracted, sessionId, 'archive-manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    await fs.writeFile(
      manifestPath,
      JSON.stringify({ ...manifest, policyMode: 'regulated' }),
      'utf8',
    );
    await repack(archivePath, extracted, sessionId);

    const verification = await verifyArchive(fingerprint, sessionId);

    expect(verification.passed).toBe(false);
    expect(verification.findings[0]).toEqual({
      code: 'manifest_policy_mode_mismatch',
      severity: 'error',
      message: "Manifest policyMode 'regulated' does not match governed state mode 'team'",
      file: 'archive-manifest.json',
    });
  });

  it('reports a missing checksum sidecar even when publication binding cannot be evaluated', async () => {
    const { archivePath, fingerprint, sessionId } = await createArchive();
    await fs.rm(`${archivePath}.sha256`);

    const verification = await verifyArchive(fingerprint, sessionId);

    expect(verification.passed).toBe(false);
    expect(verification.findings).toEqual([
      {
        code: 'archive_checksum_missing',
        severity: 'warning',
        message: 'Archive checksum sidecar (.sha256) not found',
        file: undefined,
      },
      {
        code: 'archive_publication_binding_invalid',
        severity: 'error',
        message: expect.stringMatching(
          /^Published archive binding could not be evaluated: ENOENT: .*\.tar\.gz\.sha256'$/,
        ),
        file: undefined,
      },
    ]);
  });

  it('rejects a checksum sidecar with multiple digest tokens', async () => {
    const { archivePath, fingerprint, sessionId } = await createArchive();
    const checksum = await fs.readFile(`${archivePath}.sha256`, 'utf8');
    await fs.writeFile(`${archivePath}.sha256`, `${checksum.trim()} ${'a'.repeat(64)}\n`, 'utf8');

    const verification = await verifyArchive(fingerprint, sessionId);

    expect(verification.passed).toBe(false);
    expect(verification.findings).toContainEqual(
      expect.objectContaining({ code: 'archive_checksum_mismatch', severity: 'error' }),
    );
  });

  it('rejects a validly formatted checksum that does not match the archive bytes', async () => {
    const { archivePath, fingerprint, sessionId } = await createArchive();
    await fs.writeFile(`${archivePath}.sha256`, `${'a'.repeat(64)}  archive.tar.gz\n`, 'utf8');

    const verification = await verifyArchive(fingerprint, sessionId);

    expect(verification.passed).toBe(false);
    expect(verification.findings).toContainEqual(
      expect.objectContaining({ code: 'archive_checksum_mismatch', severity: 'error' }),
    );
  });

  it('rejects an archive whose audit event count matches but head does not', async () => {
    const { archivePath, fingerprint, sessionId, sessionDir } = await createArchive();
    await appendCompletionAuditEvent(sessionDir, sessionId);
    await archiveSession(fingerprint, sessionId, { redactionMode: 'none', includeRaw: true });
    const extracted = await extract(archivePath);
    const manifestPath = path.join(extracted, sessionId, 'archive-manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    await fs.writeFile(
      manifestPath,
      JSON.stringify({ ...manifest, auditChainHead: '0'.repeat(64) }),
      'utf8',
    );
    await repack(archivePath, extracted, sessionId);

    const verification = await verifyArchive(fingerprint, sessionId);

    expect(verification.passed).toBe(false);
    expect(verification.findings).toContainEqual(
      expect.objectContaining({ code: 'audit_chain_truncated', severity: 'error' }),
    );
  });

  it('reports both artifact bytes and manifest digests that disagree with the audit binding', async () => {
    const { archivePath, fingerprint, sessionId, sessionDir } = await createArchive();
    await fs.mkdir(path.join(sessionDir, 'artifacts'), { recursive: true });
    await fs.writeFile(path.join(sessionDir, 'artifacts', 'proof.json'), '{"valid":true}', 'utf8');
    await archiveSession(fingerprint, sessionId, { redactionMode: 'none', includeRaw: true });
    const extracted = await extract(archivePath);
    const root = path.join(extracted, sessionId);
    const manifestPath = path.join(root, 'archive-manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as {
      fileDigests: Record<string, string>;
    };
    const artifact = Object.keys(manifest.fileDigests).find((file) =>
      file.startsWith('artifacts/'),
    );
    expect(artifact).toBeDefined();
    await fs.writeFile(path.join(root, artifact!), '{"valid":false}', 'utf8');
    await fs.writeFile(
      manifestPath,
      JSON.stringify({
        ...manifest,
        fileDigests: { ...manifest.fileDigests, [artifact!]: 'b'.repeat(64) },
      }),
      'utf8',
    );
    await repack(archivePath, extracted, sessionId);

    const verification = await verifyArchive(fingerprint, sessionId);

    expect(verification.passed).toBe(false);
    expect(
      verification.findings.filter((finding) => finding.code === 'artifact_binding_mismatch'),
    ).toHaveLength(2);
  });

  it('fails closed for an unreadable archive before attempting extraction', async () => {
    const { archivePath, fingerprint, sessionId } = await createArchive();
    await fs.writeFile(archivePath, 'not a gzip archive', 'utf8');

    const verification = await verifyArchive(fingerprint, sessionId);

    expect(verification.passed).toBe(false);
    expect(verification.manifest).toBeNull();
    expect(verification.findings).toContainEqual(
      expect.objectContaining({ code: 'unexpected_file', severity: 'error' }),
    );
  });

  it('surfaces missing state and discovery snapshots before payload integrity findings', async () => {
    const { archivePath, fingerprint, sessionId } = await createArchive();
    const extracted = await extract(archivePath);
    const manifestPath = path.join(extracted, sessionId, 'archive-manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as {
      includedFiles: string[];
      fileDigests: Record<string, string>;
    };
    await fs.rm(path.join(extracted, sessionId, 'state', 'session-state.json'));
    const { 'state/session-state.json': _stateDigest, ...fileDigests } = manifest.fileDigests;
    await fs.writeFile(
      manifestPath,
      JSON.stringify({
        ...manifest,
        includedFiles: manifest.includedFiles.filter((file) => file !== 'state/session-state.json'),
        fileDigests,
        discoveryDigest: 'a'.repeat(64),
      }),
      'utf8',
    );
    await repack(archivePath, extracted, sessionId);

    const verification = await verifyArchive(fingerprint, sessionId);

    expect(verification.passed).toBe(false);
    expect(verification.findings.slice(0, 3)).toMatchObject([
      { code: 'state_missing', severity: 'error' },
      { code: 'snapshot_missing', file: 'context/discovery-snapshot.json', severity: 'warning' },
      {
        code: 'snapshot_missing',
        file: 'context/profile-resolution-snapshot.json',
        severity: 'warning',
      },
    ]);
  });

  it('rejects a non-regulated archive with a re-sealed clock anomaly', async () => {
    const { fingerprint, sessionId, sessionDir } = await createArchive();
    await appendCompletionAuditEvent(sessionDir, sessionId);
    await appendCompletionAuditEvent(sessionDir, sessionId);
    const events = (await readAuditTrail(sessionDir)).events;
    const resealed = resealAuditTrailWithClockAnomaly(events);
    await fs.writeFile(
      path.join(sessionDir, 'audit.jsonl'),
      `${resealed.map((event) => JSON.stringify(event)).join('\n')}\n`,
      'utf-8',
    );
    expect(verifyChain(resealed as unknown as Record<string, unknown>[]).reason).toBe(
      'CLOCK_ANOMALY',
    );

    await archiveSession(fingerprint, sessionId, { redactionMode: 'none', includeRaw: true });
    const verification = await verifyArchive(fingerprint, sessionId);

    expect(verification.passed).toBe(false);
    expect(verification.findings).toContainEqual(
      expect.objectContaining({ code: 'audit_chain_invalid', severity: 'error' }),
    );
  });

  it('fails closed when a non-regulated tsa_critical+strict policy is violated', async () => {
    // Production plumbing: the archive mode (team) resolves to NON-strict,
    // but the explicit timestampAssurance.strict policy must still make the
    // token-layer findings fatal — a tsa_critical violation may never pass
    // with a mere warning.
    const { fingerprint, sessionId, sessionDir } = await createArchive();
    const state = await readState(sessionDir);
    const strictTsaState: SessionState = {
      ...state!,
      policySnapshot: {
        ...state!.policySnapshot,
        mode: 'team',
        audit: {
          ...state!.policySnapshot.audit,
          timestampAssurance: {
            enabled: true,
            mode: 'tsa_critical',
            strict: true,
            criticalEvents: ['decision', 'lifecycle'],
            tsaUrl: 'https://tsa.example.test',
            trustAnchors: ['not a pem certificate'],
            ntpServers: ['pool.ntp.org'],
            ntpDriftThresholdMs: 30000,
            tsaTimeoutMs: 10000,
          },
        },
      },
    };
    await writeState(sessionDir, strictTsaState);
    // A critical lifecycle event WITHOUT any external TSA token.
    await appendCompletionAuditEvent(sessionDir, sessionId);

    await archiveSession(fingerprint, sessionId, { redactionMode: 'none', includeRaw: true });
    const verification = await verifyArchive(fingerprint, sessionId);

    expect(verification.passed).toBe(false);
    expect(
      verification.findings.some(
        (finding) =>
          finding.code === 'tsa_token_required_by_policy' && finding.severity === 'error',
      ),
    ).toBe(true);
  });

  it('retains a published-but-unbound archive after binding append failure and recovers on retry', async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-v2-'));
    const restore = withTestEnv({ OPENCODE_CONFIG_DIR: configDir });
    cleanups.push(async () => {
      restore();
      await fs.rm(configDir, { recursive: true, force: true });
    });
    await writeConfigForTest(configDir, 'none', true, path.resolve('.'));
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const initialized = await initWorkspace(path.resolve('.'), sessionId);
    await writeState(initialized.sessionDir, makeState('COMPLETE'));
    const archivePath = path.join(
      configDir,
      'workspaces',
      initialized.fingerprint,
      'sessions',
      'archive',
      `${sessionId}.tar.gz`,
    );
    const append = vi
      .spyOn(persistenceAudit, 'appendAuditEvent')
      .mockRejectedValueOnce(new Error('injected publication binding failure'));

    try {
      await expect(
        archiveSession(initialized.fingerprint, sessionId, {
          redactionMode: 'none',
          includeRaw: true,
        }),
      ).rejects.toThrow('injected publication binding failure');
    } finally {
      append.mockRestore();
    }

    await expect(fs.access(archivePath)).resolves.toBeUndefined();
    await expect(fs.access(`${archivePath}.sha256`)).resolves.toBeUndefined();
    expect((await verifyArchive(initialized.fingerprint, sessionId)).passed).toBe(false);

    await archiveSession(initialized.fingerprint, sessionId, {
      redactionMode: 'none',
      includeRaw: true,
    });
    expect((await verifyArchive(initialized.fingerprint, sessionId)).passed).toBe(true);
  });

  it('verifies the tarball independently of later live-session mutations', async () => {
    const { fingerprint, sessionId, sessionDir } = await createArchive();
    await fs.writeFile(path.join(sessionDir, 'session-state.json'), 'tampered', 'utf8');
    expect((await verifyArchive(fingerprint, sessionId)).passed).toBe(true);
  });
});
