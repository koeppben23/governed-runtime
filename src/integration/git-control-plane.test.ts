/**
 * @module integration/git-control-plane
 * @description Tests for the git control-plane integrity marker (#852): the
 *              marker must be deterministic for an unchanged control plane
 *              and diverge when config, hooks, HEAD, or the .git reference
 *              itself changes — including a linked-worktree gitfile layout.
 *
 * @test-policy HAPPY, BAD, CORNER — stability, mutation, and gitfile layout.
 * @version v1
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { computeGitControlPlaneMarker } from './git-control-plane.js';

let tmpDir: string;

async function createTmpDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'gov-cp-marker-'));
}

beforeEach(async () => {
  tmpDir = await createTmpDir();
});

afterEach(async () => {
  try {
    await fs.rm(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore cleanup errors */
  }
});

async function seedGitDir(worktree: string): Promise<void> {
  await fs.mkdir(path.join(worktree, '.git', 'hooks'), { recursive: true });
  await fs.writeFile(
    path.join(worktree, '.git', 'config'),
    '[core]\n\trepositoryformatversion = 0\n',
    'utf8',
  );
  await fs.writeFile(path.join(worktree, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
}

describe('computeGitControlPlaneMarker', () => {
  it('is deterministic for an unchanged control plane (HAPPY)', async () => {
    await seedGitDir(tmpDir);
    const first = await computeGitControlPlaneMarker(tmpDir);
    const second = await computeGitControlPlaneMarker(tmpDir);
    expect(first).toBe(second);
    expect(first.length).toBe(64);
  });

  it('diverges when .git/config changes (BAD)', async () => {
    await seedGitDir(tmpDir);
    const before = await computeGitControlPlaneMarker(tmpDir);
    await fs.writeFile(
      path.join(tmpDir, '.git', 'config'),
      '[core]\n\thooksPath = .malicious-hooks\n',
      'utf8',
    );
    const after = await computeGitControlPlaneMarker(tmpDir);
    expect(after).not.toBe(before);
  });

  it('diverges when a hook is added or changed (BAD)', async () => {
    await seedGitDir(tmpDir);
    const before = await computeGitControlPlaneMarker(tmpDir);
    await fs.writeFile(
      path.join(tmpDir, '.git', 'hooks', 'pre-commit'),
      '#!/bin/sh\nexit 0\n',
      'utf8',
    );
    const withHook = await computeGitControlPlaneMarker(tmpDir);
    expect(withHook).not.toBe(before);
    await fs.writeFile(
      path.join(tmpDir, '.git', 'hooks', 'pre-commit'),
      '#!/bin/sh\nexit 1\n',
      'utf8',
    );
    const changedHook = await computeGitControlPlaneMarker(tmpDir);
    expect(changedHook).not.toBe(withHook);
  });

  it('diverges when HEAD changes (BAD)', async () => {
    await seedGitDir(tmpDir);
    const before = await computeGitControlPlaneMarker(tmpDir);
    await fs.writeFile(path.join(tmpDir, '.git', 'HEAD'), 'ref: refs/heads/other\n', 'utf8');
    const after = await computeGitControlPlaneMarker(tmpDir);
    expect(after).not.toBe(before);
  });

  it('diverges when the .git reference disappears (BAD)', async () => {
    await seedGitDir(tmpDir);
    const before = await computeGitControlPlaneMarker(tmpDir);
    await fs.rm(path.join(tmpDir, '.git'), { recursive: true, force: true });
    const after = await computeGitControlPlaneMarker(tmpDir);
    expect(after).not.toBe(before);
  });

  it('follows a linked-worktree gitfile to the real git dir (CORNER)', async () => {
    const main = path.join(tmpDir, 'main');
    const linked = path.join(tmpDir, 'linked');
    await fs.mkdir(main, { recursive: true });
    await seedGitDir(main);
    await fs.mkdir(linked);
    await fs.writeFile(path.join(linked, '.git'), `gitdir: ${path.join(main, '.git')}\n`, 'utf8');

    const mainMarker = await computeGitControlPlaneMarker(main);
    const linkedMarker = await computeGitControlPlaneMarker(linked);
    expect(linkedMarker).toBe(mainMarker);

    await fs.writeFile(
      path.join(main, '.git', 'config'),
      '[core]\n\thooksPath = .malicious-hooks\n',
      'utf8',
    );
    const diverged = await computeGitControlPlaneMarker(linked);
    expect(diverged).not.toBe(linkedMarker);
  });
});
