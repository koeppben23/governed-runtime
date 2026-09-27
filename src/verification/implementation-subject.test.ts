/**
 * @module verification/implementation-subject.test
 * @description Real-git integration contract for governed implementation
 * subject re-attestation: add, delete, rename and modify must all fail closed,
 * and baseline-scoped pre-existing dirt must not.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { hashText } from '../shared/hashing.js';
import { hashWorktreeFiles } from '../adapters/git.js';
import {
  computeImplementationDigest,
  reattestImplementationSubject,
} from './implementation-subject.js';

const cleanup: string[] = [];

function git(worktree: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: worktree, encoding: 'utf-8' });
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'impl-subject-'));
  cleanup.push(dir);
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  write(dir, 'README.md', 'base');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}

function write(worktree: string, path: string, content: string): void {
  mkdirSync(dirname(join(worktree, path)), { recursive: true });
  writeFileSync(join(worktree, path), content);
}

const digestFn = hashText;

async function frozenDigest(worktree: string, files: readonly string[]): Promise<string> {
  return computeImplementationDigest({ worktree, files, digest: digestFn });
}

afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('reattestImplementationSubject', () => {
  it('HAPPY: proves the frozen doc-only subject while the worktree is unchanged', async () => {
    const worktree = makeRepo();
    write(worktree, 'docs/usage-notes.md', 'notes');
    const frozen = ['docs/usage-notes.md'];
    const digest = await frozenDigest(worktree, frozen);

    const result = await reattestImplementationSubject({
      worktree,
      frozenFiles: frozen,
      expectedDigest: digest,
      baseline: null,
      digest: digestFn,
    });

    expect(result).toEqual({ kind: 'ok', digest });
  });

  it('BAD: a file added after the freeze fails closed (not in the stored list)', async () => {
    const worktree = makeRepo();
    write(worktree, 'docs/usage-notes.md', 'notes');
    const frozen = ['docs/usage-notes.md'];
    const digest = await frozenDigest(worktree, frozen);

    write(worktree, 'src/security/policy.ts', 'export const policy = 1;');

    const result = await reattestImplementationSubject({
      worktree,
      frozenFiles: frozen,
      expectedDigest: digest,
      baseline: null,
      digest: digestFn,
    });

    expect(result.kind).toBe('subject_changed');
  });

  it('BAD: a modified frozen file fails closed', async () => {
    const worktree = makeRepo();
    write(worktree, 'docs/usage-notes.md', 'notes');
    const frozen = ['docs/usage-notes.md'];
    const digest = await frozenDigest(worktree, frozen);

    write(worktree, 'docs/usage-notes.md', 'notes changed');

    const result = await reattestImplementationSubject({
      worktree,
      frozenFiles: frozen,
      expectedDigest: digest,
      baseline: null,
      digest: digestFn,
    });

    expect(result.kind).toBe('subject_changed');
  });

  it('BAD: a deleted frozen file fails closed', async () => {
    const worktree = makeRepo();
    write(worktree, 'docs/usage-notes.md', 'notes');
    const frozen = ['docs/usage-notes.md'];
    const digest = await frozenDigest(worktree, frozen);

    unlinkSync(join(worktree, 'docs/usage-notes.md'));

    const result = await reattestImplementationSubject({
      worktree,
      frozenFiles: frozen,
      expectedDigest: digest,
      baseline: null,
      digest: digestFn,
    });

    expect(result.kind).toBe('subject_changed');
  });

  it('BAD: a rename fails closed', async () => {
    const worktree = makeRepo();
    write(worktree, 'docs/usage-notes.md', 'notes');
    git(worktree, 'add', 'docs/usage-notes.md');
    const frozen = ['docs/usage-notes.md'];
    const digest = await frozenDigest(worktree, frozen);

    git(worktree, 'mv', 'docs/usage-notes.md', 'docs/notes-renamed.md');

    const result = await reattestImplementationSubject({
      worktree,
      frozenFiles: frozen,
      expectedDigest: digest,
      baseline: null,
      digest: digestFn,
    });

    expect(result.kind).toBe('subject_changed');
  });

  it('CORNER: unchanged pre-existing dirt is scoped out by the frozen baseline', async () => {
    const worktree = makeRepo();
    write(worktree, 'package.json', '{"version":"dirty"}');
    const dirtyHash = (await hashWorktreeFiles(worktree, ['package.json']))['package.json']!;
    write(worktree, 'docs/usage-notes.md', 'notes');
    const frozen = ['docs/usage-notes.md'];
    const digest = await frozenDigest(worktree, frozen);

    const result = await reattestImplementationSubject({
      worktree,
      frozenFiles: frozen,
      expectedDigest: digest,
      baseline: {
        dirtyFiles: [{ path: 'package.json', hash: dirtyHash }],
        capturedAt: '2026-01-01T00:00:00.000Z',
      },
      digest: digestFn,
    });

    expect(result).toEqual({ kind: 'ok', digest });
  });

  it('EDGE: pre-existing dirt modified since the baseline is kept and fails closed', async () => {
    const worktree = makeRepo();
    write(worktree, 'package.json', '{"version":"dirty"}');
    const dirtyHash = (await hashWorktreeFiles(worktree, ['package.json']))['package.json']!;
    write(worktree, 'docs/usage-notes.md', 'notes');
    const frozen = ['docs/usage-notes.md'];
    const digest = await frozenDigest(worktree, frozen);

    write(worktree, 'package.json', '{"version":"changed after freeze"}');

    const result = await reattestImplementationSubject({
      worktree,
      frozenFiles: frozen,
      expectedDigest: digest,
      baseline: {
        dirtyFiles: [{ path: 'package.json', hash: dirtyHash }],
        capturedAt: '2026-01-01T00:00:00.000Z',
      },
      digest: digestFn,
    });

    expect(result.kind).toBe('subject_changed');
  });
});
