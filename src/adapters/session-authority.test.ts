/**
 * @module adapters/session-authority.test
 * @description Canonical session authority: root canonicalization, binding
 *              validation, and the unavailable/absent/resolved contract.
 *
 * Uses real temporary git repositories (local-only, no `origin`) so the
 * subdirectory and symlink cases exercise `resolveRoot` end to end.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeState } from '../fixtures.js';
import { writeState } from './persistence.js';
import { resolveSessionAuthority } from './session-authority.js';
import { computeFingerprint, sessionDir } from './workspace/index.js';

const SESSION_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const RESOLVED_AT = '2026-01-01T00:00:00.000Z';

describe('resolveSessionAuthority', () => {
  let base: string;
  let repo: string;
  let originalConfigDir: string | undefined;
  let originalRequireTestConfigDir: string | undefined;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'fg-session-authority-'));
    repo = join(realpathSync(base), 'repo');
    mkdirSync(repo);
    execFileSync('git', ['init', '--quiet', repo]);

    originalConfigDir = process.env.OPENCODE_CONFIG_DIR;
    originalRequireTestConfigDir = process.env.FLOWGUARD_REQUIRE_TEST_CONFIG_DIR;
    process.env.OPENCODE_CONFIG_DIR = join(base, 'config');
    process.env.FLOWGUARD_REQUIRE_TEST_CONFIG_DIR = '1';
  });

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = originalConfigDir;
    if (originalRequireTestConfigDir === undefined)
      delete process.env.FLOWGUARD_REQUIRE_TEST_CONFIG_DIR;
    else process.env.FLOWGUARD_REQUIRE_TEST_CONFIG_DIR = originalRequireTestConfigDir;
    rmSync(base, { recursive: true, force: true });
  });

  async function fingerprintOf(): Promise<string> {
    return (await computeFingerprint(repo)).fingerprint;
  }

  async function writeBoundState(overrides: {
    worktree?: string;
    fingerprint?: string;
  }): Promise<string> {
    const canonicalFingerprint = await fingerprintOf();
    const dir = sessionDir(canonicalFingerprint, SESSION_ID);
    await writeState(
      dir,
      makeState('TICKET', {
        id: SESSION_ID,
        binding: {
          hostSessionId: SESSION_ID,
          worktree: overrides.worktree ?? repo,
          fingerprint: overrides.fingerprint ?? canonicalFingerprint,
          resolvedAt: RESOLVED_AT,
        },
      }),
    );
    return dir;
  }

  it('resolves the canonical workspace and returns the validated state', async () => {
    const dir = await writeBoundState({});

    const result = await resolveSessionAuthority({ root: repo, sessionId: SESSION_ID });

    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.sessDir).toBe(dir);
      expect(result.worktreeRoot).toBe(repo);
      expect(result.fingerprint).toBe(await fingerprintOf());
      expect(result.state.binding.worktree).toBe(repo);
    }
  });

  it('canonicalizes a subdirectory of the worktree', async () => {
    await writeBoundState({});
    const subdir = join(repo, 'src');
    mkdirSync(subdir);

    const result = await resolveSessionAuthority({ root: subdir, sessionId: SESSION_ID });

    expect(result).toMatchObject({ status: 'resolved', worktreeRoot: repo });
  });

  it.skipIf(process.platform === 'win32')('canonicalizes a symlinked worktree path', async () => {
    await writeBoundState({});
    const link = join(realpathSync(base), 'repo-link');
    symlinkSync(repo, link, 'dir');

    const result = await resolveSessionAuthority({ root: link, sessionId: SESSION_ID });

    expect(result).toMatchObject({ status: 'resolved', worktreeRoot: repo });
  });

  it('reports absent with the canonical location when no state exists', async () => {
    const result = await resolveSessionAuthority({ root: repo, sessionId: SESSION_ID });

    expect(result.status).toBe('absent');
    if (result.status === 'absent') {
      expect(result.worktreeRoot).toBe(repo);
      expect(result.sessDir).toBe(sessionDir(await fingerprintOf(), SESSION_ID));
    }
  });

  it('reports unavailable with NO_WORKTREE when no root is provided', async () => {
    await expect(resolveSessionAuthority({ root: '', sessionId: SESSION_ID })).resolves.toEqual({
      status: 'unavailable',
      code: 'NO_WORKTREE',
      reason: expect.any(String),
    });
  });

  it('preserves NOT_GIT_REPO for a non-git root', async () => {
    const unrelated = join(realpathSync(base), 'unrelated');
    mkdirSync(unrelated);

    const result = await resolveSessionAuthority({ root: unrelated, sessionId: SESSION_ID });

    expect(result).toMatchObject({ status: 'unavailable', code: 'NOT_GIT_REPO' });
  });

  it('rejects a persisted fingerprint that differs from the canonical workspace', async () => {
    // Merge-critical: same canonical root, wrong persisted fingerprint.
    await writeBoundState({ fingerprint: 'f'.repeat(24) });

    const result = await resolveSessionAuthority({ root: repo, sessionId: SESSION_ID });

    expect(result).toMatchObject({ status: 'unavailable', code: 'SESSION_BINDING_MISMATCH' });
    if (result.status === 'unavailable') expect(result.reason).toContain('does not match');
  });

  it('rejects a persisted worktree that differs from the canonical root', async () => {
    await writeBoundState({ worktree: '/other/worktree' });

    const result = await resolveSessionAuthority({ root: repo, sessionId: SESSION_ID });

    expect(result).toMatchObject({ status: 'unavailable', code: 'WORKTREE_MISMATCH' });
    if (result.status === 'unavailable') expect(result.reason).toContain('/other/worktree');
  });

  it('rejects a claimed fingerprint that differs from the canonical projection', async () => {
    // Merge-critical: MCP cross-entrypoint parity. The persisted binding is
    // correct; only the claimed transport fingerprint is stale.
    await writeBoundState({});

    const result = await resolveSessionAuthority({
      root: repo,
      sessionId: SESSION_ID,
      claimedFingerprint: 'e'.repeat(24),
    });

    expect(result).toMatchObject({ status: 'unavailable', code: 'SESSION_BINDING_MISMATCH' });
  });

  it('accepts a claimed fingerprint that matches the canonical projection', async () => {
    await writeBoundState({});

    const result = await resolveSessionAuthority({
      root: repo,
      sessionId: SESSION_ID,
      claimedFingerprint: await fingerprintOf(),
    });

    expect(result.status).toBe('resolved');
  });
});
