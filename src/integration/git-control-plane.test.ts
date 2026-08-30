/**
 * @module integration/git-control-plane
 * @description Tests for the git control-plane integrity marker (#852) on
 *              REAL git repositories, including a real linked worktree
 *              (`git worktree add`): the marker must be deterministic for an
 *              unchanged control plane and diverge when the common config,
 *              the common hooks, the per-worktree config.worktree, or the
 *              worktree-private HEAD changes.
 *
 * @test-policy HAPPY, BAD, CORNER — stability, mutation, and worktree layout.
 * @version v2
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { computeGitControlPlaneMarker } from './git-control-plane.js';

const execFileAsync = promisify(execFile);

let tmpDir: string;

async function createTmpDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'gov-cp-marker-'));
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

async function initRepo(worktree: string, worktreeName = 'main'): Promise<string> {
  const repo = path.join(worktree, worktreeName);
  await fs.mkdir(repo, { recursive: true });
  await git(repo, ['init']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'Test User']);
  await fs.writeFile(path.join(repo, 'seed.txt'), 'seed\n', 'utf8');
  await git(repo, ['add', 'seed.txt']);
  await git(repo, ['commit', '-m', 'seed']);
  return repo;
}

async function addLinkedWorktree(mainRepo: string, name: string): Promise<string> {
  const linked = path.join(path.dirname(mainRepo), name);
  await git(mainRepo, ['worktree', 'add', '-b', `${name}-branch`, linked]);
  return linked;
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

describe('computeGitControlPlaneMarker on a regular repository', () => {
  it('is deterministic for an unchanged control plane (HAPPY)', async () => {
    const repo = await initRepo(tmpDir);
    const first = await computeGitControlPlaneMarker(repo);
    const second = await computeGitControlPlaneMarker(repo);
    expect(first).toBe(second);
    expect(first.length).toBe(64);
  });

  it('diverges when the common config changes (BAD)', async () => {
    const repo = await initRepo(tmpDir);
    const before = await computeGitControlPlaneMarker(repo);
    await git(repo, ['config', 'core.hooksPath', '.malicious-hooks']);
    const after = await computeGitControlPlaneMarker(repo);
    expect(after).not.toBe(before);
  });

  it('diverges when a hook is added or changed (BAD)', async () => {
    const repo = await initRepo(tmpDir);
    const before = await computeGitControlPlaneMarker(repo);
    const hookPath = path.join(repo, '.git', 'hooks', 'pre-commit');
    await fs.writeFile(hookPath, '#!/bin/sh\nexit 0\n', 'utf8');
    const withHook = await computeGitControlPlaneMarker(repo);
    expect(withHook).not.toBe(before);
    await fs.writeFile(hookPath, '#!/bin/sh\nexit 1\n', 'utf8');
    const changedHook = await computeGitControlPlaneMarker(repo);
    expect(changedHook).not.toBe(withHook);
  });

  it('diverges when HEAD changes (BAD)', async () => {
    const repo = await initRepo(tmpDir);
    const before = await computeGitControlPlaneMarker(repo);
    await git(repo, ['checkout', '-b', 'other']);
    const after = await computeGitControlPlaneMarker(repo);
    expect(after).not.toBe(before);
  });

  it('throws when the worktree is not a git repository (BAD)', async () => {
    const plain = path.join(tmpDir, 'plain');
    await fs.mkdir(plain);
    await expect(computeGitControlPlaneMarker(plain)).rejects.toThrow();
  });
});

describe('computeGitControlPlaneMarker on a real linked worktree', () => {
  it('diverges when the COMMON config changes — invisible to the private git dir (BAD)', async () => {
    const main = await initRepo(tmpDir);
    const linked = await addLinkedWorktree(main, 'linked');

    const before = await computeGitControlPlaneMarker(linked);
    // Mutate the COMMON config: lives in <common>/.git/config, NOT in the
    // linked worktree's private .git/worktrees/<id> dir.
    await git(main, ['config', 'core.hooksPath', '.malicious-hooks']);
    const after = await computeGitControlPlaneMarker(linked);
    expect(after).not.toBe(before);
  });

  it('diverges when a COMMON hook changes (BAD)', async () => {
    const main = await initRepo(tmpDir);
    const linked = await addLinkedWorktree(main, 'linked');

    const before = await computeGitControlPlaneMarker(linked);
    const hookPath = path.join(main, '.git', 'hooks', 'pre-commit');
    await fs.writeFile(hookPath, '#!/bin/sh\nexit 0\n', 'utf8');
    const after = await computeGitControlPlaneMarker(linked);
    expect(after).not.toBe(before);
  });

  it('diverges when the worktree-private HEAD changes (BAD)', async () => {
    const main = await initRepo(tmpDir);
    const linked = await addLinkedWorktree(main, 'linked');

    const before = await computeGitControlPlaneMarker(linked);
    // HEAD of a linked worktree lives in the PRIVATE git dir.
    await git(linked, ['checkout', '-b', 'linked-other']);
    const after = await computeGitControlPlaneMarker(linked);
    expect(after).not.toBe(before);
  });

  it('diverges on the per-worktree config.worktree when extensions.worktreeConfig is active (CORNER)', async () => {
    const main = await initRepo(tmpDir);
    await git(main, ['config', 'extensions.worktreeConfig', 'true']);
    const linked = await addLinkedWorktree(main, 'linked');

    const before = await computeGitControlPlaneMarker(linked);
    await git(linked, ['config', '--worktree', 'core.hooksPath', '.malicious-hooks']);
    const after = await computeGitControlPlaneMarker(linked);
    expect(after).not.toBe(before);

    // The MAIN worktree's marker is unaffected by the linked worktree's
    // private config.worktree.
    const mainBefore = await computeGitControlPlaneMarker(main);
    expect(mainBefore).toBe(await computeGitControlPlaneMarker(main));
  });

  it('produces a stable marker for both worktrees of the same repository (HAPPY)', async () => {
    const main = await initRepo(tmpDir);
    const linked = await addLinkedWorktree(main, 'linked');

    const mainMarker = await computeGitControlPlaneMarker(main);
    const linkedMarker = await computeGitControlPlaneMarker(linked);
    expect(mainMarker.length).toBe(64);
    expect(linkedMarker.length).toBe(64);
    expect(await computeGitControlPlaneMarker(linked)).toBe(linkedMarker);
  });
});
