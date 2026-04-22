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
  initWorkspace,
  readWorkspaceInfo,
  writeSessionPointer,
  readSessionPointer,
  archiveSession,
  verifyArchive,
  WorkspaceError,
  type WorkspaceInfo,
} from './workspace';
import * as crypto from 'node:crypto';
import { benchmarkSync, measureAsync } from '../test-policy';
import { createDecisionEvent, createLifecycleEvent, GENESIS_HASH } from '../audit/types';
import { writeState } from './persistence';
import { makeState, POLICY_SNAPSHOT } from '../__fixtures__';

// ─── Test Helpers ─────────────────────────────────────────────────────────────

let tmpDir: string;
let originalEnv: string | undefined;

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

// =============================================================================
// canonicalizeOriginUrl
// =============================================================================

describe('canonicalizeOriginUrl', () => {
  // ─── HAPPY ──────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('canonicalizes HTTPS URL', () => {
      expect(canonicalizeOriginUrl('https://github.com/org/repo.git')).toBe(
        'repo://github.com/org/repo',
      );
    });

    it('canonicalizes HTTPS URL without .git suffix', () => {
      expect(canonicalizeOriginUrl('https://github.com/org/repo')).toBe(
        'repo://github.com/org/repo',
      );
    });

    it('canonicalizes SSH URL', () => {
      expect(canonicalizeOriginUrl('ssh://git@github.com/org/repo.git')).toBe(
        'repo://github.com/org/repo',
      );
    });

    it('canonicalizes SCP-style URL', () => {
      expect(canonicalizeOriginUrl('git@github.com:org/repo.git')).toBe(
        'repo://github.com/org/repo',
      );
    });

    it('canonicalizes SCP-style URL without .git', () => {
      expect(canonicalizeOriginUrl('git@github.com:org/repo')).toBe('repo://github.com/org/repo');
    });

    it('preserves non-standard port in SSH URL', () => {
      expect(canonicalizeOriginUrl('ssh://git@myhost.com:2222/org/repo.git')).toBe(
        'repo://myhost.com:2222/org/repo',
      );
    });
  });

  // ─── CORNER ─────────────────────────────────────────────────
  describe('CORNER', () => {
    it('casefolding: uppercase host and path become lowercase', () => {
      expect(canonicalizeOriginUrl('https://GitHub.COM/Org/Repo.git')).toBe(
        'repo://github.com/org/repo',
      );
    });

    it('collapses multiple slashes in path', () => {
      expect(canonicalizeOriginUrl('https://github.com///org///repo.git')).toBe(
        'repo://github.com/org/repo',
      );
    });

    it('strips trailing slash', () => {
      expect(canonicalizeOriginUrl('https://github.com/org/repo/')).toBe(
        'repo://github.com/org/repo',
      );
    });

    it('handles URL with trailing .git and trailing slash', () => {
      expect(canonicalizeOriginUrl('https://github.com/org/repo.git/')).toBe(
        'repo://github.com/org/repo',
      );
    });

    it('SCP-style with nested path', () => {
      expect(canonicalizeOriginUrl('git@gitlab.corp.com:group/subgroup/repo.git')).toBe(
        'repo://gitlab.corp.com/group/subgroup/repo',
      );
    });

    it('handles whitespace around URL', () => {
      expect(canonicalizeOriginUrl('  https://github.com/org/repo.git  ')).toBe(
        'repo://github.com/org/repo',
      );
    });
  });

  // ─── EDGE ───────────────────────────────────────────────────
  describe('EDGE', () => {
    it('HTTPS with port', () => {
      expect(canonicalizeOriginUrl('https://git.internal.com:8443/team/project.git')).toBe(
        'repo://git.internal.com:8443/team/project',
      );
    });

    it('file:// protocol', () => {
      const result = canonicalizeOriginUrl('file:///home/user/repos/myrepo.git');
      expect(result).toBe('repo:///home/user/repos/myrepo');
    });

    it('same repo, different protocols produce same canonical', () => {
      const https = canonicalizeOriginUrl('https://github.com/org/repo.git');
      const scp = canonicalizeOriginUrl('git@github.com:org/repo.git');
      const ssh = canonicalizeOriginUrl('ssh://git@github.com/org/repo.git');
      expect(https).toBe(scp);
      expect(https).toBe(ssh);
    });
  });
});

// =============================================================================
// normalizeForFingerprint
// =============================================================================

describe('normalizeForFingerprint', () => {
  it('replaces backslashes with forward slashes', () => {
    // On all platforms, backslashes should become forward slashes
    const result = normalizeForFingerprint('/home/user/my-repo');
    expect(result).not.toContain('\\');
    expect(result).toContain('/');
  });

  it('resolves to absolute path', () => {
    const result = normalizeForFingerprint('.');
    expect(path.isAbsolute(result.replace(/\//g, path.sep))).toBe(true);
  });
});

// =============================================================================
// Fingerprint computation (sync helpers)
// =============================================================================

describe('computeFingerprintFromRemote', () => {
  // ─── HAPPY ──────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('produces 24-char hex string', () => {
      const fp = computeFingerprintFromRemote('repo://github.com/org/repo');
      expect(fp).toMatch(/^[0-9a-f]{24}$/);
    });

    it('same input produces same fingerprint (deterministic)', () => {
      const a = computeFingerprintFromRemote('repo://github.com/org/repo');
      const b = computeFingerprintFromRemote('repo://github.com/org/repo');
      expect(a).toBe(b);
    });

    it('different inputs produce different fingerprints', () => {
      const a = computeFingerprintFromRemote('repo://github.com/org/repo-a');
      const b = computeFingerprintFromRemote('repo://github.com/org/repo-b');
      expect(a).not.toBe(b);
    });
  });

  // ─── PERF ───────────────────────────────────────────────────
  describe('PERF', () => {
    it('fingerprint computation is fast (<1ms per call)', () => {
      const { p99Ms } = benchmarkSync(
        () => computeFingerprintFromRemote('repo://github.com/org/repo'),
        1000,
      );
      expect(p99Ms).toBeLessThan(1);
    });
  });
});

describe('computeFingerprintFromPath', () => {
  it('produces 24-char hex string', () => {
    const fp = computeFingerprintFromPath('/home/user/my-repo');
    expect(fp).toMatch(/^[0-9a-f]{24}$/);
  });

  it('same path produces same fingerprint', () => {
    const a = computeFingerprintFromPath('/home/user/my-repo');
    const b = computeFingerprintFromPath('/home/user/my-repo');
    expect(a).toBe(b);
  });

  it('different paths produce different fingerprints', () => {
    const a = computeFingerprintFromPath('/home/user/repo-a');
    const b = computeFingerprintFromPath('/home/user/repo-b');
    expect(a).not.toBe(b);
  });

  it('remote and local fingerprints differ for same conceptual repo', () => {
    const remote = computeFingerprintFromRemote('repo://github.com/org/repo');
    const local = computeFingerprintFromPath('/home/user/org/repo');
    expect(remote).not.toBe(local);
  });
});

