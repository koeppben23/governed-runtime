/**
 * @module hooks/shared/session-resolver.integration.test
 * @description Real resolver coverage for H8: a local-only git repo (no
 * `origin`) must resolve the same session from the root, a subdirectory, and a
 * symlinked path. This proves canonicalization happens before fingerprinting,
 * which the mocked unit tests cannot.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initWorkspace } from '../../adapters/workspace/index.js';
import { writeState } from '../../adapters/persistence.js';
import { makeState, FROZEN_IMPLEMENTATION_BASE } from '../../fixtures.js';
import { resolveSession } from './session-resolver.js';

const SESSION_ID = 'resolver-integration-session';

describe('resolveSession integration (local-only git repo)', () => {
  let base: string;
  let root: string;
  let worktree: string;
  let sessionDir: string;
  let originalConfigDir: string | undefined;
  let originalRequireTestConfigDir: string | undefined;
  let originalSessionDir: string | undefined;

  beforeEach(async () => {
    // `base` keeps the OS-tmpdir spelling required by the workspace test-dir
    // guard; `root` is the physical path git resolves to on macOS.
    base = mkdtempSync(join(tmpdir(), 'fg-resolver-'));
    root = realpathSync(base);
    worktree = join(root, 'repo');
    mkdirSync(worktree);
    execFileSync('git', ['init', '--quiet', worktree]);

    originalConfigDir = process.env.OPENCODE_CONFIG_DIR;
    originalRequireTestConfigDir = process.env.FLOWGUARD_REQUIRE_TEST_CONFIG_DIR;
    originalSessionDir = process.env.FLOWGUARD_SESSION_DIR;
    process.env.OPENCODE_CONFIG_DIR = join(base, 'config');
    process.env.FLOWGUARD_REQUIRE_TEST_CONFIG_DIR = '1';
    delete process.env.FLOWGUARD_SESSION_DIR;

    const initialized = await initWorkspace(worktree, SESSION_ID);
    sessionDir = initialized.sessionDir;
    await writeState(
      initialized.sessionDir,
      makeState('IMPLEMENTATION', {
        implementationBaseAuthority: FROZEN_IMPLEMENTATION_BASE,
        binding: {
          hostSessionId: SESSION_ID,
          worktree,
          fingerprint: initialized.fingerprint,
          resolvedAt: '2026-01-01T00:00:00.000Z',
        },
      }),
    );
  });

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = originalConfigDir;
    if (originalRequireTestConfigDir === undefined)
      delete process.env.FLOWGUARD_REQUIRE_TEST_CONFIG_DIR;
    else process.env.FLOWGUARD_REQUIRE_TEST_CONFIG_DIR = originalRequireTestConfigDir;
    if (originalSessionDir === undefined) delete process.env.FLOWGUARD_SESSION_DIR;
    else process.env.FLOWGUARD_SESSION_DIR = originalSessionDir;
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves the bound session from the worktree root', async () => {
    const result = await resolveSession(worktree, SESSION_ID);
    expect(result.ok).toBe(true);
  });

  it('resolves from a subdirectory without an origin remote', async () => {
    const subdir = join(worktree, 'src');
    mkdirSync(subdir);

    const result = await resolveSession(subdir, SESSION_ID);

    expect(result.ok).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('resolves from a symlinked path', async () => {
    const link = join(root, 'repo-link');
    symlinkSync(worktree, link, 'dir');

    const result = await resolveSession(link, SESSION_ID);

    expect(result.ok).toBe(true);
  });

  it('accepts the override when it names the authorized session directory', async () => {
    process.env.FLOWGUARD_SESSION_DIR = sessionDir;

    const result = await resolveSession(worktree, SESSION_ID);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.sessionDir).toBe(sessionDir);
  });

  it.skipIf(process.platform === 'win32')(
    'accepts a symlinked override that canonicalizes to the authorized session directory',
    async () => {
      const link = join(root, 'session-link');
      symlinkSync(sessionDir, link, 'dir');
      process.env.FLOWGUARD_SESSION_DIR = link;

      const result = await resolveSession(worktree, SESSION_ID);

      expect(result.ok).toBe(true);
    },
  );

  it('rejects an override that names a foreign session directory', async () => {
    const foreign = join(root, 'foreign-session');
    mkdirSync(foreign);
    process.env.FLOWGUARD_SESSION_DIR = foreign;

    const result = await resolveSession(worktree, SESSION_ID);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('SESSION_OVERRIDE_MISMATCH');
  });
});
