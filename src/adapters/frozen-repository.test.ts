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
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FrozenRepositoryError,
  acquireFrozenRepositoryContent,
  freezeWorktreeCandidate,
  frozenObjectType,
  readFrozenBlob,
  resolveFrozenBlobEntry,
} from './frozen-repository.js';

const GH_RESPONSES = vi.hoisted(() => [] as Array<string | Buffer>);

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return {
    ...original,
    execFileSync: vi.fn(
      (
        command: string,
        args: readonly string[],
        options?: Parameters<typeof original.execFileSync>[2],
      ) => {
        if (command === 'gh') {
          return GH_RESPONSES.shift() ?? '';
        }
        return (original.execFileSync as (...a: unknown[]) => string)(
          command,
          args as never,
          options,
        );
      },
    ),
  };
});

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

describe('pathspec magic can never alias a different tree entry', () => {
  let pathSha: string;

  beforeAll(() => {
    // Files whose names collide with git pathspec magic.
    fs.writeFileSync(path.join(repo, ':foo.ts'), 'colonfile\n');
    fs.writeFileSync(path.join(repo, 'foo.ts'), 'plainfile\n');
    fs.writeFileSync(path.join(repo, ':(literal)foo.ts'), 'magicfile\n');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'pathspec'], { cwd: repo });
    pathSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim();
  });

  it('HAPPY: literal `:foo.ts` resolves the file literally named `:foo.ts`', () => {
    const entry = resolveFrozenBlobEntry(repo, pathSha, ':foo.ts');
    expect(readFrozenBlob(repo, entry.objectSha).toString('utf-8')).toBe('colonfile\n');
  });

  it('HAPPY: `foo.ts` resolves the plain file, never the colon-prefixed one', () => {
    const entry = resolveFrozenBlobEntry(repo, pathSha, 'foo.ts');
    expect(readFrozenBlob(repo, entry.objectSha).toString('utf-8')).toBe('plainfile\n');
  });

  it('HAPPY: a file literally named `:(literal)foo.ts` resolves to itself', () => {
    const entry = resolveFrozenBlobEntry(repo, pathSha, ':(literal)foo.ts');
    expect(readFrozenBlob(repo, entry.objectSha).toString('utf-8')).toBe('magicfile\n');
  });

  it('BAD: `:(top)foo.ts` magic can never alias the plain `foo.ts` entry', () => {
    try {
      resolveFrozenBlobEntry(repo, pathSha, ':(top)foo.ts');
      throw new Error('expected FrozenRepositoryError');
    } catch (err) {
      expect((err as FrozenRepositoryError).code).toBe('PATH_NOT_IN_TREE');
    }
  });

  it('BAD: glob magic `*.ts` fails closed (no entry equality possible)', () => {
    try {
      resolveFrozenBlobEntry(repo, pathSha, '*.ts');
      throw new Error('expected FrozenRepositoryError');
    } catch (err) {
      expect((err as FrozenRepositoryError).code).toBe('PATH_NOT_IN_TREE');
    }
  });
});

describe('remote acquisition: exact Git object semantics', () => {
  const REMOTE_IDENTITY = {
    host: 'github.enterprise.example',
    owner: 'acme',
    name: 'repo',
  } as const;
  const COMMIT_SHA = 'a'.repeat(40);

  function acquireRemote(pathValue: string): Buffer {
    const target = {
      kind: 'commit' as const,
      repositoryIdentity: REMOTE_IDENTITY,
      objectSha: COMMIT_SHA,
    };
    return acquireFrozenRepositoryContent('/nonexistent-worktree', target, pathValue).bytes;
  }

  beforeEach(() => {
    GH_RESPONSES.length = 0;
  });

  it('HAPPY: walks the tree to the exact blob sha, fetches exactly that blob, and addresses the frozen host', () => {
    GH_RESPONSES.push(
      JSON.stringify({
        tree: [{ path: 'src', mode: '040000', type: 'tree', sha: 'b'.repeat(40) }],
      }),
      JSON.stringify({
        tree: [{ path: 'foo.ts', mode: '100644', type: 'blob', sha: 'c'.repeat(40) }],
      }),
      Buffer.from('remote-bytes\n'),
    );
    const bytes = acquireRemote('src/foo.ts');
    expect(bytes.toString('utf-8')).toBe('remote-bytes\n');
    const execFileSyncMock = vi.mocked(execFileSync);
    const ghCalls = execFileSyncMock.mock.calls.filter(([command]) => command === 'gh');
    expect(ghCalls).toHaveLength(3);
    // Every gh call addresses the frozen host explicitly.
    for (const [, args] of ghCalls) {
      expect(args).toContain('--hostname');
      expect(args).toContain('github.enterprise.example');
    }
    // The blob fetch targets the exact git blob object, not a contents projection.
    const blobCall = ghCalls[2];
    expect(blobCall?.[1]).toEqual(
      expect.arrayContaining([`repos/acme/repo/git/blobs/${'c'.repeat(40)}`]),
    );
  });

  it('BAD: gitlink entries fail closed remotely', () => {
    GH_RESPONSES.push(
      JSON.stringify({
        tree: [{ path: 'sub', mode: '160000', type: 'commit', sha: 'd'.repeat(40) }],
      }),
    );
    try {
      acquireRemote('sub');
      throw new Error('expected FrozenRepositoryError');
    } catch (err) {
      expect((err as FrozenRepositoryError).code).toBe('UNSUPPORTED_ENTRY');
    }
  });

  it('BAD: truncated trees fail closed', () => {
    GH_RESPONSES.push(JSON.stringify({ tree: [], truncated: true }));
    try {
      acquireRemote('src/foo.ts');
      throw new Error('expected FrozenRepositoryError');
    } catch (err) {
      expect((err as FrozenRepositoryError).code).toBe('OBJECT_UNAVAILABLE');
    }
  });

  it('BAD: path traversing through a blob entry fails closed', () => {
    GH_RESPONSES.push(
      JSON.stringify({
        tree: [{ path: 'src', mode: '100644', type: 'blob', sha: 'b'.repeat(40) }],
      }),
    );
    try {
      acquireRemote('src/foo.ts');
      throw new Error('expected FrozenRepositoryError');
    } catch (err) {
      expect((err as FrozenRepositoryError).code).toBe('PATH_NOT_IN_TREE');
    }
  });

  it('BAD: directory as final segment fails closed (not a blob)', () => {
    GH_RESPONSES.push(
      JSON.stringify({
        tree: [{ path: 'foo.ts', mode: '040000', type: 'tree', sha: 'b'.repeat(40) }],
      }),
    );
    try {
      acquireRemote('foo.ts');
      throw new Error('expected FrozenRepositoryError');
    } catch (err) {
      expect((err as FrozenRepositoryError).code).toBe('PATH_NOT_IN_TREE');
    }
  });

  it('BAD: missing remote path fails closed with no fallback', () => {
    GH_RESPONSES.push(
      JSON.stringify({
        tree: [{ path: 'other', mode: '100644', type: 'blob', sha: 'e'.repeat(40) }],
      }),
    );
    try {
      acquireRemote('src/foo.ts');
      throw new Error('expected FrozenRepositoryError');
    } catch (err) {
      expect((err as FrozenRepositoryError).code).toBe('PATH_NOT_IN_TREE');
    }
  });
});
