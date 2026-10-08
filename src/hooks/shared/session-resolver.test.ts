/**
 * @module hooks/shared/session-resolver.test
 * @description Tests for session-resolver — environment-override and fingerprint-derivation paths,
 * plus error handling for missing state, unreadable state, and missing directories.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveSession } from './session-resolver.js';
import type { SessionState } from '../../state/schema.js';

const mockResolveRoot = vi.hoisted(() => vi.fn());
const mockComputeFingerprint = vi.hoisted(() => vi.fn());

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

/** State whose persisted binding fingerprint matches the mocked canonical projection. */
const derivedState = {
  ...mockState,
  binding: { ...mockState.binding, fingerprint: 'fp-abc' },
} as SessionState;

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

  describe('FLOWGUARD_SESSION_DIR override (canonical assertion)', () => {
    const CANONICAL_WORKTREE = '/canonical/worktree';
    const CANONICAL_DIR = '/canonical/worktree/sessions/fp-abc/sess-1';

    function mockCanonicalAuthority(options?: {
      realpath?: (target: string) => string;
      sessionDir?: string;
    }): void {
      const canonicalState = {
        ...mockState,
        binding: { ...mockState.binding, worktree: CANONICAL_WORKTREE, fingerprint: 'fp-abc' },
      } as SessionState;

      mockResolveRoot.mockReset();
      mockResolveRoot.mockResolvedValue(CANONICAL_WORKTREE);
      mockComputeFingerprint.mockReset();
      mockComputeFingerprint.mockResolvedValue({ fingerprint: 'fp-abc' });

      vi.doMock('node:fs', () => ({
        existsSync: vi.fn(() => true),
        realpathSync: options?.realpath ?? ((target: string) => target),
      }));
      vi.doMock('../../adapters/persistence.js', () => ({
        readState: vi.fn().mockResolvedValue(canonicalState),
      }));
      vi.doMock('../../adapters/workspace/index.js', () => ({
        computeFingerprint: (...args: unknown[]) => mockComputeFingerprint(...args),
        sessionDir: vi.fn().mockReturnValue(options?.sessionDir ?? CANONICAL_DIR),
      }));
      vi.doMock('../../adapters/git.js', async (importOriginal) => {
        const actual = await importOriginal<typeof import('../../adapters/git.js')>();
        return { ...actual, resolveRoot: (...args: unknown[]) => mockResolveRoot(...args) };
      });
    }

    it('HAPPY: accepts an override that equals the canonical session directory', async () => {
      setEnv(CANONICAL_DIR);
      mockCanonicalAuthority();

      const { resolveSession: resolve } = await import('./session-resolver.js');
      const result = await resolve('/canonical/worktree/src', 'sess-1');

      expect(result.ok).toBe(true);
      expect(mockResolveRoot).toHaveBeenCalledWith('/canonical/worktree/src');
      expect(mockComputeFingerprint).toHaveBeenCalledWith(CANONICAL_WORKTREE);
    });

    it('HAPPY: an empty override is ignored and the canonical authority resolves normally', async () => {
      setEnv('');
      mockCanonicalAuthority();

      const { resolveSession: resolve } = await import('./session-resolver.js');
      const result = await resolve(CANONICAL_WORKTREE, 'sess-1');

      expect(result.ok).toBe(true);
    });

    it('BAD: rejects a foreign workspace override', async () => {
      setEnv('/foreign/session/dir');
      mockCanonicalAuthority();

      const { resolveSession: resolve } = await import('./session-resolver.js');
      const result = await resolve(CANONICAL_WORKTREE, 'sess-1');

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('SESSION_OVERRIDE_MISMATCH');
    });

    it('BAD: rejects a symlink escape override', async () => {
      setEnv('/link/escape');
      mockCanonicalAuthority({
        realpath: (target) => (target === '/link/escape' ? '/foreign/session/dir' : target),
      });

      const { resolveSession: resolve } = await import('./session-resolver.js');
      const result = await resolve(CANONICAL_WORKTREE, 'sess-1');

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('SESSION_OVERRIDE_MISMATCH');
    });

    it('BAD: rejects a stale override that names another host session', async () => {
      setEnv(CANONICAL_DIR);
      mockCanonicalAuthority({ sessionDir: '/canonical/worktree/sessions/fp-abc/sess-other' });

      const { resolveSession: resolve } = await import('./session-resolver.js');
      const result = await resolve(CANONICAL_WORKTREE, 'sess-other');

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('SESSION_OVERRIDE_MISMATCH');
    });

    it('BAD: rejects an override path that cannot be resolved', async () => {
      setEnv('/missing/override');
      mockCanonicalAuthority({
        realpath: () => {
          throw new Error('ENOENT');
        },
      });

      const { resolveSession: resolve } = await import('./session-resolver.js');
      const result = await resolve(CANONICAL_WORKTREE, 'sess-1');

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('SESSION_OVERRIDE_UNRESOLVABLE');
    });

    it('BAD: an unresolvable cwd still fails closed under an override', async () => {
      setEnv(CANONICAL_DIR);
      mockCanonicalAuthority();
      const { GitError } = await import('../../adapters/git.js');
      mockResolveRoot.mockRejectedValue(new GitError('NOT_GIT_REPO', 'not a git repository'));

      const { resolveSession: resolve } = await import('./session-resolver.js');
      const result = await resolve('/not-a-repo', 'sess-1');

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('NOT_GIT_REPO');
    });
  });

  describe('fingerprint derivation path', () => {
    it('resolves via fingerprint when env var is not set', async () => {
      setEnv(undefined);

      vi.doMock('node:fs', () => ({
        existsSync: vi.fn((path: string) => path === '/derived/session/dir'),
      }));

      vi.doMock('../../adapters/persistence.js', () => ({
        readState: vi.fn().mockResolvedValue(derivedState),
      }));

      vi.doMock('../../adapters/workspace/index.js', () => ({
        computeFingerprint: (...args: unknown[]) => mockComputeFingerprint(...args),
        sessionDir: vi.fn().mockReturnValue('/derived/session/dir'),
      }));

      vi.doMock('../../adapters/git.js', async (importOriginal) => {
        const actual = await importOriginal<typeof import('../../adapters/git.js')>();
        return { ...actual, resolveRoot: (...args: unknown[]) => mockResolveRoot(...args) };
      });
      mockResolveRoot.mockReset();
      mockResolveRoot.mockResolvedValue('/some/cwd');
      mockComputeFingerprint.mockReset();
      mockComputeFingerprint.mockResolvedValue({ fingerprint: 'fp-abc' });

      const { resolveSession: resolve } = await import('./session-resolver.js');
      const result = await resolve('/some/cwd', 'sess-1');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.sessionDir).toBe('/derived/session/dir');
      }
      expect(mockComputeFingerprint).toHaveBeenCalledWith('/some/cwd');
    });

    it('returns GIT_NOT_FOUND when fingerprint computation fails with a typed git error', async () => {
      setEnv(undefined);

      vi.doMock('../../adapters/workspace/index.js', async () => {
        const { GitError } = await import('../../adapters/git.js');
        return {
          computeFingerprint: vi
            .fn()
            .mockRejectedValue(new GitError('GIT_NOT_FOUND', 'git not found')),
          sessionDir: vi.fn(),
        };
      });

      vi.doMock('../../adapters/persistence.js', async () => {
        const actual = await vi.importActual<typeof import('../../adapters/persistence.js')>(
          '../../adapters/persistence.js',
        );
        return { ...actual, readState: vi.fn() };
      });

      vi.doMock('../../adapters/git.js', async (importOriginal) => {
        const actual = await importOriginal<typeof import('../../adapters/git.js')>();
        return { ...actual, resolveRoot: vi.fn().mockResolvedValue('/no-git') };
      });

      const { resolveSession: resolve } = await import('./session-resolver.js');
      const result = await resolve('/no-git', 'sess-1');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('GIT_NOT_FOUND');
        expect(result.reason).toContain('/no-git');
      }
    });

    it('returns INVALID_SESSION_ID when sessionDir rejects the session id', async () => {
      setEnv(undefined);

      vi.doMock('../../adapters/workspace/index.js', async () => {
        const { WorkspaceError } = await import('../../adapters/workspace/types.js');
        return {
          WorkspaceError,
          computeFingerprint: vi.fn().mockResolvedValue({ fingerprint: 'fp-abc' }),
          sessionDir: vi.fn().mockImplementation(() => {
            throw new WorkspaceError('INVALID_SESSION_ID', 'invalid fingerprint');
          }),
        };
      });

      vi.doMock('../../adapters/persistence.js', async () => {
        const actual = await vi.importActual<typeof import('../../adapters/persistence.js')>(
          '../../adapters/persistence.js',
        );
        return { ...actual, readState: vi.fn() };
      });

      vi.doMock('../../adapters/git.js', async (importOriginal) => {
        const actual = await importOriginal<typeof import('../../adapters/git.js')>();
        return { ...actual, resolveRoot: vi.fn().mockResolvedValue('/cwd') };
      });

      const { resolveSession: resolve } = await import('./session-resolver.js');
      const result = await resolve('/cwd', 'sess-1');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_SESSION_ID');
      }
    });
  });

  describe('cwd binding validation (H8)', () => {
    const boundState = {
      ...mockState,
      binding: { ...mockState.binding, worktree: '/bound/worktree', fingerprint: 'fp-abc' },
    } as SessionState;

    function mockDerivedSession(state: unknown): void {
      mockComputeFingerprint.mockReset();
      mockComputeFingerprint.mockResolvedValue({ fingerprint: 'fp-abc' });
      vi.doMock('node:fs', () => ({ existsSync: vi.fn(() => true) }));
      vi.doMock('../../adapters/persistence.js', () => ({
        readState: vi.fn().mockResolvedValue(state),
      }));
      vi.doMock('../../adapters/workspace/index.js', () => ({
        computeFingerprint: (...args: unknown[]) => mockComputeFingerprint(...args),
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

    it('canonicalizes the cwd to the git root before fingerprinting', async () => {
      setEnv(undefined);
      mockDerivedSession(boundState);
      mockResolveRoot.mockReset();
      mockResolveRoot.mockResolvedValue('/bound/worktree');

      const { resolveSession: resolve } = await import('./session-resolver.js');
      const result = await resolve('/bound/worktree', 'sess-1');

      expect(result.ok).toBe(true);
      expect(mockResolveRoot).toHaveBeenCalledWith('/bound/worktree');
      expect(mockComputeFingerprint).toHaveBeenCalledWith('/bound/worktree');
    });

    it('fingerprints the canonical root for a subdirectory cwd', async () => {
      setEnv(undefined);
      mockDerivedSession(boundState);
      mockResolveRoot.mockReset();
      mockResolveRoot.mockResolvedValue('/bound/worktree');

      const { resolveSession: resolve } = await import('./session-resolver.js');
      const result = await resolve('/bound/worktree/src', 'sess-1');

      expect(result.ok).toBe(true);
      expect(mockResolveRoot).toHaveBeenCalledWith('/bound/worktree/src');
      expect(mockComputeFingerprint).toHaveBeenCalledWith('/bound/worktree');
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
  });

  describe('error paths (canonical authority)', () => {
    function mockAuthority(options: {
      readStateResult: 'null' | 'throw' | 'typed-throw';
      sessionDirExists: boolean;
    }): void {
      mockResolveRoot.mockReset();
      mockResolveRoot.mockResolvedValue('/bound/worktree');
      mockComputeFingerprint.mockReset();
      mockComputeFingerprint.mockResolvedValue({ fingerprint: 'fp-abc' });

      vi.doMock('node:fs', () => ({
        existsSync: vi.fn().mockReturnValue(options.sessionDirExists),
        realpathSync: vi.fn((target: string) => target),
      }));
      vi.doMock('../../adapters/persistence.js', async (importOriginal) => {
        const actual = await importOriginal<typeof import('../../adapters/persistence.js')>();
        const readState =
          options.readStateResult === 'null'
            ? vi.fn().mockResolvedValue(null)
            : options.readStateResult === 'throw'
              ? vi.fn().mockRejectedValue(new Error('disk I/O error'))
              : vi.fn().mockRejectedValue(new actual.PersistenceError('READ_FAILED', 'boom'));
        return { ...actual, readState };
      });
      vi.doMock('../../adapters/workspace/index.js', () => ({
        computeFingerprint: (...args: unknown[]) => mockComputeFingerprint(...args),
        sessionDir: vi.fn().mockReturnValue('/derived/session/dir'),
      }));
      vi.doMock('../../adapters/git.js', async (importOriginal) => {
        const actual = await importOriginal<typeof import('../../adapters/git.js')>();
        return { ...actual, resolveRoot: (...args: unknown[]) => mockResolveRoot(...args) };
      });
    }

    it('returns SESSION_DIR_NOT_FOUND when the canonical directory does not exist', async () => {
      mockAuthority({ readStateResult: 'null', sessionDirExists: false });

      const { resolveSession: resolve } = await import('./session-resolver.js');
      const result = await resolve('/bound/worktree', 'sess-1');

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('SESSION_DIR_NOT_FOUND');
    });

    it('returns STATE_MISSING when the canonical directory exists without state', async () => {
      mockAuthority({ readStateResult: 'null', sessionDirExists: true });

      const { resolveSession: resolve } = await import('./session-resolver.js');
      const result = await resolve('/bound/worktree', 'sess-1');

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('STATE_MISSING');
    });

    it('fails closed as SESSION_AUTHORITY_UNAVAILABLE on untyped read failures', async () => {
      mockAuthority({ readStateResult: 'throw', sessionDirExists: true });

      const { resolveSession: resolve } = await import('./session-resolver.js');
      const result = await resolve('/bound/worktree', 'sess-1');

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('SESSION_AUTHORITY_UNAVAILABLE');
    });

    it('preserves typed persistence failure codes from the authority', async () => {
      mockAuthority({ readStateResult: 'typed-throw', sessionDirExists: true });

      const { resolveSession: resolve } = await import('./session-resolver.js');
      const result = await resolve('/bound/worktree', 'sess-1');

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('READ_FAILED');
    });
  });
});
