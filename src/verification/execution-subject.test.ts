import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  attestExecutionSubject,
  reattestExecutionSubject,
  type ExecutionSubjectAttestation,
} from './execution-subject.js';
import { hashText } from '../shared/hashing.js';
import { hashWorktreeFiles } from '../adapters/git.js';

const cleanup: string[] = [];

function makeWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'exec-subject-'));
  cleanup.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function write(dir: string, path: string, content: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}

function implementationDigestFor(files: Array<[string, string | null]>): string {
  return hashText(files.map(([f, hash]) => `${f}:${hash ?? 'deleted'}`).join('\n'));
}

describe('attestExecutionSubject', () => {
  it('returns ok with a no-surfaces digest for empty inputs', async () => {
    const result = await attestExecutionSubject([], makeWorktree(), 'irrelevant', []);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.attestation.digest).toBe(hashText('no-surfaces'));
      expect(result.attestation.surfaceDigests.size).toBe(0);
    }
  });

  it('attests the implementation digest for the sorted changed files', async () => {
    const worktree = makeWorktree();
    write(worktree, 'b.txt', 'beta');
    write(worktree, 'a.txt', 'alpha');
    const hashes = await hashWorktreeFiles(worktree, ['a.txt', 'b.txt']);
    const expected = implementationDigestFor([
      ['a.txt', hashes['a.txt']!],
      ['b.txt', hashes['b.txt']!],
    ]);
    // changedFiles deliberately unsorted: attestation must sort deterministically.
    const result = await attestExecutionSubject([{ kind: 'implementation' }], worktree, expected, [
      'b.txt',
      'a.txt',
    ]);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.attestation.surfaceDigests.get('implementation')).toBe(expected);
      expect(result.attestation.digest).toBe(hashText(`implementation:${expected}`));
    }
  });

  it('reports subject_changed pre_execution on an implementation digest mismatch', async () => {
    const worktree = makeWorktree();
    write(worktree, 'src/main.ts', 'actual content');
    const hashes = await hashWorktreeFiles(worktree, ['src/main.ts']);
    const computed = implementationDigestFor([['src/main.ts', hashes['src/main.ts']!]]);
    const result = await attestExecutionSubject(
      [{ kind: 'implementation' }],
      worktree,
      hashText('stale-state-digest'),
      ['src/main.ts'],
    );
    expect(result.kind).toBe('subject_changed');
    if (result.kind === 'subject_changed') {
      expect(result.component).toBe('implementation');
      expect(result.phase).toBe('pre_execution');
      expect(result.detail).toBe(
        `implementation digest mismatch: expected ${hashText('stale-state-digest').slice(0, 8)}..., computed ${computed.slice(0, 8)}...`,
      );
    }
  });

  it('skips implementation attestation when no files changed', async () => {
    const worktree = makeWorktree();
    const result = await attestExecutionSubject(
      [{ kind: 'implementation' }],
      worktree,
      hashText('state-digest'),
      [],
    );
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.attestation.surfaceDigests.has('implementation')).toBe(false);
      expect(result.attestation.digest).toBe(hashText(''));
    }
  });

  it('attests a readable file surface', async () => {
    const worktree = makeWorktree();
    write(worktree, 'vitest.config.ts', 'export default {}');
    const contentDigest = hashText('export default {}');
    const result = await attestExecutionSubject(
      [{ kind: 'file', path: 'vitest.config.ts' }],
      worktree,
      'irrelevant',
      [],
    );
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.attestation.surfaceDigests.get('vitest.config.ts')).toBe(contentDigest);
      expect(result.attestation.digest).toBe(hashText(`vitest.config.ts:${contentDigest}`));
    }
  });

  it('reports subject_changed pre_execution when a file surface cannot be read', async () => {
    const result = await attestExecutionSubject(
      [{ kind: 'file', path: 'missing.config.ts' }],
      makeWorktree(),
      'irrelevant',
      [],
    );
    expect(result.kind).toBe('subject_changed');
    if (result.kind === 'subject_changed') {
      expect(result.component).toBe('execution_surface');
      expect(result.phase).toBe('pre_execution');
      expect(result.detail).toBe('cannot read execution surface: missing.config.ts');
    }
  });

  it('ignores input kinds outside the implementation/file union', async () => {
    const result = await attestExecutionSubject(
      // @ts-expect-error unknown kind exercises the else-if guard
      [{ kind: 'registry' }],
      makeWorktree(),
      'irrelevant',
      [],
    );
    expect(result.kind).toBe('ok');
  });

  it('hashes deleted changed files as the deleted placeholder', async () => {
    const worktree = makeWorktree();
    write(worktree, 'kept.ts', 'still here');
    const hashes = await hashWorktreeFiles(worktree, ['deleted.ts', 'kept.ts']);
    const expected = implementationDigestFor([
      ['deleted.ts', null],
      ['kept.ts', hashes['kept.ts']!],
    ]);
    const result = await attestExecutionSubject([{ kind: 'implementation' }], worktree, expected, [
      'kept.ts',
      'deleted.ts',
    ]);
    expect(result.kind).toBe('ok');
  });

  it('combines implementation and file surfaces into one sorted digest', async () => {
    const worktree = makeWorktree();
    write(worktree, 'src/app.ts', 'code');
    write(worktree, 'a.config.ts', 'config');
    const implHashes = await hashWorktreeFiles(worktree, ['src/app.ts']);
    const impl = implementationDigestFor([['src/app.ts', implHashes['src/app.ts']!]]);
    const fileDigest = hashText('config');
    // Insertion order (implementation first) differs from sorted order so the
    // final sort is observable.
    const parts = [`implementation:${impl}`, `a.config.ts:${fileDigest}`].sort();
    const result = await attestExecutionSubject(
      [{ kind: 'implementation' }, { kind: 'file', path: 'a.config.ts' }],
      worktree,
      impl,
      ['src/app.ts'],
    );
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.attestation.digest).toBe(hashText(parts.join('\n')));
    }
  });
});

