import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installHooks, MANAGED_HOOK_MARKER, resolveGitHooksDir } from '../setup-git-hooks.js';

const cleanup: string[] = [];
const silentLog = () => {};

function tempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(directory);
  return directory;
}

function hookSource(sourceDir: string, body = 'echo managed\n'): string {
  mkdirSync(sourceDir, { recursive: true });
  const source = join(sourceDir, 'pre-push');
  writeFileSync(source, `#!/usr/bin/env bash\n${MANAGED_HOOK_MARKER}\n${body}`);
  return source;
}

function initRepository(): string {
  const repo = tempDir('fg-hooks-repo-');
  execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: repo,
    stdio: 'ignore',
  });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo, stdio: 'ignore' });
  writeFileSync(join(repo, 'seed.txt'), 'seed\n');
  execFileSync('git', ['add', 'seed.txt'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo, stdio: 'ignore' });
  return repo;
}

afterEach(() => {
  for (const directory of cleanup.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('git hook installation', () => {
  it('installs into a supplied hooks directory and marks the hook managed', async () => {
    const hooksDir = join(tempDir('fg-hooks-'), 'hooks');
    const sourceDir = tempDir('fg-hooks-source-');
    const source = hookSource(sourceDir);

    const result = await installHooks({ hooksDir, sourceDir, logError: silentLog });

    expect(result.installed).toEqual([join(hooksDir, 'pre-push')]);
    expect(result.preserved).toEqual([]);
    expect(readFileSync(join(hooksDir, 'pre-push'), 'utf8')).toBe(readFileSync(source, 'utf8'));
  });

  it('preserves an existing unmanaged hook without force', async () => {
    const hooksDir = tempDir('fg-hooks-existing-');
    const sourceDir = tempDir('fg-hooks-source-');
    hookSource(sourceDir);
    const destination = join(hooksDir, 'pre-push');
    const custom = '#!/bin/sh\n# local custom hook\n';
    writeFileSync(destination, custom);

    const result = await installHooks({ hooksDir, sourceDir, logError: silentLog });

    expect(result.installed).toEqual([]);
    expect(result.preserved).toEqual([destination]);
    expect(readFileSync(destination, 'utf8')).toBe(custom);
  });

  it('backs up an unmanaged hook before force-installing', async () => {
    const hooksDir = tempDir('fg-hooks-force-');
    const sourceDir = tempDir('fg-hooks-source-');
    hookSource(sourceDir);
    const destination = join(hooksDir, 'pre-push');
    const custom = '#!/bin/sh\n# local custom hook\n';
    writeFileSync(destination, custom);

    const result = await installHooks({
      hooksDir,
      sourceDir,
      force: true,
      logError: silentLog,
    });

    expect(result.installed).toEqual([destination]);
    const backups = readdirSync(hooksDir).filter((name) =>
      name.startsWith('pre-push.flowguard-backup-'),
    );
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(hooksDir, backups[0]!), 'utf8')).toBe(custom);
    expect(readFileSync(destination, 'utf8')).toContain(MANAGED_HOOK_MARKER);
  });

  it('updates an existing managed hook in place', async () => {
    const hooksDir = tempDir('fg-hooks-managed-');
    const sourceDir = tempDir('fg-hooks-source-');
    hookSource(sourceDir, 'echo updated\n');
    writeFileSync(
      join(hooksDir, 'pre-push'),
      `#!/usr/bin/env bash\n${MANAGED_HOOK_MARKER}\necho old\n`,
    );

    const result = await installHooks({ hooksDir, sourceDir, logError: silentLog });

    expect(result.installed).toEqual([join(hooksDir, 'pre-push')]);
    expect(result.preserved).toEqual([]);
    expect(readFileSync(join(hooksDir, 'pre-push'), 'utf8')).toContain('echo updated');
  });

  it('resolves the shared hooks directory from a linked worktree', async () => {
    const repository = initRepository();
    const worktree = join(tempDir('fg-hooks-worktree-parent-'), 'linked');
    execFileSync('git', ['worktree', 'add', '-q', worktree, '-b', 'linked-worktree'], {
      cwd: repository,
      stdio: 'ignore',
    });

    expect(realpathSync(resolveGitHooksDir(worktree)!)).toBe(
      realpathSync(join(repository, '.git', 'hooks')),
    );
  });

  it('reports a missing source hook instead of silently installing nothing', async () => {
    const hooksDir = tempDir('fg-hooks-missing-');
    const sourceDir = tempDir('fg-hooks-empty-source-');

    const result = await installHooks({ hooksDir, sourceDir, logError: silentLog });

    expect(result.installed).toEqual([]);
    expect(result.missingSources).toEqual([join(sourceDir, 'pre-push')]);
  });

  it('returns a skip result when the checkout is not a Git repository', () => {
    const notRepository = tempDir('fg-hooks-not-repo-');
    expect(resolveGitHooksDir(notRepository)).toBeNull();
  });

  it('installs into the shared hooks directory when invoked from a worktree', async () => {
    const repository = initRepository();
    const worktree = join(tempDir('fg-hooks-worktree-install-'), 'linked');
    execFileSync('git', ['worktree', 'add', '-q', worktree, '-b', 'linked-install'], {
      cwd: repository,
      stdio: 'ignore',
    });
    const sourceDir = tempDir('fg-hooks-source-');
    hookSource(sourceDir);

    const result = await installHooks({ repoRoot: worktree, sourceDir, logError: silentLog });

    expect(realpathSync(result.hooksDir!)).toBe(realpathSync(join(repository, '.git', 'hooks')));
    expect(existsSync(join(repository, '.git', 'hooks', 'pre-push'))).toBe(true);
  });
});
