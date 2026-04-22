/**
 * @module actor.test
 * @description Unit tests for the FlowGuard actor identity resolver (P27).
 *
 * Covers the resolveActor() function — env → git → unknown resolution.
 *
 * Test matrix:
 * 1. FLOWGUARD_ACTOR_ID + EMAIL → source: 'env'                     (HAPPY)
 * 2. git user.name/email available → source: 'git'                   (HAPPY)
 * 3. neither available → unknown                                     (HAPPY)
 * 4. env beats git when both available                               (CORNER)
 * 5. FLOWGUARD_ACTOR_EMAIL without ACTOR_ID → falls through          (CORNER)
 * 6. malformed/missing email does not crash                          (EDGE)
 * 7. git unavailable / not a repo → source: 'unknown'               (EDGE)
 *
 * @test-policy HAPPY, CORNER, EDGE — all three categories present.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveActor } from './actor';

// Mock git adapter — actor resolution must not depend on real git
vi.mock('./git', () => ({
  gitUserName: vi.fn<(cwd: string) => Promise<string | null>>().mockResolvedValue(null),
  gitUserEmail: vi.fn<(cwd: string) => Promise<string | null>>().mockResolvedValue(null),
  // Re-export stubs for other functions to prevent import errors
  gitRoot: vi.fn(),
  gitFingerprint: vi.fn(),
  gitDiffFiles: vi.fn(),
  gitTreeFiles: vi.fn(),
  GitError: class extends Error {},
}));

// Import mocked functions for per-test configuration
import { gitUserName, gitUserEmail } from './git';
const mockGitUserName = vi.mocked(gitUserName);
const mockGitUserEmail = vi.mocked(gitUserEmail);

const WORKTREE = '/fake/worktree';

describe('resolveActor', () => {
  // Save and restore env vars
  const envBackup: Record<string, string | undefined> = {};
  const ENV_KEYS = ['FLOWGUARD_ACTOR_ID', 'FLOWGUARD_ACTOR_EMAIL'];

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      envBackup[key] = process.env[key];
      delete process.env[key];
    }
    mockGitUserName.mockReset().mockResolvedValue(null);
    mockGitUserEmail.mockReset().mockResolvedValue(null);
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (envBackup[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = envBackup[key];
      }
    }
  });

  // ── HAPPY ──────────────────────────────────────────────────────────────────

  it('resolves from env when FLOWGUARD_ACTOR_ID + EMAIL set', async () => {
    process.env.FLOWGUARD_ACTOR_ID = 'ci-operator';
    process.env.FLOWGUARD_ACTOR_EMAIL = 'ci@example.com';

    const actor = await resolveActor(WORKTREE);

    expect(actor).toEqual({
      id: 'ci-operator',
      email: 'ci@example.com',
      source: 'env',
    });
    // Should NOT call git when env is present
    expect(mockGitUserName).not.toHaveBeenCalled();
  });

  it('resolves from git when user.name/email available', async () => {
    mockGitUserName.mockResolvedValue('Jane Dev');
    mockGitUserEmail.mockResolvedValue('jane@dev.io');

    const actor = await resolveActor(WORKTREE);

    expect(actor).toEqual({
      id: 'Jane Dev',
      email: 'jane@dev.io',
      source: 'git',
    });
    expect(mockGitUserName).toHaveBeenCalledWith(WORKTREE);
    expect(mockGitUserEmail).toHaveBeenCalledWith(WORKTREE);
  });

  it('resolves to unknown when neither env nor git available', async () => {
    const actor = await resolveActor(WORKTREE);

    expect(actor).toEqual({
      id: 'unknown',
      email: null,
      source: 'unknown',
    });
  });

  // ── CORNER ─────────────────────────────────────────────────────────────────

  it('env beats git when both available', async () => {
    process.env.FLOWGUARD_ACTOR_ID = 'env-user';
    process.env.FLOWGUARD_ACTOR_EMAIL = 'env@example.com';
    mockGitUserName.mockResolvedValue('Git User');
    mockGitUserEmail.mockResolvedValue('git@example.com');

    const actor = await resolveActor(WORKTREE);

    expect(actor.source).toBe('env');
    expect(actor.id).toBe('env-user');
    // Git should not be called at all
    expect(mockGitUserName).not.toHaveBeenCalled();
  });

  it('FLOWGUARD_ACTOR_EMAIL without ACTOR_ID falls through to git', async () => {
    process.env.FLOWGUARD_ACTOR_EMAIL = 'orphan@example.com';
    mockGitUserName.mockResolvedValue('Git Fallback');

    const actor = await resolveActor(WORKTREE);

    expect(actor.source).toBe('git');
    expect(actor.id).toBe('Git Fallback');
    // Orphaned email is ignored — git email used instead
    expect(actor.email).toBeNull(); // git email returns null
  });

  // ── EDGE ───────────────────────────────────────────────────────────────────

  it('malformed/missing email does not crash', async () => {
    process.env.FLOWGUARD_ACTOR_ID = 'no-email-user';
    // No FLOWGUARD_ACTOR_EMAIL set

    const actor = await resolveActor(WORKTREE);

    expect(actor).toEqual({
      id: 'no-email-user',
      email: null,
      source: 'env',
    });
  });

  it('git unavailable / not a repo falls to unknown', async () => {
    // gitUserName returns null (simulates git failure or not a repo)
    mockGitUserName.mockResolvedValue(null);

    const actor = await resolveActor(WORKTREE);

    expect(actor).toEqual({
      id: 'unknown',
      email: null,
      source: 'unknown',
    });
  });

  it('whitespace-only FLOWGUARD_ACTOR_ID falls through', async () => {
    process.env.FLOWGUARD_ACTOR_ID = '   ';

    const actor = await resolveActor(WORKTREE);

    // trim() produces empty string, which is falsy → falls through
    expect(actor.source).not.toBe('env');
  });

  it('git user.name present but email absent still resolves git', async () => {
    mockGitUserName.mockResolvedValue('Name Only');
    mockGitUserEmail.mockResolvedValue(null);

    const actor = await resolveActor(WORKTREE);

    expect(actor).toEqual({
      id: 'Name Only',
      email: null,
      source: 'git',
    });
  });
});