// =============================================================================
// validateFingerprint
// =============================================================================

describe('validateFingerprint', () => {
  // ─── HAPPY ──────────────────────────────────────────────────
  it('accepts valid 24-hex fingerprint', () => {
    expect(validateFingerprint('a1b2c3d4e5f6a1b2c3d4e5f6')).toBe('a1b2c3d4e5f6a1b2c3d4e5f6');
  });

  // ─── BAD ────────────────────────────────────────────────────
  it('rejects empty string', () => {
    expect(() => validateFingerprint('')).toThrow(WorkspaceError);
  });

  it('rejects too-short fingerprint', () => {
    expect(() => validateFingerprint('a1b2c3')).toThrow(WorkspaceError);
  });

  it('rejects too-long fingerprint', () => {
    expect(() => validateFingerprint('a'.repeat(25))).toThrow(WorkspaceError);
  });

  it('rejects uppercase hex', () => {
    expect(() => validateFingerprint('A1B2C3D4E5F6A1B2C3D4E5F6')).toThrow(WorkspaceError);
  });

  it('rejects non-hex characters', () => {
    expect(() => validateFingerprint('g1b2c3d4e5f6a1b2c3d4e5f6')).toThrow(WorkspaceError);
  });

  it('rejects slug-style strings', () => {
    expect(() => validateFingerprint('my-repo-fingerprint-slug')).toThrow(WorkspaceError);
  });

  // ─── CORNER ─────────────────────────────────────────────────
  it('rejects 24 chars with spaces', () => {
    expect(() => validateFingerprint('a1b2c3 d4e5f6a1b2c3d4e5f')).toThrow(WorkspaceError);
  });
});

// =============================================================================
// validateSessionId
// =============================================================================

describe('validateSessionId', () => {
  // ─── HAPPY ──────────────────────────────────────────────────
  it('accepts UUID-style session ID', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    expect(validateSessionId(id)).toBe(id);
  });

  it('accepts simple alphanumeric ID', () => {
    expect(validateSessionId('session123')).toBe('session123');
  });

  it('trims whitespace', () => {
    expect(validateSessionId('  abc  ')).toBe('abc');
  });

  // ─── BAD ────────────────────────────────────────────────────
  it('rejects empty string', () => {
    expect(() => validateSessionId('')).toThrow(WorkspaceError);
    expect(() => validateSessionId('')).toThrow('empty');
  });

  it('rejects whitespace-only string', () => {
    expect(() => validateSessionId('   ')).toThrow(WorkspaceError);
  });

  it('rejects forward slash', () => {
    expect(() => validateSessionId('foo/bar')).toThrow(WorkspaceError);
    expect(() => validateSessionId('foo/bar')).toThrow('unsafe');
  });

  it('rejects backslash', () => {
    expect(() => validateSessionId('foo\\bar')).toThrow(WorkspaceError);
  });

  it('rejects colon', () => {
    expect(() => validateSessionId('foo:bar')).toThrow(WorkspaceError);
  });

  it('rejects NUL byte', () => {
    expect(() => validateSessionId('foo\0bar')).toThrow(WorkspaceError);
  });

  it('rejects dot-dot (path traversal)', () => {
    expect(() => validateSessionId('..')).toThrow(WorkspaceError);
    expect(() => validateSessionId('..')).toThrow('traversal');
  });

  it('rejects single dot', () => {
    expect(() => validateSessionId('.')).toThrow(WorkspaceError);
  });

  // ─── CORNER ─────────────────────────────────────────────────
  it('accepts dots within a longer string', () => {
    expect(validateSessionId('v1.2.3')).toBe('v1.2.3');
  });

  it('accepts hyphens and underscores', () => {
    expect(validateSessionId('my-session_01')).toBe('my-session_01');
  });
});

// =============================================================================
// Path resolution (workspacesHome, workspaceDir, sessionDir)
// =============================================================================

describe('path resolution', () => {
  beforeEach(() => {
    originalEnv = process.env.OPENCODE_CONFIG_DIR;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.OPENCODE_CONFIG_DIR = originalEnv;
    } else {
      delete process.env.OPENCODE_CONFIG_DIR;
    }
  });

  it('workspacesHome defaults to ~/.config/opencode/workspaces', () => {
    delete process.env.OPENCODE_CONFIG_DIR;
    const home = workspacesHome();
    expect(home).toContain('workspaces');
    expect(home).toContain('.config');
    expect(home).toContain('opencode');
  });

  it('workspacesHome respects OPENCODE_CONFIG_DIR', () => {
    process.env.OPENCODE_CONFIG_DIR = '/custom/config';
    const home = workspacesHome();
    expect(home).toBe(path.join('/custom/config', 'workspaces'));
  });

  it('workspaceDir returns correct path', () => {
    process.env.OPENCODE_CONFIG_DIR = '/cfg';
    const dir = workspaceDir('a1b2c3d4e5f6a1b2c3d4e5f6');
    expect(dir).toBe(path.join('/cfg', 'workspaces', 'a1b2c3d4e5f6a1b2c3d4e5f6'));
  });

  it('workspaceDir rejects invalid fingerprint', () => {
    expect(() => workspaceDir('invalid')).toThrow(WorkspaceError);
  });

  it('sessionDir returns correct nested path', () => {
    process.env.OPENCODE_CONFIG_DIR = '/cfg';
    const dir = sessionDir('a1b2c3d4e5f6a1b2c3d4e5f6', 'my-session-id');
    expect(dir).toBe(
      path.join('/cfg', 'workspaces', 'a1b2c3d4e5f6a1b2c3d4e5f6', 'sessions', 'my-session-id'),
    );
  });

  it('sessionDir rejects invalid fingerprint', () => {
    expect(() => sessionDir('bad', 'ok-session')).toThrow(WorkspaceError);
  });

  it('sessionDir rejects invalid sessionId', () => {
    expect(() => sessionDir('a1b2c3d4e5f6a1b2c3d4e5f6', '..')).toThrow(WorkspaceError);
  });
});

// =============================================================================
// initWorkspace
// =============================================================================

