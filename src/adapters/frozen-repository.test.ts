/**
 * @module frozen-repository.test
 * @description Unit tests for the immutable frozen-repository acquisition
 *              primitives against a real temporary git repository.
 *
 * @test-policy HAPPY, BAD, CORNER
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FrozenRepositoryError,
  acquireFrozenRepositoryContent,
  freezeWorktreeCandidate,
  frozenObjectType,
  readFrozenBlob,
  resolveFrozenBlobEntry,
} from './frozen-repository.js';

let repo: string;
let baseSha: string;

function git(args: string[], cwd = repo): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-frozen-repo-'));
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base-content\n');
  fs.writeFileSync(path.join(repo, 'sub/keep.txt'), 'keep\n');
  fs.writeFileSync(path.join(repo, 'ignored.tmp'), 'ignored\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), '*.tmp\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base']);
  baseSha = git(['rev-parse', 'HEAD']);
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('freezeWorktreeCandidate', () => {
  it('HAPPY: freezes worktree changes as a tree without touching the live index', async () => {
    fs.writeFileSync(path.join(repo, 'base.txt'), 'base-content-CHANGED\n');
    fs.writeFileSync(path.join(repo, 'new.txt'), 'new-file\n');
    fs.rmSync(path.join(repo, 'sub/keep.txt'));
    const indexBefore = fs.existsSync(path.join(repo, '.git', 'index'))
      ? fs.statSync(path.join(repo, '.git', 'index')).mtimeMs
      : null;

    const treeSha = await freezeWorktreeCandidate(repo, baseSha);
    expect(treeSha).toMatch(/^[a-f0-9]{40}$/);
    expect(frozenObjectType(repo, treeSha)).toBe('tree');

    // Live index untouched by the candidate freeze.
    if (indexBefore !== null) {
      expect(fs.statSync(path.join(repo, '.git', 'index')).mtimeMs).toBe(indexBefore);
    }
    // Deletion + modification + new non-ignored file are in the candidate.
    expect(resolveFrozenBlobEntry(repo, treeSha, 'new.txt').objectSha).toMatch(/^[a-f0-9]{40}$/);
    expect(() => resolveFrozenBlobEntry(repo, treeSha, 'sub/keep.txt')).toThrow(
      FrozenRepositoryError,
    );
    // Ignored file never enters the candidate.
    expect(() => resolveFrozenBlobEntry(repo, treeSha, 'ignored.tmp')).toThrow(
      FrozenRepositoryError,
    );
  });
});

describe('acquireFrozenRepositoryContent', () => {
  it('HAPPY: tree target acquires the changed blob bytes from the local ODB', async () => {
    fs.writeFileSync(path.join(repo, 'base.txt'), 'base-content-CHANGED\n');
    fs.writeFileSync(path.join(repo, 'new.txt'), 'new-file\n');
    const treeSha = await freezeWorktreeCandidate(repo, baseSha);
    const target = {
      kind: 'tree' as const,
      repositoryIdentity: { kind: 'local' as const, rootCommitDigest: 'sha256:' + 'f'.repeat(64) },
      objectSha: treeSha,
    };
    const content = acquireFrozenRepositoryContent(repo, target, 'new.txt');
    expect(content.kind).toBe('local_git_object');
    expect(content.bytes.toString('utf-8')).toBe('new-file\n');
  });

  it('HAPPY: commit target resolves exact base bytes', () => {
    fs.writeFileSync(path.join(repo, 'base.txt'), 'base-content-CHANGED\n');
    const target = {
      kind: 'commit' as const,
      repositoryIdentity: { kind: 'local' as const, rootCommitDigest: 'sha256:' + 'f'.repeat(64) },
      objectSha: baseSha,
    };
    const content = acquireFrozenRepositoryContent(repo, target, 'base.txt');
    expect(content.bytes.toString('utf-8')).toBe('base-content\n');
  });

  it('BAD: missing path in frozen tree fails closed with no fallback', () => {
    const target = {
      kind: 'commit' as const,
      repositoryIdentity: { kind: 'local' as const, rootCommitDigest: 'sha256:' + 'f'.repeat(64) },
      objectSha: baseSha,
    };
    expect(() => acquireFrozenRepositoryContent(repo, target, 'does-not-exist.ts')).toThrow(
      FrozenRepositoryError,
    );
  });
});

describe('readFrozenBlob', () => {
  it('HAPPY: reads exact raw blob bytes', () => {
    const entry = resolveFrozenBlobEntry(repo, baseSha, 'base.txt');
    expect(readFrozenBlob(repo, entry.objectSha).toString('utf-8')).toBe('base-content\n');
  });
});
