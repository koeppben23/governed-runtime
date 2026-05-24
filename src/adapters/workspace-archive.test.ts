/**
 * @module workspace.test
 * @description Tests for the workspace registry module.
 *
 * Covers:
 * - Fingerprint computation (remote canonical + local path fallback)
 * - URL canonicalization (HTTPS, SSH, SCP-style, edge cases)
 * - Path normalization for fingerprint
 * - Path segment validation (fingerprint, sessionId)
 * - Workspace/session directory resolution
 * - initWorkspace idempotency and mismatch detection
 * - Session pointer read/write (non-authoritative)
 * - archiveSession (requires tar)
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE, PERF — all five categories present.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  canonicalizeOriginUrl,
  normalizeForFingerprint,
  computeFingerprintFromRemote,
  computeFingerprintFromPath,
  validateFingerprint,
  validateSessionId,
  workspacesHome,
  workspaceDir,
  sessionDir,
  ensureWorkspace,
  initWorkspace,
  readWorkspaceInfo,
  writeSessionPointer,
  readSessionPointer,
  archiveSession,
  verifyArchive,
  WorkspaceError,
  type WorkspaceInfo,
} from './workspace/index.js';
import * as crypto from 'node:crypto';
import { withTestEnv } from '../integration/test-helpers.js';
import { benchmarkSync, measureAsync } from '../test-policy.js';
import { createDecisionEvent, createLifecycleEvent, GENESIS_HASH } from '../audit/types.js';
import { writeState, auditPath, globalConfigPath, PersistenceError } from './persistence.js';
import { makeState, POLICY_SNAPSHOT } from '../__fixtures__.js';

// ─── Test Helpers ─────────────────────────────────────────────────────────────

let tmpDir: string;

async function createTmpDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'ws-test-'));
}

async function cleanTmpDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Best effort on Windows (file locks)
  }
}

describe('archiveSession', () => {
  let cleanupEnv: () => void;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    cleanupEnv = withTestEnv({ OPENCODE_CONFIG_DIR: tmpDir });
  });

  afterEach(async () => {
    cleanupEnv();
    await cleanTmpDir(tmpDir);
  });

  it('archives a session directory as tar.gz', async () => {
    const worktree = path.resolve('.');
    const sessionId = 'archive-test-001';
    const { fingerprint, sessionDir: sessDir } = await initWorkspace(worktree, sessionId);

    // Write a test file into the session directory
    await writeState(sessDir, makeState('COMPLETE'));

    const archivePath = await archiveSession(fingerprint, sessionId);
    expect(archivePath).toContain('.tar.gz');
    expect(archivePath).toContain(sessionId);

    // Archive file should exist
    const stats = await fs.stat(archivePath);
    expect(stats.size).toBeGreaterThan(0);

    const receiptsPath = path.join(sessDir, 'decision-receipts.v1.json');
    const receiptsRaw = await fs.readFile(receiptsPath, 'utf-8');
    const receipts = JSON.parse(receiptsRaw);
    expect(receipts.schemaVersion).toBe('decision-receipts.v1');
    expect(Array.isArray(receipts.receipts)).toBe(true);

    const manifest = JSON.parse(
      await fs.readFile(path.join(sessDir, 'archive-manifest.json'), 'utf-8'),
    );
    expect(manifest.redactionMode).toBe('basic');
    expect(manifest.rawIncluded).toBe(false);
    expect(manifest.redactedArtifacts).toContain('decision-receipts.redacted.v1.json');
    expect(manifest.excludedFiles).toContain('decision-receipts.v1.json');
  });

  it('includes raw artifacts only when includeRaw=true', async () => {
    const worktree = path.resolve('.');
    const sessionId = 'archive-test-raw-opt-in';
    const { fingerprint, sessionDir: sessDir } = await initWorkspace(worktree, sessionId);

    await writeState(sessDir, makeState('COMPLETE'));
    await fs.writeFile(
      path.join(process.env.OPENCODE_CONFIG_DIR!, 'flowguard.json'),
      JSON.stringify({
        schemaVersion: 'v1',
        archive: { redaction: { mode: 'basic', includeRaw: true } },
      }),
      'utf-8',
    );

    await archiveSession(fingerprint, sessionId);

    const manifest = JSON.parse(
      await fs.readFile(path.join(sessDir, 'archive-manifest.json'), 'utf-8'),
    );
    expect(manifest.rawIncluded).toBe(true);
    expect(manifest.riskFlags).toContain('raw_export_enabled');
    expect(manifest.excludedFiles).not.toContain('decision-receipts.v1.json');
  });

  it('redacts review-report and excludes raw report by default', async () => {
    const worktree = path.resolve('.');
    const sessionId = 'archive-test-review-report-redaction';
    const { fingerprint, sessionDir: sessDir } = await initWorkspace(worktree, sessionId);

    await writeState(sessDir, makeState('COMPLETE'));
    await fs.writeFile(
      path.join(sessDir, 'review-report.json'),
      JSON.stringify({ findings: [{ message: 'contains secret' }] }),
      'utf-8',
    );

    await archiveSession(fingerprint, sessionId);

    const manifest = JSON.parse(
      await fs.readFile(path.join(sessDir, 'archive-manifest.json'), 'utf-8'),
    );
    expect(manifest.redactedArtifacts).toContain('review-report.redacted.json');
    expect(manifest.excludedFiles).toContain('review-report.json');
  });

  it('mode=none: raw receipts included, no redacted artifact, rawIncluded=true', async () => {
    const worktree = path.resolve('.');
    const sessionId = '550e8400-e29b-41d4-a716-446655440010';
    const { fingerprint, sessionDir: sessDir } = await initWorkspace(worktree, sessionId);
    const wsDir = workspaceDir(fingerprint);
    const ts = '2026-04-17T00:00:00.000Z';

    await writeState(sessDir, makeState('COMPLETE'));
    const event = createDecisionEvent({
      sessionId: sessionId,
      gatePhase: 'PLAN_REVIEW',
      detail: {
        decisionId: 'DEC-NONE-01',
        decisionSequence: 1,
        verdict: 'approve',
        rationale: 'secret-alice',
        decidedBy: 'alice',
        decidedAt: ts,
        fromPhase: 'PLAN_REVIEW',
        toPhase: 'VALIDATION',
        transitionEvent: 'APPROVE',
        policyMode: 'team',
      },
      timestamp: ts,
      actor: 'alice',
      prevHash: GENESIS_HASH,
    });
    await fs.writeFile(path.join(sessDir, 'audit.jsonl'), JSON.stringify(event) + '\n', 'utf-8');
    await fs.writeFile(
      path.join(process.env.OPENCODE_CONFIG_DIR!, 'flowguard.json'),
      JSON.stringify({ schemaVersion: 'v1', archive: { redaction: { mode: 'none' } } }),
      'utf-8',
    );

    const archivePath = await archiveSession(fingerprint, sessionId);
    expect(archivePath).toContain('.tar.gz');

    const manifest = JSON.parse(
      await fs.readFile(path.join(sessDir, 'archive-manifest.json'), 'utf-8'),
    );
    expect(manifest.redactionMode).toBe('none');
    expect(manifest.rawIncluded).toBe(true);
    expect(manifest.redactedArtifacts ?? []).toHaveLength(0);
    expect(manifest.excludedFiles ?? []).not.toContain('decision-receipts.v1.json');

    const receipts = JSON.parse(
      await fs.readFile(path.join(sessDir, 'decision-receipts.v1.json'), 'utf-8'),
    );
    expect(receipts.count).toBe(1);
    const rawEntry = receipts.receipts[0] as Record<string, unknown>;
    expect(String(rawEntry.decidedBy ?? '')).toBe('alice');
    expect(String(rawEntry.rationale ?? '')).toBe('secret-alice');

    const redactedExists = await fs
      .access(path.join(sessDir, 'decision-receipts.redacted.v1.json'))
      .then(() => true)
      .catch(() => false);
    expect(redactedExists).toBe(false);
  });

  it('mode=strict: redacted artifact with deterministic tokens, raw excluded by default', async () => {
    const worktree = path.resolve('.');
    const sessionId = '550e8400-e29b-41d4-a716-446655440011';
    const { fingerprint, sessionDir: sessDir } = await initWorkspace(worktree, sessionId);
    const wsDir = workspaceDir(fingerprint);
    const ts = '2026-04-17T00:00:00.000Z';

    await writeState(sessDir, makeState('COMPLETE'));
    const event = createDecisionEvent({
      sessionId: sessionId,
      gatePhase: 'PLAN_REVIEW',
      detail: {
        decisionId: 'DEC-STRICT-01',
        decisionSequence: 1,
        verdict: 'approve',
        rationale: 'Token: ghp_SECRET',
        decidedBy: 'bob@secret.io',
        decidedAt: ts,
        fromPhase: 'PLAN_REVIEW',
        toPhase: 'VALIDATION',
        transitionEvent: 'APPROVE',
        policyMode: 'team',
      },
      timestamp: ts,
      actor: 'bob',
      prevHash: GENESIS_HASH,
    });
    await fs.writeFile(path.join(sessDir, 'audit.jsonl'), JSON.stringify(event) + '\n', 'utf-8');
    await fs.writeFile(
      path.join(process.env.OPENCODE_CONFIG_DIR!, 'flowguard.json'),
      JSON.stringify({ schemaVersion: 'v1', archive: { redaction: { mode: 'strict' } } }),
      'utf-8',
    );

    const archivePath = await archiveSession(fingerprint, sessionId);
    expect(archivePath).toContain('.tar.gz');

    const manifest = JSON.parse(
      await fs.readFile(path.join(sessDir, 'archive-manifest.json'), 'utf-8'),
    );
    expect(manifest.redactionMode).toBe('strict');
    expect(manifest.rawIncluded).toBe(false);
    expect(manifest.redactedArtifacts).toContain('decision-receipts.redacted.v1.json');
    expect(manifest.excludedFiles).toContain('decision-receipts.v1.json');

    const redacted = JSON.parse(
      await fs.readFile(path.join(sessDir, 'decision-receipts.redacted.v1.json'), 'utf-8'),
    );
    const entry = redacted.receipts[0] as Record<string, unknown>;
    const decidedByStr = String(entry.decidedBy ?? '');
    const rationaleStr = String(entry.rationale ?? '');
    expect(decidedByStr).toMatch(/^\[REDACTED:[a-f0-9]{12}\]$/);
    expect(rationaleStr).toMatch(/^\[REDACTED:[a-f0-9]{12}\]$/);
    expect(decidedByStr).not.toContain('bob');
    expect(rationaleStr).not.toContain('ghp_');
  });

  it('pipeline end-to-end: archive produces correctly redacted decision-receipts with sensitive data removed', async () => {
    const worktree = path.resolve('.');
    const sessionId = '550e8400-e29b-41d4-a716-446655440012';
    const { fingerprint, sessionDir: sessDir } = await initWorkspace(worktree, sessionId);
    const ts = '2026-04-17T00:00:00.000Z';

    await writeState(sessDir, makeState('COMPLETE'));
    const event = createDecisionEvent({
      sessionId: sessionId,
      gatePhase: 'PLAN_REVIEW',
      detail: {
        decisionId: 'DEC-E2E-01',
        decisionSequence: 1,
        verdict: 'approve',
        rationale: 'PII: carol@corp.com, IP 10.0.0.1',
        decidedBy: 'carol',
        decidedAt: ts,
        fromPhase: 'PLAN_REVIEW',
        toPhase: 'VALIDATION',
        transitionEvent: 'APPROVE',
        policyMode: 'team',
      },
      timestamp: ts,
      actor: 'carol',
      prevHash: GENESIS_HASH,
    });
    await fs.writeFile(path.join(sessDir, 'audit.jsonl'), JSON.stringify(event) + '\n', 'utf-8');

    await archiveSession(fingerprint, sessionId);

    const redacted = JSON.parse(
      await fs.readFile(path.join(sessDir, 'decision-receipts.redacted.v1.json'), 'utf-8'),
    );
    expect(redacted.schemaVersion).toBe('decision-receipts.v1');
    expect(redacted.count).toBe(1);

    const raw = JSON.parse(
      await fs.readFile(path.join(sessDir, 'decision-receipts.v1.json'), 'utf-8'),
    );
    const rawEntry = raw.receipts[0] as Record<string, unknown>;
    expect(rawEntry.decidedBy).toBe('carol');
    expect(String(rawEntry.rationale ?? '')).toContain('carol@corp.com');

    const entry = redacted.receipts[0] as Record<string, unknown>;
    expect(entry.decidedBy).toBe('[REDACTED]');
    expect(entry.rationale).toBe('[REDACTED]');
    expect(String(entry.decidedBy)).not.toContain('carol');
    expect(String(entry.rationale)).not.toContain('carol@corp.com');
    expect(String(entry.rationale)).not.toContain('10.0.0.1');
  });

  it('fails closed when redaction source is invalid JSON', async () => {
    const worktree = path.resolve('.');
    const sessionId = 'archive-test-redaction-fail';
    const { fingerprint, sessionDir: sessDir } = await initWorkspace(worktree, sessionId);

    await writeState(sessDir, makeState('COMPLETE'));
    await fs.writeFile(path.join(sessDir, 'review-report.json'), '{invalid-json', 'utf-8');

    await expect(archiveSession(fingerprint, sessionId)).rejects.toThrow('ARCHIVE_FAILED');
  });

  it('throws ARCHIVE_FAILED for non-existent session', async () => {
    await expect(archiveSession('a1b2c3d4e5f6a1b2c3d4e5f6', 'no-such-session')).rejects.toThrow(
      'ARCHIVE_FAILED',
    );
  });

  it('rejects invalid fingerprint', async () => {
    await expect(archiveSession('bad', 'session')).rejects.toThrow(WorkspaceError);
  });

  it('rejects unsafe session ID', async () => {
    await expect(archiveSession('a1b2c3d4e5f6a1b2c3d4e5f6', '../escape')).rejects.toThrow(
      WorkspaceError,
    );
  });
});

// =============================================================================
// archiveSession failure paths
// =============================================================================

describe('archiveSession failure paths', () => {
  let cleanupEnv: () => void;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    cleanupEnv = withTestEnv({ OPENCODE_CONFIG_DIR: tmpDir });
  });

  afterEach(async () => {
    cleanupEnv();
    await cleanTmpDir(tmpDir);
  });

  it('throws ARCHIVE_FAILED when archive directory cannot be created (permission denied)', async () => {
    const worktree = path.resolve('.');
    const sessionId = '550e8400-e29b-41d4-a716-446655440100';
    const { fingerprint, sessionDir: sessDir } = await initWorkspace(worktree, sessionId);
    await writeState(sessDir, makeState('COMPLETE'));

    // Set OPENCODE_CONFIG_DIR to a path that mkdir cannot create
    const cleanup = withTestEnv({ OPENCODE_CONFIG_DIR: '/root/fail-permission-test' });
    try {
      await expect(archiveSession(fingerprint, sessionId)).rejects.toThrow('ARCHIVE_FAILED');
    } finally {
      cleanup();
    }
  });

  it('throws ARCHIVE_FAILED when tar execution fails (missing binary)', async () => {
    const worktree = path.resolve('.');
    const sessionId = '550e8400-e29b-41d4-a716-446655440101';
    const { fingerprint, sessionDir: sessDir } = await initWorkspace(worktree, sessionId);
    await writeState(sessDir, makeState('COMPLETE'));

    const cleanup = withTestEnv({ PATH: '/nonexistent/path/with/no/tar' });
    try {
      await expect(archiveSession(fingerprint, sessionId)).rejects.toThrow('ARCHIVE_FAILED');
    } finally {
      cleanup();
    }
  });

  it('throws ARCHIVE_FAILED when archive path collides with existing file', async () => {
    const worktree = path.resolve('.');
    const sessionId = '550e8400-e29b-41d4-a716-446655440106';
    const { fingerprint, sessionDir: sessDir } = await initWorkspace(worktree, sessionId);
    await writeState(sessDir, makeState('COMPLETE'));

    const archiveCollisionPath = path.join(workspacesHome(), fingerprint, 'sessions', 'archive');
    await fs.writeFile(archiveCollisionPath, 'not-a-directory', 'utf-8');

    await expect(archiveSession(fingerprint, sessionId)).rejects.toThrow('ARCHIVE_FAILED');
  });

  it('verifyArchive warns but passes when checksum sidecar is missing (non-fatal)', async () => {
    const worktree = path.resolve('.');
    const sessionId = '550e8400-e29b-41d4-a716-446655440102';
    const { fingerprint, sessionDir: sessDir } = await initWorkspace(worktree, sessionId);
    await writeState(sessDir, makeState('COMPLETE'));

    // Create archive (includes sidecar)
    const archivePath = await archiveSession(fingerprint, sessionId);
    expect(archivePath).toContain('.tar.gz');

    // Delete the checksum sidecar to simulate write failure (non-fatal by design)
    const checksumPath = `${archivePath}.sha256`;
    await fs.unlink(checksumPath);

    // verifyArchive must pass (non-fatal) and emit a warning about missing sidecar
    const verification = await verifyArchive(fingerprint, sessionId);
    expect(verification.passed).toBe(true);
    const checksumWarning = verification.findings.find(
      (f: { code: string }) => f.code === 'archive_checksum_missing',
    );
    expect(checksumWarning).toBeDefined();
    expect(checksumWarning?.severity).toBe('warning');
  });

  it('archives nested directories and verifies without unexpected file findings', async () => {
    const worktree = path.resolve('.');
    const sessionId = '550e8400-e29b-41d4-a716-446655440103';
    const { fingerprint, sessionDir: sessDir } = await initWorkspace(worktree, sessionId);

    await writeState(sessDir, makeState('COMPLETE'));
    await fs.mkdir(path.join(sessDir, 'nested', 'deeper'), { recursive: true });
    await fs.writeFile(
      path.join(sessDir, 'nested', 'deeper', 'trace.json'),
      '{"ok":true}',
      'utf-8',
    );

    await archiveSession(fingerprint, sessionId);
    const verification = await verifyArchive(fingerprint, sessionId);

    expect(verification.findings.some((f) => f.code === 'unexpected_file')).toBe(false);
    expect(verification.findings.some((f) => f.code === 'missing_file')).toBe(false);
  });

  it('fails closed when redaction transform throws non-Error value', async () => {
    const worktree = path.resolve('.');
    const sessionId = '550e8400-e29b-41d4-a716-446655440104';
    const { fingerprint, sessionDir: sessDir } = await initWorkspace(worktree, sessionId);

    await writeState(sessDir, makeState('COMPLETE'));

    // Write a config file so readConfig() inside archiveSession does NOT call
    // structuredClone(DEFAULT_CONFIG) — we only want to test that the redaction
    // transform's structuredClone call is wrapped correctly.
    await fs.writeFile(
      path.join(process.env.OPENCODE_CONFIG_DIR!, 'flowguard.json'),
      JSON.stringify({ schemaVersion: 'v1' }),
      'utf-8',
    );

    const originalStructuredClone = globalThis.structuredClone;
    globalThis.structuredClone = (() => {
      throw 'clone-failed';
    }) as typeof globalThis.structuredClone;

    try {
      await expect(archiveSession(fingerprint, sessionId)).rejects.toThrow('ARCHIVE_FAILED');
    } finally {
      globalThis.structuredClone = originalStructuredClone;
    }
  });

  // fs.chmod does not enforce POSIX permissions on Windows NTFS — skip on win32
  it.skipIf(process.platform === 'win32')(
    'fails closed when redaction source read fails',
    async () => {
      const worktree = path.resolve('.');
      const sessionId = '550e8400-e29b-41d4-a716-446655440105';
      const { fingerprint, sessionDir: sessDir } = await initWorkspace(worktree, sessionId);

      // Write a VALID state (passes Zod validation) but make the review report unreadable
      await writeState(sessDir, makeState('COMPLETE'));

      const reviewPath = path.join(sessDir, 'review-report.json');
      await fs.writeFile(
        reviewPath,
        JSON.stringify({ findings: [{ message: 'sensitive' }] }),
        'utf-8',
      );
      await fs.chmod(reviewPath, 0o000);

      try {
        await expect(archiveSession(fingerprint, sessionId)).rejects.toThrow('ARCHIVE_FAILED');
      } finally {
        await fs.chmod(reviewPath, 0o644);
      }
    },
  );

  // ── P26: Sidecar regulated hardening ────────────────────────────────────────

  it('regulated + sidecar write failure → throws ARCHIVE_FAILED (fail-closed)', async () => {
    const worktree = path.resolve('.');
    const sessionId = '550e8400-e29b-41d4-a716-446655440200';
    const { fingerprint, sessionDir: sessDir } = await initWorkspace(worktree, sessionId);

    // Write a valid regulated state so archiveSessionImpl reads policyMode
    const regulatedState = makeState('COMPLETE', {
      policySnapshot: {
        ...POLICY_SNAPSHOT,
        mode: 'regulated',
        requestedMode: 'regulated',
        allowSelfApproval: false,
        requireHumanGates: true,
        audit: { ...POLICY_SNAPSHOT.audit, enableChainHash: true },
      },
    });
    await writeState(sessDir, regulatedState);

    // Pre-create a directory at the checksumPath location.
    // fs.writeFile to a directory path throws EISDIR/EPERM.
    const archiveDir = path.join(workspacesHome(), fingerprint, 'sessions', 'archive');
    const checksumPath = path.join(archiveDir, `${sessionId}.tar.gz.sha256`);
    await fs.mkdir(checksumPath, { recursive: true });

    await expect(archiveSession(fingerprint, sessionId)).rejects.toThrow('ARCHIVE_FAILED');
  });

  it('non-regulated + sidecar write failure → archive succeeds (tolerant)', async () => {
    const worktree = path.resolve('.');
    const sessionId = '550e8400-e29b-41d4-a716-446655440201';
    const { fingerprint, sessionDir: sessDir } = await initWorkspace(worktree, sessionId);

    // Write a valid team state so archiveSessionImpl reads policyMode = team
    const teamState = makeState('COMPLETE', {
      policySnapshot: {
        ...POLICY_SNAPSHOT,
        mode: 'team',
        requestedMode: 'team',
      },
    });
    await writeState(sessDir, teamState);

    // Pre-create a directory at the checksumPath location.
    const archiveDir = path.join(workspacesHome(), fingerprint, 'sessions', 'archive');
    const checksumPath = path.join(archiveDir, `${sessionId}.tar.gz.sha256`);
    await fs.mkdir(checksumPath, { recursive: true });

    // Non-regulated: sidecar failure is non-fatal, archive succeeds
    const archivePath = await archiveSession(fingerprint, sessionId);
    expect(archivePath).toContain('.tar.gz');
  });

  // ── P4a: Fail-closed — state and audit trail read failures ──────────────────

  it('BAD: archive fails when session-state.json is corrupt JSON (P4a fail-closed)', async () => {
    const worktree = path.resolve('.');
    const sessionId = '550e8400-e29b-41d4-a716-446655440300';
    const { fingerprint, sessionDir: sessDir } = await initWorkspace(worktree, sessionId);

    // Write corrupt JSON to session-state.json
    await fs.writeFile(path.join(sessDir, 'session-state.json'), '{{invalid json', 'utf-8');

    await expect(archiveSession(fingerprint, sessionId)).rejects.toThrow(PersistenceError);
  });

  it('BAD: archive fails when audit-trail.jsonl is unreadable (P4a fail-closed)', async () => {
    // On Windows, fs.chmod has no effect on read permissions.
    // Simulate unreadable audit trail by writing state + replacing audit file with a directory.
    const worktree = path.resolve('.');
    const sessionId = '550e8400-e29b-41d4-a716-446655440301';
    const { fingerprint, sessionDir: sessDir } = await initWorkspace(worktree, sessionId);

    // Write valid state so archive proceeds past state read
    await writeState(sessDir, makeState('COMPLETE'));

    // Create a directory at the audit trail path — fs.readFile on a directory throws EISDIR
    const trailPath = auditPath(sessDir);
    await fs.mkdir(trailPath, { recursive: true });

    await expect(archiveSession(fingerprint, sessionId)).rejects.toThrow(PersistenceError);
  });

  it('CORNER: archive succeeds when session-state.json does not exist (ENOENT is safe)', async () => {
    const worktree = path.resolve('.');
    const sessionId = '550e8400-e29b-41d4-a716-446655440302';
    const { fingerprint, sessionDir: sessDir } = await initWorkspace(worktree, sessionId);

    // No session-state.json written — readState returns null (ENOENT)
    // No audit-trail.jsonl — readAuditTrail returns empty (ENOENT)
    // Archive should still succeed (fresh session with no artifacts)
    const archivePath = await archiveSession(fingerprint, sessionId);
    expect(archivePath).toContain('.tar.gz');
  });

  it('CORNER: archive succeeds when audit-trail.jsonl does not exist (ENOENT is safe)', async () => {
    const worktree = path.resolve('.');
    const sessionId = '550e8400-e29b-41d4-a716-446655440303';
    const { fingerprint, sessionDir: sessDir } = await initWorkspace(worktree, sessionId);

    // Write valid state but no audit trail
    await writeState(sessDir, makeState('COMPLETE'));

    const archivePath = await archiveSession(fingerprint, sessionId);
    expect(archivePath).toContain('.tar.gz');
  });

  it('EDGE: PersistenceError from corrupt state includes error code', async () => {
    const worktree = path.resolve('.');
    const sessionId = '550e8400-e29b-41d4-a716-446655440304';
    const { fingerprint, sessionDir: sessDir } = await initWorkspace(worktree, sessionId);

    await fs.writeFile(path.join(sessDir, 'session-state.json'), '{{corrupt', 'utf-8');

    try {
      await archiveSession(fingerprint, sessionId);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PersistenceError);
      expect((err as PersistenceError).code).toBe('PARSE_FAILED');
    }
  });

  it('EDGE: PersistenceError from schema-invalid state includes error code', async () => {
    const worktree = path.resolve('.');
    const sessionId = '550e8400-e29b-41d4-a716-446655440305';
    const { fingerprint, sessionDir: sessDir } = await initWorkspace(worktree, sessionId);

    // Valid JSON but invalid schema (missing required fields)
    await fs.writeFile(
      path.join(sessDir, 'session-state.json'),
      JSON.stringify({ not_a_valid_state: true }),
      'utf-8',
    );

    try {
      await archiveSession(fingerprint, sessionId);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PersistenceError);
      expect((err as PersistenceError).code).toBe('SCHEMA_VALIDATION_FAILED');
    }
  });
});

// =============================================================================
// verifyArchive
// =============================================================================