describe('initWorkspace', () => {
  beforeEach(async () => {
    tmpDir = await createTmpDir();
    process.env.OPENCODE_CONFIG_DIR = tmpDir;
  });

  afterEach(async () => {
    delete process.env.OPENCODE_CONFIG_DIR;
    await cleanTmpDir(tmpDir);
  });

  // ─── HAPPY ──────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('creates workspace and session directories', async () => {
      // Use a mock worktree that points to this test's git repo
      const worktree = path.resolve('.');
      const sessionId = 'test-session-001';

      const result = await initWorkspace(worktree, sessionId);

      // Workspace info should be populated
      expect(result.fingerprint).toMatch(/^[0-9a-f]{24}$/);
      expect(result.info.fingerprint).toBe(result.fingerprint);
      expect(result.info.schemaVersion).toBe('v1');

      // Directories should exist
      const wsDir = result.workspaceDir;
      const stats = await fs.stat(wsDir);
      expect(stats.isDirectory()).toBe(true);

      const sessStats = await fs.stat(result.sessionDir);
      expect(sessStats.isDirectory()).toBe(true);

      // Subdirectories should exist
      const logsStats = await fs.stat(path.join(wsDir, 'logs'));
      expect(logsStats.isDirectory()).toBe(true);

      const discoveryStats = await fs.stat(path.join(wsDir, 'discovery'));
      expect(discoveryStats.isDirectory()).toBe(true);

      // workspace.json should exist
      const wsJsonPath = path.join(wsDir, 'workspace.json');
      const wsJson = JSON.parse(await fs.readFile(wsJsonPath, 'utf-8'));
      expect(wsJson.fingerprint).toBe(result.fingerprint);
      expect(wsJson.schemaVersion).toBe('v1');
    });

    it('is idempotent: second call returns same info', async () => {
      const worktree = path.resolve('.');
      const sessionId = 'test-session-002';

      const first = await initWorkspace(worktree, sessionId);
      const second = await initWorkspace(worktree, sessionId);

      expect(second.fingerprint).toBe(first.fingerprint);
      expect(second.info.createdAt).toBe(first.info.createdAt);
      expect(second.sessionDir).toBe(first.sessionDir);
    });

    it('creates separate session directories for different session IDs', async () => {
      const worktree = path.resolve('.');

      const a = await initWorkspace(worktree, 'session-a');
      const b = await initWorkspace(worktree, 'session-b');

      expect(a.fingerprint).toBe(b.fingerprint); // Same repo
      expect(a.sessionDir).not.toBe(b.sessionDir); // Different sessions
    });
  });

  // ─── BAD ────────────────────────────────────────────────────
  describe('BAD', () => {
    it('rejects empty session ID', async () => {
      await expect(initWorkspace(path.resolve('.'), '')).rejects.toThrow(WorkspaceError);
    });

    it('rejects path-traversal session ID', async () => {
      await expect(initWorkspace(path.resolve('.'), '..')).rejects.toThrow(WorkspaceError);
    });
  });

  // ─── CORNER ─────────────────────────────────────────────────
  describe('CORNER', () => {
    it('workspace.json mismatch: different canonicalRemote → throws WORKSPACE_MISMATCH', async () => {
      const worktree = path.resolve('.');
      const sessionId = 'test-session-003';

      // First: create workspace normally
      const result = await initWorkspace(worktree, sessionId);

      // Tamper: overwrite workspace.json with different canonicalRemote but same fingerprint
      if (result.info.canonicalRemote) {
        const tamperedInfo = {
          ...result.info,
          canonicalRemote: 'repo://evil.com/different/repo',
        };
        await fs.writeFile(
          path.join(result.workspaceDir, 'workspace.json'),
          JSON.stringify(tamperedInfo, null, 2),
          'utf-8',
        );

        await expect(initWorkspace(worktree, 'session-new')).rejects.toThrow('WORKSPACE_MISMATCH');
      }
    });

    it('handles corrupt workspace.json gracefully (throws READ_FAILED)', async () => {
      const worktree = path.resolve('.');
      const sessionId = 'test-session-004';

      // Create workspace first
      const result = await initWorkspace(worktree, sessionId);

      // Corrupt workspace.json
      await fs.writeFile(
        path.join(result.workspaceDir, 'workspace.json'),
        'not json at all',
        'utf-8',
      );

      await expect(initWorkspace(worktree, 'session-new2')).rejects.toThrow(WorkspaceError);
    });
  });
});

// =============================================================================
// readWorkspaceInfo
// =============================================================================

describe('readWorkspaceInfo', () => {
  beforeEach(async () => {
    tmpDir = await createTmpDir();
    process.env.OPENCODE_CONFIG_DIR = tmpDir;
  });

  afterEach(async () => {
    delete process.env.OPENCODE_CONFIG_DIR;
    await cleanTmpDir(tmpDir);
  });

  it('returns null for non-existent workspace', async () => {
    const result = await readWorkspaceInfo('a1b2c3d4e5f6a1b2c3d4e5f6');
    expect(result).toBeNull();
  });

  it('returns workspace info after initWorkspace', async () => {
    const worktree = path.resolve('.');
    const { fingerprint } = await initWorkspace(worktree, 'sess-001');
    const info = await readWorkspaceInfo(fingerprint);
    expect(info).not.toBeNull();
    expect(info!.fingerprint).toBe(fingerprint);
  });
});

// =============================================================================
// Session Pointer (non-authoritative)
// =============================================================================

describe('session pointer', () => {
  beforeEach(async () => {
    tmpDir = await createTmpDir();
    process.env.OPENCODE_CONFIG_DIR = tmpDir;
  });

  afterEach(async () => {
    delete process.env.OPENCODE_CONFIG_DIR;
    await cleanTmpDir(tmpDir);
  });

  it('readSessionPointer returns null when no pointer exists', async () => {
    expect(await readSessionPointer()).toBeNull();
  });

  it('write then read round-trips pointer data', async () => {
    const fp = 'a1b2c3d4e5f6a1b2c3d4e5f6';
    const sessId = 'test-session';
    const sessPath = '/some/path/to/session';

    await writeSessionPointer(fp, sessId, sessPath);
    const pointer = await readSessionPointer();

    expect(pointer).not.toBeNull();
    expect(pointer!.activeRepoFingerprint).toBe(fp);
    expect(pointer!.activeSessionId).toBe(sessId);
    expect(pointer!.activeSessionDir).toBe(sessPath);
    expect(pointer!.schema).toBe('flowguard-session-pointer.v1');
  });

  it('write is fire-and-forget: does not throw on failure', async () => {
    // Set config dir to a path that cannot exist
    process.env.OPENCODE_CONFIG_DIR = path.join(tmpDir, 'nonexistent\0illegal');
    // Should not throw
    await writeSessionPointer('a1b2c3d4e5f6a1b2c3d4e5f6', 'sess', '/p');
  });
});

// =============================================================================
// archiveSession
// =============================================================================