describe('reattestExecutionSubject', () => {
  const preAttestation = (surfaceDigests: [string, string][]): ExecutionSubjectAttestation => ({
    inputs: [],
    digest: 'pre',
    surfaceDigests: new Map(surfaceDigests),
  });

  it('reports subject_changed post_execution when the implementation changed', async () => {
    const worktree = makeWorktree();
    write(worktree, 'src/main.ts', 'before');
    const beforeHashes = await hashWorktreeFiles(worktree, ['src/main.ts']);
    const beforeDigest = implementationDigestFor([['src/main.ts', beforeHashes['src/main.ts']!]]);
    write(worktree, 'src/main.ts', 'after');
    const afterHashes = await hashWorktreeFiles(worktree, ['src/main.ts']);
    const afterDigest = implementationDigestFor([['src/main.ts', afterHashes['src/main.ts']!]]);
    const result = await reattestExecutionSubject(
      [{ kind: 'implementation' }],
      worktree,
      preAttestation([['implementation', beforeDigest]]),
      beforeDigest,
      ['src/main.ts'],
    );
    expect(result.kind).toBe('subject_changed');
    if (result.kind === 'subject_changed') {
      expect(result.component).toBe('implementation');
      expect(result.phase).toBe('post_execution');
      expect(result.detail).toBe(
        `implementation digest changed during execution: expected ${beforeDigest.slice(0, 8)}..., computed ${afterDigest.slice(0, 8)}...`,
      );
    }
  });

  it('returns ok with the pre-attestation when the implementation is unchanged', async () => {
    const worktree = makeWorktree();
    write(worktree, 'src/main.ts', 'stable');
    const stableHashes = await hashWorktreeFiles(worktree, ['src/main.ts']);
    const digest = implementationDigestFor([['src/main.ts', stableHashes['src/main.ts']!]]);
    const pre = preAttestation([['implementation', digest]]);
    const result = await reattestExecutionSubject(
      [{ kind: 'implementation' }],
      worktree,
      pre,
      digest,
      ['src/main.ts'],
    );
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.attestation).toBe(pre);
    }
  });

  it('sorts changed files deterministically in the re-attestation digest', async () => {
    const worktree = makeWorktree();
    write(worktree, 'b.ts', 'beta');
    write(worktree, 'a.ts', 'alpha');
    const hashes = await hashWorktreeFiles(worktree, ['a.ts', 'b.ts']);
    const digest = implementationDigestFor([
      ['a.ts', hashes['a.ts']!],
      ['b.ts', hashes['b.ts']!],
    ]);
    const pre = preAttestation([['implementation', digest]]);
    // Deliberately unsorted: the re-attestation must sort before hashing.
    const result = await reattestExecutionSubject(
      [{ kind: 'implementation' }],
      worktree,
      pre,
      digest,
      ['b.ts', 'a.ts'],
    );
    expect(result.kind).toBe('ok');
  });

  it('skips the implementation check when no files changed', async () => {
    const worktree = makeWorktree();
    const result = await reattestExecutionSubject(
      [{ kind: 'implementation' }],
      worktree,
      preAttestation([['implementation', hashText('expected-surface')]]),
      hashText('state'),
      [],
    );
    expect(result.kind).toBe('ok');
  });

  it('ignores input kinds outside the implementation/file union', async () => {
    const result = await reattestExecutionSubject(
      // @ts-expect-error unknown kind exercises the else-if guard
      [{ kind: 'registry' }],
      makeWorktree(),
      preAttestation([]),
      'irrelevant',
      [],
    );
    expect(result.kind).toBe('ok');
  });

  it('skips the implementation check when no surface digest was pre-attested', async () => {
    const worktree = makeWorktree();
    write(worktree, 'src/main.ts', 'content');
    const result = await reattestExecutionSubject(
      [{ kind: 'implementation' }],
      worktree,
      preAttestation([]),
      hashText('state'),
      ['src/main.ts'],
    );
    expect(result.kind).toBe('ok');
  });

  it('reports subject_changed post_execution when a file surface changed', async () => {
    const worktree = makeWorktree();
    write(worktree, 'vitest.config.ts', 'before');
    const before = hashText('before');
    write(worktree, 'vitest.config.ts', 'after');
    const result = await reattestExecutionSubject(
      [{ kind: 'file', path: 'vitest.config.ts' }],
      worktree,
      preAttestation([['vitest.config.ts', before]]),
      'irrelevant',
      [],
    );
    expect(result.kind).toBe('subject_changed');
    if (result.kind === 'subject_changed') {
      expect(result.component).toBe('execution_surface');
      expect(result.phase).toBe('post_execution');
      expect(result.detail).toBe('vitest.config.ts changed during execution');
    }
  });

  it('returns ok for an unchanged file surface', async () => {
    const worktree = makeWorktree();
    write(worktree, 'vitest.config.ts', 'same');
    const digest = hashText('same');
    const pre = preAttestation([['vitest.config.ts', digest]]);
    const result = await reattestExecutionSubject(
      [{ kind: 'file', path: 'vitest.config.ts' }],
      worktree,
      pre,
      'irrelevant',
      [],
    );
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.attestation).toBe(pre);
    }
  });

  it('skips the file check when no surface digest was pre-attested', async () => {
    const worktree = makeWorktree();
    write(worktree, 'vitest.config.ts', 'whatever');
    const result = await reattestExecutionSubject(
      [{ kind: 'file', path: 'vitest.config.ts' }],
      worktree,
      preAttestation([]),
      'irrelevant',
      [],
    );
    expect(result.kind).toBe('ok');
  });

  it('reports subject_changed post_execution when a file surface cannot be re-read', async () => {
    const result = await reattestExecutionSubject(
      [{ kind: 'file', path: 'gone.config.ts' }],
      makeWorktree(),
      preAttestation([['gone.config.ts', hashText('x')]]),
      'irrelevant',
      [],
    );
    expect(result.kind).toBe('subject_changed');
    if (result.kind === 'subject_changed') {
      expect(result.component).toBe('execution_surface');
      expect(result.phase).toBe('post_execution');
      expect(result.detail).toBe('cannot re-read execution surface: gone.config.ts');
    }
  });
});
