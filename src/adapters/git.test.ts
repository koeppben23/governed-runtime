/**
 * @module adapters/git
 * @description Real-git adapter tests for the typed repository probe (#852):
 *              resolveRoot / isGitRepoStrict must distinguish the actual
 *              "not a git repository" case from other infrastructure failures
 *              instead of flattening every GIT_COMMAND_FAILED into
 *              NOT_GIT_REPO. No adapter mocks — the tests exercise the
 *              production resolveRoot → isGitRepoStrict chain.
 *
 * @test-policy HAPPY, BAD, CORNER — repository, non-repo, and corrupt-repo.
 * @version v1
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { isGitRepoStrict, resolveRoot, GitError } from './git.js';

const execFileAsync = promisify(execFile);

let tmpDir: string;

async function createTmpDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'gov-git-adapter-'));
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

function gitErrorCode(err: unknown): string | undefined {
  return err instanceof GitError ? err.code : undefined;
}

describe('resolveRoot typed failure normalization', () => {
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

  it('resolves the root inside a real repository (HAPPY)', async () => {
    const repo = path.join(tmpDir, 'repo');
    await fs.mkdir(repo);
    await git(repo, ['init']);
    const root = await resolveRoot(repo);
    // git resolves symlinked ancestors (macOS /var -> /private/var).
    expect(root).toBe(await fs.realpath(repo));
  });

  it('throws NOT_GIT_REPO outside a repository (BAD)', async () => {
    const plain = path.join(tmpDir, 'plain');
    await fs.mkdir(plain);
    await expect(resolveRoot(plain)).rejects.toSatisfy(
      (err: unknown) => gitErrorCode(err) === 'NOT_GIT_REPO',
    );
  });

  it('preserves GIT_COMMAND_FAILED for a corrupt .git gitfile instead of NOT_GIT_REPO (BAD)', async () => {
    const corrupt = path.join(tmpDir, 'corrupt');
    await fs.mkdir(corrupt);
    await fs.writeFile(path.join(corrupt, '.git'), 'garbage not a gitfile', 'utf8');
    await expect(resolveRoot(corrupt)).rejects.toSatisfy(
      (err: unknown) => gitErrorCode(err) === 'GIT_COMMAND_FAILED',
    );
  });
});

describe('isGitRepoStrict typed probe', () => {
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

  it('returns true inside a real repository (HAPPY)', async () => {
    const repo = path.join(tmpDir, 'repo');
    await fs.mkdir(repo);
    await git(repo, ['init']);
    expect(await isGitRepoStrict(repo)).toBe(true);
  });

  it('returns false outside a repository (BAD)', async () => {
    const plain = path.join(tmpDir, 'plain');
    await fs.mkdir(plain);
    expect(await isGitRepoStrict(plain)).toBe(false);
  });

  it('rethrows GIT_COMMAND_FAILED for a corrupt .git gitfile (CORNER)', async () => {
    const corrupt = path.join(tmpDir, 'corrupt');
    await fs.mkdir(corrupt);
    await fs.writeFile(path.join(corrupt, '.git'), 'garbage not a gitfile', 'utf8');
    await expect(isGitRepoStrict(corrupt)).rejects.toSatisfy(
      (err: unknown) => gitErrorCode(err) === 'GIT_COMMAND_FAILED',
    );
  });
});