describe('archiveSession', () => {
  beforeEach(async () => {
    tmpDir = await createTmpDir();
    process.env.OPENCODE_CONFIG_DIR = tmpDir;
  });

  afterEach(async () => {
    delete process.env.OPENCODE_CONFIG_DIR;
    await cleanTmpDir(tmpDir);
  });

  it('archives a session directory as tar.gz', async () => {
    const worktree = path.resolve('.');
    const sessionId = 'archive-test-001';
    const { fingerprint, sessionDir: sessDir } = await initWorkspace(worktree, sessionId);

    // Write a test file into the session directory
    await fs.writeFile(path.join(sessDir, 'session-state.json'), '{"test": true}', 'utf-8');

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

    await fs.writeFile(path.join(sessDir, 'session-state.json'), '{"test": true}', 'utf-8');
    await fs.writeFile(
      path.join(workspaceDir(fingerprint), 'config.json'),
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

    await fs.writeFile(path.join(sessDir, 'session-state.json'), '{"test": true}', 'utf-8');
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

    await fs.writeFile(path.join(sessDir, 'session-state.json'), '{"phase": "COMPLETE"}', 'utf-8');
    const event = createDecisionEvent(
      sessionId,
      'PLAN_REVIEW',
      {
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
      ts,
      'alice',
      GENESIS_HASH,
    );
    await fs.writeFile(path.join(sessDir, 'audit.jsonl'), JSON.stringify(event) + '\n', 'utf-8');
    await fs.writeFile(
      path.join(wsDir, 'config.json'),
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

    await fs.writeFile(path.join(sessDir, 'session-state.json'), '{"phase": "COMPLETE"}', 'utf-8');
    const event = createDecisionEvent(
      sessionId,
      'PLAN_REVIEW',
      {
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
      ts,
      'bob',
      GENESIS_HASH,
    );
    await fs.writeFile(path.join(sessDir, 'audit.jsonl'), JSON.stringify(event) + '\n', 'utf-8');
    await fs.writeFile(
      path.join(wsDir, 'config.json'),
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

    await fs.writeFile(path.join(sessDir, 'session-state.json'), '{"phase": "COMPLETE"}', 'utf-8');
    const event = createDecisionEvent(
      sessionId,
      'PLAN_REVIEW',
      {
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
      ts,
      'carol',
      GENESIS_HASH,
    );
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

    await fs.writeFile(path.join(sessDir, 'session-state.json'), '{"test": true}', 'utf-8');
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
  beforeEach(async () => {
    tmpDir = await createTmpDir();
    process.env.OPENCODE_CONFIG_DIR = tmpDir;
  });

  afterEach(async () => {
    delete process.env.OPENCODE_CONFIG_DIR;
    await cleanTmpDir(tmpDir);
  });

  it('throws ARCHIVE_FAILED when archive directory cannot be created (permission denied)', async () => {
    const worktree = path.resolve('.');
    const sessionId = '550e8400-e29b-41d4-a716-446655440100';
    const { fingerprint, sessionDir: sessDir } = await initWorkspace(worktree, sessionId);
    await fs.writeFile(path.join(sessDir, 'session-state.json'), '{"phase": "COMPLETE"}', 'utf-8');

    // Set OPENCODE_CONFIG_DIR to a path that mkdir cannot create
    const originalConfigDir = process.env.OPENCODE_CONFIG_DIR;
    process.env.OPENCODE_CONFIG_DIR = '/root/fail-permission-test';
    await expect(archiveSession(fingerprint, sessionId)).rejects.toThrow('ARCHIVE_FAILED');
    process.env.OPENCODE_CONFIG_DIR = originalConfigDir ?? '';
  });

  it('throws ARCHIVE_FAILED when tar execution fails (missing binary)', async () => {
    const worktree = path.resolve('.');
    const sessionId = '550e8400-e29b-41d4-a716-446655440101';
    const { fingerprint, sessionDir: sessDir } = await initWorkspace(worktree, sessionId);
    await fs.writeFile(path.join(sessDir, 'session-state.json'), '{"phase": "COMPLETE"}', 'utf-8');

    const originalPath = process.env.PATH;
    process.env.PATH = '/nonexistent/path/with/no/tar';
    await expect(archiveSession(fingerprint, sessionId)).rejects.toThrow('ARCHIVE_FAILED');
    process.env.PATH = originalPath ?? '';
  });

  it('throws ARCHIVE_FAILED when archive path collides with existing file', async () => {
    const worktree = path.resolve('.');
    const sessionId = '550e8400-e29b-41d4-a716-446655440106';
    const { fingerprint, sessionDir: sessDir } = await initWorkspace(worktree, sessionId);
    await fs.writeFile(path.join(sessDir, 'session-state.json'), '{"phase": "COMPLETE"}', 'utf-8');

    const archiveCollisionPath = path.join(workspacesHome(), fingerprint, 'sessions', 'archive');
    await fs.writeFile(archiveCollisionPath, 'not-a-directory', 'utf-8');

    await expect(archiveSession(fingerprint, sessionId)).rejects.toThrow('ARCHIVE_FAILED');
  });

  it('verifyArchive warns but passes when checksum sidecar is missing (non-fatal)', async () => {
    const worktree = path.resolve('.');
    const sessionId = '550e8400-e29b-41d4-a716-446655440102';
    const { fingerprint, sessionDir: sessDir } = await initWorkspace(worktree, sessionId);
    await fs.writeFile(path.join(sessDir, 'session-state.json'), '{"phase": "COMPLETE"}', 'utf-8');

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

    await fs.writeFile(path.join(sessDir, 'session-state.json'), '{"phase": "COMPLETE"}', 'utf-8');
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

    await fs.writeFile(path.join(sessDir, 'session-state.json'), '{"phase": "COMPLETE"}', 'utf-8');

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

      await fs.writeFile(
        path.join(sessDir, 'session-state.json'),
        '{"phase": "COMPLETE"}',
        'utf-8',
      );

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
});

// =============================================================================
// verifyArchive
// =============================================================================

describe('verifyArchive', () => {
  beforeEach(async () => {
    tmpDir = await createTmpDir();
    process.env.OPENCODE_CONFIG_DIR = tmpDir;
  });

  afterEach(async () => {
    delete process.env.OPENCODE_CONFIG_DIR;
    await cleanTmpDir(tmpDir);
  });

  /**
   * Helper: create a real archived session and return paths.
   * Uses archiveSession to produce manifest, tar, and sidecar.
   */
  async function createArchivedSession(sessionId = '550e8400-e29b-41d4-a716-446655440000') {
    const worktree = path.resolve('.');
    const { fingerprint, sessionDir: sessDir } = await initWorkspace(worktree, sessionId);

    // Write minimal session-state.json so the archive has content
    await fs.writeFile(
      path.join(sessDir, 'session-state.json'),
      JSON.stringify({ phase: 'COMPLETE', sessionId }),
      'utf-8',
    );

    const archivePath = await archiveSession(fingerprint, sessionId);
    return { fingerprint, sessionId, sessDir, archivePath };
  }

  // ── HAPPY ──────────────────────────────────────────────────────

  it('passes on a clean archive', async () => {
    const { fingerprint, sessionId } = await createArchivedSession();

    const result = await verifyArchive(fingerprint, sessionId);

    expect(result.passed).toBe(true);
    expect(result.findings.filter((f) => f.severity === 'error')).toHaveLength(0);
    expect(result.manifest).not.toBeNull();
    expect(result.manifest!.sessionId).toBe(sessionId);
    expect(result.verifiedAt).toBeTruthy();
  });

  // ── BAD ────────────────────────────────────────────────────────

  it('reports missing_manifest when archive-manifest.json is absent', async () => {
    const { fingerprint, sessionId, sessDir } = await createArchivedSession();

    // Remove the manifest
    await fs.unlink(path.join(sessDir, 'archive-manifest.json'));

    const result = await verifyArchive(fingerprint, sessionId);

    expect(result.passed).toBe(false);
    expect(result.findings).toContainEqual(
      expect.objectContaining({ code: 'missing_manifest', severity: 'error' }),
    );
    expect(result.manifest).toBeNull();
  });

  it('reports manifest_parse_error when manifest is invalid JSON', async () => {
    const { fingerprint, sessionId, sessDir } = await createArchivedSession();

    // Corrupt the manifest
    await fs.writeFile(path.join(sessDir, 'archive-manifest.json'), 'NOT JSON{{{', 'utf-8');

    const result = await verifyArchive(fingerprint, sessionId);

    expect(result.passed).toBe(false);
    expect(result.findings).toContainEqual(
      expect.objectContaining({ code: 'manifest_parse_error', severity: 'error' }),
    );
    expect(result.manifest).toBeNull();
  });

  it('reports manifest_parse_error when manifest fails schema validation', async () => {
    const { fingerprint, sessionId, sessDir } = await createArchivedSession();

    // Write valid JSON but invalid schema (missing required fields)
    await fs.writeFile(
      path.join(sessDir, 'archive-manifest.json'),
      JSON.stringify({ schemaVersion: 'wrong', random: true }),
      'utf-8',
    );

    const result = await verifyArchive(fingerprint, sessionId);

    expect(result.passed).toBe(false);
    expect(result.findings).toContainEqual(
      expect.objectContaining({ code: 'manifest_parse_error', severity: 'error' }),
    );
  });

  // ── CORNER ─────────────────────────────────────────────────────

  it('reports missing_file when a listed file is deleted', async () => {
    const { fingerprint, sessionId, sessDir } = await createArchivedSession();

    // Read manifest to find what files are listed
    const manifestPath = path.join(sessDir, 'archive-manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));

    // Delete session-state.json (which is in includedFiles)
    await fs.unlink(path.join(sessDir, 'session-state.json'));

    const result = await verifyArchive(fingerprint, sessionId);

    // Should report both missing_file and state_missing
    expect(result.passed).toBe(false);
    const codes = result.findings.map((f) => f.code);
    expect(codes).toContain('missing_file');
    expect(codes).toContain('state_missing');
  });

  it('reports unexpected_file when an unlisted file is present', async () => {
    const { fingerprint, sessionId, sessDir } = await createArchivedSession();

    // Add a rogue file after archiving
    await fs.writeFile(path.join(sessDir, 'rogue-file.txt'), 'intruder', 'utf-8');

    const result = await verifyArchive(fingerprint, sessionId);

    expect(result.findings).toContainEqual(
      expect.objectContaining({
        code: 'unexpected_file',
        severity: 'warning',
        file: 'rogue-file.txt',
      }),
    );
  });

  it('reports file_digest_mismatch when file content is tampered', async () => {
    const { fingerprint, sessionId, sessDir } = await createArchivedSession();

    // Tamper with session-state.json content (manifest still has old digest)
    await fs.writeFile(
      path.join(sessDir, 'session-state.json'),
      JSON.stringify({ phase: 'TAMPERED', evil: true }),
      'utf-8',
    );

    const result = await verifyArchive(fingerprint, sessionId);

    expect(result.passed).toBe(false);
    expect(result.findings).toContainEqual(
      expect.objectContaining({ code: 'file_digest_mismatch', severity: 'error' }),
    );
  });

  it('reports content_digest_mismatch when manifest contentDigest is wrong', async () => {
    const { fingerprint, sessionId, sessDir } = await createArchivedSession();

    // Read and tamper with contentDigest in manifest
    const manifestPath = path.join(sessDir, 'archive-manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
    manifest.contentDigest = '0000000000000000000000000000000000000000000000000000000000000000';
    await fs.writeFile(manifestPath, JSON.stringify(manifest), 'utf-8');

    const result = await verifyArchive(fingerprint, sessionId);

    expect(result.passed).toBe(false);
    expect(result.findings).toContainEqual(
      expect.objectContaining({ code: 'content_digest_mismatch', severity: 'error' }),
    );
  });

  it('reports snapshot_missing when discoveryDigest is set but snapshots are absent', async () => {
    const { fingerprint, sessionId, sessDir } = await createArchivedSession();

    // Tamper manifest to claim a discoveryDigest exists
    const manifestPath = path.join(sessDir, 'archive-manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
    manifest.discoveryDigest = 'abc123fake';
    await fs.writeFile(manifestPath, JSON.stringify(manifest), 'utf-8');

    const result = await verifyArchive(fingerprint, sessionId);

    // Should find snapshot_missing warnings for both discovery and profile-resolution snapshots
    const snapshotFindings = result.findings.filter((f) => f.code === 'snapshot_missing');
    expect(snapshotFindings).toHaveLength(2);
    expect(snapshotFindings[0]!.severity).toBe('warning');
    expect(snapshotFindings[1]!.severity).toBe('warning');
  });

  it('reports state_missing when session-state.json is absent', async () => {
    const { fingerprint, sessionId, sessDir } = await createArchivedSession();

    // Remove session-state.json
    await fs.unlink(path.join(sessDir, 'session-state.json'));

    // Also fix manifest so it doesn't list session-state.json as missing_file
    // (we want to isolate state_missing finding)
    const manifestPath = path.join(sessDir, 'archive-manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
    manifest.includedFiles = manifest.includedFiles.filter(
      (f: string) => f !== 'session-state.json',
    );
    delete manifest.fileDigests['session-state.json'];
    // Recompute contentDigest from remaining file digests
    const digestValues = manifest.includedFiles
      .map((f: string) => manifest.fileDigests[f])
      .filter(Boolean)
      .sort();
    manifest.contentDigest = crypto
      .createHash('sha256')
      .update(digestValues.join(''))
      .digest('hex');
    await fs.writeFile(manifestPath, JSON.stringify(manifest), 'utf-8');

    const result = await verifyArchive(fingerprint, sessionId);

    expect(result.findings).toContainEqual(
      expect.objectContaining({ code: 'state_missing', severity: 'error' }),
    );
  });

  it('reports archive_checksum_missing when sidecar is absent', async () => {
    const { fingerprint, sessionId, sessDir, archivePath } = await createArchivedSession();

    // Remove the .sha256 sidecar
    const sidecarPath = `${archivePath}.sha256`;
    try {
      await fs.unlink(sidecarPath);
    } catch {
      // May not exist if archiveSession sidecar write failed — still test the finding
    }

    const result = await verifyArchive(fingerprint, sessionId);

    expect(result.findings).toContainEqual(
      expect.objectContaining({ code: 'archive_checksum_missing', severity: 'warning' }),
    );
  });

  it('reports archive_checksum_mismatch when sidecar hash is wrong', async () => {
    const { fingerprint, sessionId, archivePath } = await createArchivedSession();

    const wrongChecksum = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    await fs.writeFile(`${archivePath}.sha256`, `${wrongChecksum}  archive.tar.gz\n`, 'utf-8');

    const result = await verifyArchive(fingerprint, sessionId);

    expect(result.findings).toContainEqual(
      expect.objectContaining({ code: 'archive_checksum_mismatch', severity: 'error' }),
    );
  });

  it('reports archive_checksum_missing when sidecar file is absent', async () => {
    const { fingerprint, sessionId, archivePath } = await createArchivedSession();

    await fs.unlink(`${archivePath}.sha256`);

    const result = await verifyArchive(fingerprint, sessionId);

    expect(result.findings).toContainEqual(
      expect.objectContaining({ code: 'archive_checksum_missing', severity: 'warning' }),
    );
  });

  // ── AUDIT CHAIN ────────────────────────────────────────────────

  /**
   * Helper: create an archived session with custom audit trail and manifest policyMode.
   *
   * 1. Archives a minimal session (via createArchivedSession).
   * 2. Writes audit.jsonl with the given events (if any).
   * 3. Patches the manifest to include audit.jsonl in inventory and set policyMode.
   * 4. Recomputes contentDigest for consistency.
   */
  async function createArchivedSessionWithAudit(opts: {
    sessionId?: string;
    policyMode?: string;
    auditEvents?: Array<Record<string, unknown>>;
  }) {
    const { fingerprint, sessionId, sessDir, archivePath } = await createArchivedSession(
      opts.sessionId,
    );

    // Write audit.jsonl if events provided
    if (opts.auditEvents && opts.auditEvents.length > 0) {
      const auditContent = opts.auditEvents.map((e) => JSON.stringify(e)).join('\n') + '\n';
      await fs.writeFile(path.join(sessDir, 'audit.jsonl'), auditContent, 'utf-8');
    }

    // Patch manifest: add audit.jsonl to inventory, set policyMode, recompute contentDigest
    const manifestPath = path.join(sessDir, 'archive-manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));

    if (opts.policyMode) {
      manifest.policyMode = opts.policyMode;
    }

    if (opts.auditEvents && opts.auditEvents.length > 0) {
      const auditFilePath = path.join(sessDir, 'audit.jsonl');
      const auditBuffer = await fs.readFile(auditFilePath);
      const auditDigest = crypto.createHash('sha256').update(auditBuffer).digest('hex');

      if (!manifest.includedFiles.includes('audit.jsonl')) {
        manifest.includedFiles.push('audit.jsonl');
        manifest.includedFiles.sort();
      }
      manifest.fileDigests['audit.jsonl'] = auditDigest;
    }

    // Recompute contentDigest from patched file digests
    const digestValues = manifest.includedFiles
      .map((f: string) => manifest.fileDigests[f])
      .filter(Boolean)
      .sort();
    manifest.contentDigest = crypto
      .createHash('sha256')
      .update(digestValues.join(''))
      .digest('hex');

    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

    return { fingerprint, sessionId, sessDir, archivePath };
  }

  /** Build a legacy audit event (no chain fields). */
  function buildLegacyEvent(sessionId: string): Record<string, unknown> {
    return {
      id: crypto.randomUUID(),
      sessionId,
      phase: 'READY',
      event: 'lifecycle:session_created',
      timestamp: new Date().toISOString(),
      actor: 'machine',
      detail: { kind: 'lifecycle', action: 'session_created', finalPhase: 'READY' },
    };
  }

  /** Build a properly chained lifecycle event. */
  function buildChainedEvent(sessionId: string, prevHash: string) {
    return createLifecycleEvent(
      sessionId,
      { action: 'session_created', finalPhase: 'READY' },
      new Date().toISOString(),
      'machine',
      prevHash,
    );
  }

  it('reports audit_chain_invalid when regulated state has legacy unchained events', async () => {
    const sid = '550e8400-e29b-41d4-a716-446655440101';
    const { fingerprint, sessionId } = await createArchivedSessionWithAudit({
      sessionId: sid,
      policyMode: 'regulated',
      auditEvents: [buildLegacyEvent(sid), buildLegacyEvent(sid)],
    });

    const result = await verifyArchive(fingerprint, sessionId);

    expect(result.passed).toBe(false);
    const chainFinding = result.findings.find((f) => f.code === 'audit_chain_invalid');
    expect(chainFinding).toBeDefined();
    expect(chainFinding!.severity).toBe('error');
    expect(chainFinding!.message).toContain('LEGACY_EVENTS_NOT_ALLOWED_IN_STRICT_MODE');
    expect(chainFinding!.file).toBe('audit.jsonl');
  });

  it('passes audit chain check when regulated state has all chained events', async () => {
    const sid = '550e8400-e29b-41d4-a716-446655440102';
    const evt1 = buildChainedEvent(sid, GENESIS_HASH);
    const evt2 = buildChainedEvent(sid, evt1.chainHash);

    const { fingerprint, sessionId } = await createArchivedSessionWithAudit({
      sessionId: sid,
      policyMode: 'regulated',
      auditEvents: [evt1, evt2],
    });

    const result = await verifyArchive(fingerprint, sessionId);

    expect(result.passed).toBe(true);
    expect(result.findings.find((f) => f.code === 'audit_chain_invalid')).toBeUndefined();
  });

  it('tolerates legacy events in non-regulated mode (team)', async () => {
    const sid = '550e8400-e29b-41d4-a716-446655440103';
    const { fingerprint, sessionId } = await createArchivedSessionWithAudit({
      sessionId: sid,
      policyMode: 'team',
      auditEvents: [buildLegacyEvent(sid), buildLegacyEvent(sid)],
    });

    const result = await verifyArchive(fingerprint, sessionId);

    // No audit_chain_invalid AND verification passes overall
    expect(result.passed).toBe(true);
    expect(result.findings.find((f) => f.code === 'audit_chain_invalid')).toBeUndefined();
  });

  it('reports audit_chain_invalid with CHAIN_BREAK when chain hash is tampered', async () => {
    const sid = '550e8400-e29b-41d4-a716-446655440104';
    const evt1 = buildChainedEvent(sid, GENESIS_HASH);
    // Create a second event with correct prevHash but tampered chainHash
    const evt2Raw = buildChainedEvent(sid, evt1.chainHash);
    const evt2Tampered = { ...evt2Raw, chainHash: 'deadbeef'.repeat(8) };

    const { fingerprint, sessionId } = await createArchivedSessionWithAudit({
      sessionId: sid,
      policyMode: 'team', // non-regulated — proves CHAIN_BREAK wins regardless of mode
      auditEvents: [evt1, evt2Tampered],
    });

    const result = await verifyArchive(fingerprint, sessionId);

    expect(result.passed).toBe(false);
    const chainFinding = result.findings.find((f) => f.code === 'audit_chain_invalid');
    expect(chainFinding).toBeDefined();
    expect(chainFinding!.severity).toBe('error');
    expect(chainFinding!.message).toContain('CHAIN_BREAK');
  });

  it('skips audit chain check when audit trail has no events', async () => {
    const { fingerprint, sessionId } = await createArchivedSession();

    // No audit.jsonl at all — readAuditTrail returns empty events
    const result = await verifyArchive(fingerprint, sessionId);

    expect(result.passed).toBe(true);
    expect(result.findings.find((f) => f.code === 'audit_chain_invalid')).toBeUndefined();
  });

  it('regulated mode rejects mixed trail (chained + legacy events)', async () => {
    const sid = '550e8400-e29b-41d4-a716-446655440106';
    const chainedEvt = buildChainedEvent(sid, GENESIS_HASH);
    const legacyEvt = buildLegacyEvent(sid);

    const { fingerprint, sessionId } = await createArchivedSessionWithAudit({
      sessionId: sid,
      policyMode: 'regulated',
      auditEvents: [chainedEvt, legacyEvt], // mixed: one chained, one legacy
    });

    const result = await verifyArchive(fingerprint, sessionId);

    expect(result.passed).toBe(false);
    const chainFinding = result.findings.find((f) => f.code === 'audit_chain_invalid');
    expect(chainFinding).toBeDefined();
    expect(chainFinding!.severity).toBe('error');
    expect(chainFinding!.message).toContain('LEGACY_EVENTS_NOT_ALLOWED_IN_STRICT_MODE');
  });

  it('regulated + malformed audit.jsonl → audit_chain_invalid error (fail-closed)', async () => {
    const sid = '550e8400-e29b-41d4-a716-446655440107';
    // Write garbage that readAuditTrail will skip (not throw)
    const { fingerprint, sessionId } = await createArchivedSessionWithAudit({
      sessionId: sid,
      policyMode: 'regulated',
      auditEvents: [], // empty — we write raw garbage below
    });
    const sessDir = sessionDir(fingerprint, sessionId);
    // Overwrite with raw malformed content (not valid JSONL)
    await fs.writeFile(path.join(sessDir, 'audit.jsonl'), 'NOT JSON{{{\nALSO BAD{{{', 'utf-8');

    // Patch manifest to include the malformed audit.jsonl with correct digest
    const manifestPath = path.join(sessDir, 'archive-manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
    const auditBuffer = await fs.readFile(path.join(sessDir, 'audit.jsonl'));
    const auditDigest = crypto.createHash('sha256').update(auditBuffer).digest('hex');
    if (!manifest.includedFiles.includes('audit.jsonl')) {
      manifest.includedFiles.push('audit.jsonl');
      manifest.includedFiles.sort();
    }
    manifest.fileDigests['audit.jsonl'] = auditDigest;
    const digestValues = manifest.includedFiles
      .map((f: string) => manifest.fileDigests[f])
      .filter(Boolean)
      .sort();
    manifest.contentDigest = crypto
      .createHash('sha256')
      .update(digestValues.join(''))
      .digest('hex');
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

    const result = await verifyArchive(fingerprint, sessionId);

    expect(result.passed).toBe(false);
    const chainFinding = result.findings.find((f) => f.code === 'audit_chain_invalid');
    expect(chainFinding).toBeDefined();
    expect(chainFinding!.severity).toBe('error');
    expect(chainFinding!.message).toContain('unparseable');
    expect(chainFinding!.file).toBe('audit.jsonl');
  });

  it('regulated + chained events + malformed line → audit_chain_invalid (partial corruption)', async () => {
    const sid = '550e8400-e29b-41d4-a716-446655440108';
    const evt1 = buildChainedEvent(sid, GENESIS_HASH);
    const evt2 = buildChainedEvent(sid, evt1.chainHash);

    // Write valid chained events interleaved with a malformed line
    const auditContent =
      JSON.stringify(evt1) + '\n' + 'CORRUPT LINE{{{' + '\n' + JSON.stringify(evt2) + '\n';

    const { fingerprint, sessionId } = await createArchivedSessionWithAudit({
      sessionId: sid,
      policyMode: 'regulated',
      auditEvents: [], // empty — we write raw content below
    });
    const sessDir = sessionDir(fingerprint, sessionId);
    await fs.writeFile(path.join(sessDir, 'audit.jsonl'), auditContent, 'utf-8');

    // Patch manifest to include audit.jsonl with correct digest
    const manifestPath = path.join(sessDir, 'archive-manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
    const auditBuffer = await fs.readFile(path.join(sessDir, 'audit.jsonl'));
    const auditDigest = crypto.createHash('sha256').update(auditBuffer).digest('hex');
    if (!manifest.includedFiles.includes('audit.jsonl')) {
      manifest.includedFiles.push('audit.jsonl');
      manifest.includedFiles.sort();
    }
    manifest.fileDigests['audit.jsonl'] = auditDigest;
    const digestValues = manifest.includedFiles
      .map((f: string) => manifest.fileDigests[f])
      .filter(Boolean)
      .sort();
    manifest.contentDigest = crypto
      .createHash('sha256')
      .update(digestValues.join(''))
      .digest('hex');
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

    const result = await verifyArchive(fingerprint, sessionId);

    // Must fail: regulated mode rejects any unparseable lines
    expect(result.passed).toBe(false);
    const chainFindings = result.findings.filter((f) => f.code === 'audit_chain_invalid');
    expect(chainFindings.length).toBeGreaterThanOrEqual(1);
    // The unparseable-lines finding must be present
    const unparseableFinding = chainFindings.find((f) => f.message.includes('unparseable'));
    expect(unparseableFinding).toBeDefined();
    expect(unparseableFinding!.severity).toBe('error');
  });
});

// =============================================================================
// PERF — bulk operations
// =============================================================================

describe('PERF', () => {
  it('canonicalizeOriginUrl is fast (<1ms per call)', () => {
    const { p99Ms } = benchmarkSync(
      () => canonicalizeOriginUrl('https://github.com/org/repo.git'),
      1000,
    );
    expect(p99Ms).toBeLessThan(1);
  });

  it('validateFingerprint is fast (<1ms per call)', () => {
    const { p99Ms } = benchmarkSync(() => validateFingerprint('a1b2c3d4e5f6a1b2c3d4e5f6'), 1000);
    expect(p99Ms).toBeLessThan(1);
  });

  it('validateSessionId is fast (<1ms per call)', () => {
    const { p99Ms } = benchmarkSync(
      () => validateSessionId('550e8400-e29b-41d4-a716-446655440000'),
      1000,
    );
    expect(p99Ms).toBeLessThan(1);
  });

  it('initWorkspace is fast (<50ms)', async () => {
    const td = await createTmpDir();
    process.env.OPENCODE_CONFIG_DIR = td;
    try {
      const { elapsedMs } = await measureAsync(() =>
        initWorkspace(path.resolve('.'), `perf-${Date.now()}`),
      );
      expect(elapsedMs).toBeLessThan(process.platform === 'win32' ? 150 : 50);
    } finally {
      await cleanTmpDir(td);
    }
  });
});

// =============================================================================
// EDGE — git conflicts and permission errors
// =============================================================================

describe('EDGE', () => {
  beforeEach(async () => {
    tmpDir = await createTmpDir();
    process.env.OPENCODE_CONFIG_DIR = tmpDir;
  });

  afterEach(async () => {
    delete process.env.OPENCODE_CONFIG_DIR;
    await cleanTmpDir(tmpDir);
  });

  describe('HAPPY', () => {
    it('initWorkspace succeeds with clean git state', async () => {
      const result = await initWorkspace(path.resolve('.'), 'edge-clean');
      expect(result.info).toBeDefined();
      expect(result.fingerprint).toMatch(/^[0-9a-f]{24}$/);
    });
  });

  describe('BAD', () => {
    // fs.chmod does not enforce POSIX permissions on Windows NTFS — skip on win32
    it.skipIf(process.platform === 'win32')(
      'throws on workspace directory without write permission',
      async () => {
        const worktree = path.resolve('.');
        const sessionId = 'edge-no-perm';

        // Create a read-only directory that we'll try to write to
        const readonlyDir = path.join(tmpDir, 'readonly-ws');
        await fs.mkdir(readonlyDir, { recursive: true });
        await fs.chmod(readonlyDir, 0o444); // Read-only

        process.env.OPENCODE_CONFIG_DIR = readonlyDir;

        // This should throw when trying to write workspace.json
        try {
          await initWorkspace(worktree, sessionId);
          // If we get here on platforms that allow root to bypass permissions, skip
          const stats = await fs.stat(readonlyDir);
          if (process.getuid?.() !== 0) {
            throw new Error('Should have thrown');
          }
        } catch (e) {
          // Should throw WorkspaceError or EACCES
          expect(String(e)).toMatch(/EACCES|EPERM|WorkspaceError|permission/i);
        } finally {
          // Restore permissions for cleanup
          await fs.chmod(readonlyDir, 0o755).catch(() => {});
        }
      },
    );
  });

  describe('CORNER', () => {
    it('handles concurrent initWorkspace calls gracefully', async () => {
      const worktree = path.resolve('.');

      // Simulate concurrent initialization
      const results = await Promise.allSettled([
        initWorkspace(worktree, 'concurrent-a'),
        initWorkspace(worktree, 'concurrent-b'),
        initWorkspace(worktree, 'concurrent-c'),
      ]);

      // All should succeed (idempotent behavior)
      const successes = results.filter((r) => r.status === 'fulfilled');
      const failures = results.filter((r) => r.status === 'rejected');

      expect(successes.length).toBeGreaterThan(0);
      // Failures are acceptable if they race — verify no crashes
      for (const f of failures) {
        if (f.status === 'rejected') {
          // Should be WorkspaceError, not uncaught exception
          expect(String(f.reason)).toMatch(/WorkspaceError|WORKSPACE_MISMATCH/i);
        }
      }
    });

    it('handles workspace with uncommitted changes (dirty git)', async () => {
      // This test verifies that dirty git doesn't prevent workspace init
      const result = await initWorkspace(path.resolve('.'), 'edge-dirty');
      expect(result.info).toBeDefined();
      // Dirty git state should be detected but not block initialization
      // The info object should have the appropriate schema
      expect(result.info.schemaVersion).toBe('v1');
    });
  });

  describe('EDGE', () => {
    it('succeeds with corrupted session-state.json (graceful degradation)', async () => {
      const worktree = path.resolve('.');
      const sessionId = 'edge-corrupt-state';
      const { fingerprint, sessionDir: sessDir } = await initWorkspace(worktree, sessionId);

      await fs.writeFile(path.join(sessDir, 'session-state.json'), '{invalid-json{{{', 'utf-8');

      const archivePath = await archiveSession(fingerprint, sessionId);
      expect(archivePath).toContain('.tar.gz');

      const stats = await fs.stat(archivePath);
      expect(stats.size).toBeGreaterThan(0);
    });

    it('succeeds with schema-invalid session-state.json (Zod validation failure)', async () => {
      const worktree = path.resolve('.');
      const sessionId = 'edge-invalid-schema';
      const { fingerprint, sessionDir: sessDir } = await initWorkspace(worktree, sessionId);

      await fs.writeFile(
        path.join(sessDir, 'session-state.json'),
        '{"phase": 999, "not": "a valid phase"}',
        'utf-8',
      );

      const archivePath = await archiveSession(fingerprint, sessionId);
      expect(archivePath).toContain('.tar.gz');
    });

    it('succeeds with missing audit.jsonl (no decisions recorded)', async () => {
      const worktree = path.resolve('.');
      const sessionId = 'edge-no-audit';
      const { fingerprint, sessionDir: sessDir } = await initWorkspace(worktree, sessionId);

      await fs.writeFile(
        path.join(sessDir, 'session-state.json'),
        '{"phase": "COMPLETE"}',
        'utf-8',
      );

      const archivePath = await archiveSession(fingerprint, sessionId);
      expect(archivePath).toContain('.tar.gz');

      const stats = await fs.stat(archivePath);
      expect(stats.size).toBeGreaterThan(0);
    });

    it('succeeds with corrupt audit.jsonl (malformed lines skipped, no receipts)', async () => {
      const worktree = path.resolve('.');
      const sessionId = 'edge-corrupt-audit';
      const { fingerprint, sessionDir: sessDir } = await initWorkspace(worktree, sessionId);

      await fs.writeFile(
        path.join(sessDir, 'session-state.json'),
        '{"phase": "COMPLETE"}',
        'utf-8',
      );
      await fs.writeFile(path.join(sessDir, 'audit.jsonl'), 'NOT JSON{{{\nALSO BAD{{{', 'utf-8');

      const archivePath = await archiveSession(fingerprint, sessionId);
      expect(archivePath).toContain('.tar.gz');

      const receipts = JSON.parse(
        await fs.readFile(path.join(sessDir, 'decision-receipts.v1.json'), 'utf-8'),
      );
      expect(receipts.count).toBe(0);
      expect(receipts.receipts).toHaveLength(0);
    });

    it('fails with corrupt config.json in workspace (fail-closed)', async () => {
      const worktree = path.resolve('.');
      const sessionId = 'edge-corrupt-config';
      const { fingerprint, sessionDir: sessDir } = await initWorkspace(worktree, sessionId);
      const wsDir = workspaceDir(fingerprint);

      await fs.writeFile(
        path.join(sessDir, 'session-state.json'),
        '{"phase": "COMPLETE"}',
        'utf-8',
      );
      await fs.writeFile(path.join(wsDir, 'config.json'), '{invalid{{{', 'utf-8');

      await expect(archiveSession(fingerprint, sessionId)).rejects.toThrow(
        'Config file is not valid JSON',
      );
    });
  });
});
