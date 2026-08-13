/**
 * @module frozen-repository-gitmock.test
 * @description Adversarial tests for frozen-repository acquisition against
 *              MOCKED git/gh subprocess output — covering the fail-closed
 *              branches that a real local git repository cannot produce:
 *              returned-name mismatch, gitlink entries, exact size boundary,
 *              and local-object precedence over remote acquisition.
 *
 * @test-policy HAPPY, BAD, EDGE
 */

import { execFileSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FrozenRepositoryError,
  acquireFrozenRepositoryContent,
  freezeWorktreeCandidate,
  readFrozenBlob,
  resolveFrozenBlobEntry,
} from './frozen-repository.js';

const MOCK = vi.hoisted(() => ({
  lsTreeOutput: '',
  blobBytes: Buffer.alloc(0),
  catFileExists: true,
  ghCalls: 0,
  writeTreeOutput: 'd'.repeat(40),
}));

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
        if (command === 'git') {
          const joined = args.join(' ');
          if (joined.startsWith('ls-tree')) return MOCK.lsTreeOutput;
          if (joined.startsWith('cat-file -e')) {
            if (!MOCK.catFileExists) throw new Error('missing object');
            return '';
          }
          if (joined.startsWith('cat-file blob')) return MOCK.blobBytes;
        }
        if (command === 'gh') {
          MOCK.ghCalls++;
          return Buffer.from('remote-bytes');
        }
        return (original.execFileSync as (...a: unknown[]) => string)(
          command,
          args as never,
          options,
        );
      },
    ),
    execFile: vi.fn(
      (
        command: string,
        args: readonly string[],
        _options: unknown,
        cb: (err: unknown, result: { stdout: string; stderr: string }) => void,
      ) => {
        if (command === 'git') {
          const joined = args.join(' ');
          if (joined.startsWith('write-tree')) {
            cb(null, { stdout: MOCK.writeTreeOutput, stderr: '' });
            return;
          }
          cb(null, { stdout: '', stderr: '' });
          return;
        }
        cb(new Error('unexpected execFile call'), { stdout: '', stderr: '' });
      },
    ),
  };
});

beforeEach(() => {
  MOCK.lsTreeOutput = '';
  MOCK.blobBytes = Buffer.alloc(0);
  MOCK.catFileExists = true;
  MOCK.ghCalls = 0;
  MOCK.writeTreeOutput = 'd'.repeat(40);
});

const REMOTE_IDENTITY = { host: 'github.com', owner: 'acme', name: 'repo' } as const;
const COMMIT_SHA = 'a'.repeat(40);

function remoteTarget(objectSha = COMMIT_SHA) {
  return { kind: 'commit' as const, repositoryIdentity: REMOTE_IDENTITY, objectSha };
}

function localTreeTarget(objectSha: string) {
  return {
    kind: 'tree' as const,
    repositoryIdentity: { kind: 'local' as const, rootCommitDigest: 'sha256:' + 'b'.repeat(64) },
    objectSha,
  };
}

describe('returned-name equality is enforced', () => {
  it('BAD: git resolving a DIFFERENT entry name fails closed', () => {
    MOCK.lsTreeOutput = `100644 blob ${'d'.repeat(40)}\tother.txt\0`;
    try {
      resolveFrozenBlobEntry('/tmp/repo', COMMIT_SHA, 'foo.txt');
      throw new Error('expected FrozenRepositoryError');
    } catch (err) {
      expect((err as FrozenRepositoryError).code).toBe('PATH_NOT_IN_TREE');
    }
  });

  it('HAPPY: exact name equality resolves the blob', () => {
    MOCK.lsTreeOutput = `100644 blob ${'d'.repeat(40)}\tfoo.txt\0`;
    MOCK.blobBytes = Buffer.from('bytes\n');
    const entry = resolveFrozenBlobEntry('/tmp/repo', COMMIT_SHA, 'foo.txt');
    expect(entry.objectSha).toBe('d'.repeat(40));
    expect(readFrozenBlob('/tmp/repo', entry.objectSha).toString('utf-8')).toBe('bytes\n');
  });

  it('BAD: gitlink entries fail closed locally', () => {
    MOCK.lsTreeOutput = `160000 commit ${'d'.repeat(40)}\tsub\0`;
    try {
      resolveFrozenBlobEntry('/tmp/repo', COMMIT_SHA, 'sub');
      throw new Error('expected FrozenRepositoryError');
    } catch (err) {
      expect((err as FrozenRepositoryError).code).toBe('UNSUPPORTED_ENTRY');
    }
  });

  it('BAD: unparseable meta fails closed', () => {
    MOCK.lsTreeOutput = `garbage meta record\tfoo.txt\0`;
    try {
      resolveFrozenBlobEntry('/tmp/repo', COMMIT_SHA, 'foo.txt');
      throw new Error('expected FrozenRepositoryError');
    } catch (err) {
      expect((err as FrozenRepositoryError).code).toBe('ACQUISITION_FAILED');
    }
  });
});

