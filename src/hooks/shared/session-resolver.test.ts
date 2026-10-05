/**
 * @module hooks/shared/session-resolver.test
 * @description Tests for session-resolver — environment-override and fingerprint-derivation paths,
 * plus error handling for missing state, unreadable state, and missing directories.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveSession } from './session-resolver.js';
import type { SessionState } from '../../state/schema.js';

const mockResolveRoot = vi.hoisted(() => vi.fn());

const mockState: SessionState = {
  phase: 'planning',
  reviewObligations: [],
  policyMode: 'solo',
  version: '1.0.0',
  binding: {
    hostSessionId: 'sess-1',
    worktree: '/some/cwd',
    fingerprint: 'f'.repeat(24),
    resolvedAt: '2026-01-01T00:00:00.000Z',
  },
} as unknown as SessionState;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setEnv(value: string | undefined): void {
  if (value === undefined) {
    delete process.env['FLOWGUARD_SESSION_DIR'];
  } else {
    process.env['FLOWGUARD_SESSION_DIR'] = value;
  }
}

// ─── resolveSession ───────────────────────────────────────────────────────────

describe('resolveSession', () => {
  const originalEnv = process.env['FLOWGUARD_SESSION_DIR'];

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    setEnv(originalEnv);
    vi.restoreAllMocks();
  });

  describe('environment variable override', () => {
    it('uses FLOWGUARD_SESSION_DIR when set and state is readable', async () => {
      setEnv('/custom/session/dir');

      vi.doMock('node:fs', () => ({
        existsSync: vi.fn((path: string) => path === '/custom/session/dir'),
      }));

      vi.doMock('../../adapters/persistence.js', () => ({
        readState: vi.fn().mockResolvedValue(mockState),
      }));

      vi.doMock('../../adapters/workspace/index.js', () => ({
        computeFingerprint: vi.fn(),
        sessionDir: vi.fn(),
      }));

      const { resolveSession: resolve } = await import('./session-resolver.js');
      const result = await resolve('/some/cwd', 'sess-1');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.sessionDir).toBe('/custom/session/dir');
        expect(result.state).toEqual(mockState);
      }
    });

    it('resolves via env var even when env var is set to empty string fallback', async () => {
      setEnv('/explicit/dir');

      vi.doMock('node:fs', () => ({
        existsSync: vi.fn((path: string) => path === '/explicit/dir'),
      }));

      vi.doMock('../../adapters/persistence.js', () => ({
        readState: vi.fn().mockResolvedValue(mockState),
      }));

      vi.doMock('../../adapters/workspace/index.js', () => ({
        computeFingerprint: vi.fn(),
        sessionDir: vi.fn(),
      }));

      const { resolveSession: resolve } = await import('./session-resolver.js');
      const result = await resolve('/cwd', 'sess-1');

      expect(result.ok).toBe(true);
    });
  });

  describe('fingerprint derivation path', () => {
    it('resolves via fingerprint when env var is not set', async () => {
      setEnv(undefined);

      vi.doMock('node:fs', () => ({
        existsSync: vi.fn((path: string) => path === '/derived/session/dir'),
      }));

      vi.doMock('../../adapters/persistence.js', () => ({
        readState: vi.fn().mockResolvedValue(mockState),
      }));

      vi.doMock('../../adapters/workspace/index.js', () => ({
        computeFingerprint: vi.fn().mockResolvedValue({ fingerprint: 'fp-abc' }),
        sessionDir: vi.fn().mockReturnValue('/derived/session/dir'),
      }));

      const { resolveSession: resolve } = await import('./session-resolver.js');
      const result = await resolve('/some/cwd', 'sess-1');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.sessionDir).toBe('/derived/session/dir');
      }
    });

    it('returns FINGERPRINT_FAILED when computeFingerprint throws', async () => {
      setEnv(undefined);

      vi.doMock('../../adapters/workspace/index.js', () => ({
        computeFingerprint: vi.fn().mockRejectedValue(new Error('git not found')),
        sessionDir: vi.fn(),
      }));

      vi.doMock('../../adapters/persistence.js', () => ({
        readState: vi.fn(),
      }));

      const { resolveSession: resolve } = await import('./session-resolver.js');
      const result = await resolve('/no-git', 'sess-1');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('FINGERPRINT_FAILED');
        expect(result.reason).toContain('/no-git');
      }
    });

    it('returns SESSION_DIR_INVALID when sessionDir throws', async () => {
      setEnv(undefined);

      vi.doMock('../../adapters/workspace/index.js', () => ({
        computeFingerprint: vi.fn().mockResolvedValue({ fingerprint: 'fp-abc' }),
        sessionDir: vi.fn().mockImplementation(() => {
          throw new Error('invalid fingerprint');
        }),
      }));

      vi.doMock('../../adapters/persistence.js', () => ({
        readState: vi.fn(),
      }));

      const { resolveSession: resolve } = await import('./session-resolver.js');
      const result = await resolve('/cwd', 'sess-1');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('SESSION_DIR_INVALID');
      }
    });
  });

  describe('cwd binding validation (H8)', () => {
    const boundState = {
      ...mockState,
      binding: { ...mockState.binding, worktree: '/bound/worktree' },
    } as SessionState;

    function mockDerivedSession(state: unknown): void {
      vi.doMock('node:fs', () => ({ existsSync: vi.fn(() => true) }));
      vi.doMock('../../adapters/persistence.js', () => ({
        readState: vi.fn().mockResolvedValue(state),
      }));
      vi.doMock('../../adapters/workspace/index.js', () => ({
        computeFingerprint: vi.fn().mockResolvedValue({ fingerprint: 'fp-abc' }),
        sessionDir: vi.fn().mockReturnValue('/derived/session/dir'),
      }));
      vi.doMock('../../adapters/git.js', async (importOriginal) => {
        const actual = await importOriginal<typeof import('../../adapters/git.js')>();
        return { ...actual, resolveRoot: (...args: unknown[]) => mockResolveRoot(...args) };
      });
    }

    /** Build the GitError from the same (mocked) module identity the resolver sees. */
    async function gitError(code: 'NOT_GIT_REPO' | 'GIT_NOT_FOUND', message: string) {
      const { GitError: MockedGitError } = await import('../../adapters/git.js');
      return new MockedGitError(code, message);
    }

    it('accepts a cwd equal to the bound worktree without git resolution', async () => {
      setEnv(undefined);
      mockDerivedSession(boundState);
      mockResolveRoot.mockReset();

      const { resolveSession: resolve } = await import('./session-resolver.js');
      const result = await resolve('/bound/worktree', 'sess-1');

      expect(result.ok).toBe(true);
      expect(mockResolveRoot).not.toHaveBeenCalled();
    });

    it('accepts a subdirectory that resolves to the bound worktree', async () => {
      setEnv(undefined);
      mockDerivedSession(boundState);
      mockResolveRoot.mockReset();
      mockResolveRoot.mockResolvedValue('/bound/worktree');

      const { resolveSession: resolve } = await import('./session-resolver.js');
      const result = await resolve('/bound/worktree/src', 'sess-1');

      expect(result.ok).toBe(true);
      expect(mockResolveRoot).toHaveBeenCalledWith('/bound/worktree/src');
    });

    it('rejects a cwd that resolves to a different worktree', async () => {
      setEnv(undefined);
      mockDerivedSession(boundState);
      mockResolveRoot.mockReset();
      mockResolveRoot.mockResolvedValue('/other/worktree');

      const { resolveSession: resolve } = await import('./session-resolver.js');
      const result = await resolve('/other/worktree', 'sess-1');

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('WORKTREE_MISMATCH');
    });

    it('preserves NOT_GIT_REPO from git resolution', async () => {
      setEnv(undefined);
      mockDerivedSession(boundState);
      mockResolveRoot.mockReset();
      mockResolveRoot.mockRejectedValue(await gitError('NOT_GIT_REPO', 'not a git repository'));

      const { resolveSession: resolve } = await import('./session-resolver.js');
      const result = await resolve('/not-a-repo', 'sess-1');

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('NOT_GIT_REPO');
    });

    it('preserves GIT_NOT_FOUND instead of collapsing it to NOT_GIT_REPO', async () => {
      setEnv(undefined);
      mockDerivedSession(boundState);
      mockResolveRoot.mockReset();
      mockResolveRoot.mockRejectedValue(await gitError('GIT_NOT_FOUND', 'git executable missing'));

      const { resolveSession: resolve } = await import('./session-resolver.js');
      const result = await resolve('/worktree', 'sess-1');

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('GIT_NOT_FOUND');
    });

    it('skips cwd validation entirely under the explicit env override', async () => {
      setEnv('/custom/session/dir');
      vi.doMock('node:fs', () => ({ existsSync: vi.fn(() => true) }));
      vi.doMock('../../adapters/persistence.js', () => ({
        readState: vi.fn().mockResolvedValue(boundState),
      }));
      vi.doMock('../../adapters/workspace/index.js', () => ({
        computeFingerprint: vi.fn(),
        sessionDir: vi.fn(),
      }));
      mockResolveRoot.mockReset();

      const { resolveSession: resolve } = await import('./session-resolver.js');
      const result = await resolve('/somewhere/else', 'sess-1');

      expect(result.ok).toBe(true);
      expect(mockResolveRoot).not.toHaveBeenCalled();
    });
  });

  describe('error paths (readSessionState)', () => {
    it('returns SESSION_DIR_NOT_FOUND when session directory does not exist', async () => {
      setEnv('/nonexistent');

      vi.doMock('node:fs', () => ({
        existsSync: vi.fn().mockReturnValue(false),
      }));

      vi.doMock('../../adapters/persistence.js', () => ({
        readState: vi.fn(),
      }));

      vi.doMock('../../adapters/workspace/index.js', () => ({
        computeFingerprint: vi.fn(),
        sessionDir: vi.fn(),
      }));

      const { resolveSession: resolve } = await import('./session-resolver.js');
      const result = await resolve('/cwd', 'sess-1');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('SESSION_DIR_NOT_FOUND');
      }
    });

    it('returns STATE_UNREADABLE when readState throws', async () => {
      setEnv('/corrupt-dir');

      vi.doMock('node:fs', () => ({
        existsSync: vi.fn().mockReturnValue(true),
      }));

      vi.doMock('../../adapters/persistence.js', () => ({
        readState: vi.fn().mockRejectedValue(new Error('disk I/O error')),
      }));

      vi.doMock('../../adapters/workspace/index.js', () => ({
        computeFingerprint: vi.fn(),
        sessionDir: vi.fn(),
      }));

      const { resolveSession: resolve } = await import('./session-resolver.js');
      const result = await resolve('/cwd', 'sess-1');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('STATE_UNREADABLE');
      }
    });

    it('returns STATE_MISSING when readState returns null', async () => {
      setEnv('/empty-dir');

      vi.doMock('node:fs', () => ({
        existsSync: vi.fn().mockReturnValue(true),
      }));

      vi.doMock('../../adapters/persistence.js', () => ({
        readState: vi.fn().mockResolvedValue(null),
      }));

      vi.doMock('../../adapters/workspace/index.js', () => ({
        computeFingerprint: vi.fn(),
        sessionDir: vi.fn(),
      }));

      const { resolveSession: resolve } = await import('./session-resolver.js');
      const result = await resolve('/cwd', 'sess-1');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('STATE_MISSING');
      }
    });
  });
});