describe('size bound is exact', () => {
  it('EDGE: exactly MAX bytes is accepted, MAX+1 fails closed', () => {
    const MAX = 1024 * 1024;
    MOCK.blobBytes = Buffer.alloc(MAX, 0x61);
    expect(readFrozenBlob('/tmp/repo', 'd'.repeat(40)).length).toBe(MAX);
    MOCK.blobBytes = Buffer.alloc(MAX + 1, 0x61);
    try {
      readFrozenBlob('/tmp/repo', 'd'.repeat(40));
      throw new Error('expected FrozenRepositoryError');
    } catch (err) {
      expect((err as FrozenRepositoryError).code).toBe('OVERSIZED_BLOB');
    }
  });
});

describe('candidate freeze output validation', () => {
  it('HAPPY: valid write-tree output becomes the frozen tree sha', async () => {
    const treeSha = await freezeWorktreeCandidate('/tmp/repo', COMMIT_SHA);
    expect(treeSha).toBe('d'.repeat(40));
  });

  it('BAD: non-sha write-tree output fails closed', async () => {
    MOCK.writeTreeOutput = 'not-a-sha\n';
    await expect(freezeWorktreeCandidate('/tmp/repo', COMMIT_SHA)).rejects.toMatchObject({
      code: 'FREEZE_FAILED',
    });
  });
});

describe('local object precedence and remote fallback', () => {
  it('HAPPY: existing local object is used; remote backend is never invoked', () => {
    MOCK.catFileExists = true;
    MOCK.lsTreeOutput = `100644 blob ${'d'.repeat(40)}\tfoo.txt\0`;
    MOCK.blobBytes = Buffer.from('local-bytes\n');
    const content = acquireFrozenRepositoryContent('/tmp/repo', remoteTarget(), 'foo.txt');
    expect(content.kind).toBe('local_git_object');
    expect(content.bytes.toString('utf-8')).toBe('local-bytes\n');
    expect(MOCK.ghCalls).toBe(0);
  });

  it('BAD: empty remote path fails closed before any API call', () => {
    MOCK.catFileExists = false;
    try {
      acquireFrozenRepositoryContent('/tmp/repo', remoteTarget(), '');
      throw new Error('expected FrozenRepositoryError');
    } catch (err) {
      expect((err as FrozenRepositoryError).code).toBe('PATH_NOT_IN_TREE');
    }
    expect(MOCK.ghCalls).toBe(0);
  });

  it('BAD: local repository identities never reach a remote backend', () => {
    MOCK.catFileExists = false;
    MOCK.lsTreeOutput = '';
    const target = {
      kind: 'commit' as const,
      repositoryIdentity: { kind: 'local' as const, rootCommitDigest: 'sha256:' + 'b'.repeat(64) },
      objectSha: COMMIT_SHA,
    };
    try {
      acquireFrozenRepositoryContent('/tmp/repo', target, 'foo.txt');
      throw new Error('expected FrozenRepositoryError');
    } catch (err) {
      expect(err).toBeInstanceOf(FrozenRepositoryError);
    }
    expect(MOCK.ghCalls).toBe(0);
  });

  it('HAPPY: tree targets never reach the remote backend', () => {
    MOCK.lsTreeOutput = `100644 blob ${'d'.repeat(40)}\tfoo.txt\0`;
    MOCK.blobBytes = Buffer.from('tree-bytes\n');
    const content = acquireFrozenRepositoryContent(
      '/tmp/repo',
      localTreeTarget(COMMIT_SHA),
      'foo.txt',
    );
    expect(content.kind).toBe('local_git_object');
    expect(MOCK.ghCalls).toBe(0);
  });
});
