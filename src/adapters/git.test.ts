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

import {
  changedFiles,
  currentBranch,
  defaultBranch,
  gitUserEmail,
  gitUserName,
  hashWorktreeFiles,
  headCommit,
  headCommitFull,
  headCommitFullStrict,
  isClean,
  isGitRepo,
  isGitRepoStrict,
  listRepoSignals,
  parsePorcelainZ,
  remoteOriginUrl,
  resolveGitControlPlanePaths,
  resolveRoot,
  worktreeDiff,
  GitError,
} from './git.js';
import { vi } from 'vitest';

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

describe('headCommitFullStrict', () => {
  beforeEach(async () => {
    tmpDir = await createTmpDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns null only for a valid repository without a HEAD commit', async () => {
    const repo = path.join(tmpDir, 'empty');
    await fs.mkdir(repo);
    await git(repo, ['init']);
    await expect(headCommitFullStrict(repo)).resolves.toBeNull();
  });

  it('preserves a corrupt repository failure', async () => {
    const corrupt = path.join(tmpDir, 'corrupt');
    await fs.mkdir(corrupt);
    await fs.writeFile(path.join(corrupt, '.git'), 'garbage not a gitfile', 'utf8');
    await expect(headCommitFullStrict(corrupt)).rejects.toSatisfy(
      (err: unknown) => gitErrorCode(err) === 'GIT_COMMAND_FAILED',
    );
  });
});

describe('git adapter behavior contracts', () => {
  let repo: string;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    repo = path.join(tmpDir, 'repo');
    await fs.mkdir(repo);
    await git(repo, ['init', '-q']);
    await git(repo, ['config', 'user.email', 'test@example.com']);
    await git(repo, ['config', 'user.name', 'Test User']);
    await fs.writeFile(path.join(repo, 'tracked.txt'), 'tracked\n', 'utf8');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-q', '-m', 'base']);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('parsePorcelainZ', () => {
    it('parses modified, untracked and rename records into OS-normalized paths', () => {
      expect(parsePorcelainZ(' M a.ts\0')).toEqual(['a.ts']);
      expect(parsePorcelainZ('?? a.ts\0 M b.ts\0')).toEqual(['a.ts', 'b.ts']);
      expect(parsePorcelainZ('R  new.ts\0old.ts\0')).toEqual(['new.ts', 'old.ts']);
      expect(parsePorcelainZ('C  copy.ts\0original.ts\0')).toEqual(['copy.ts', 'original.ts']);
    });

    it('skips empty and too-short fields', () => {
      expect(parsePorcelainZ('\0.\0ab\0 M a.ts\0')).toEqual(['a.ts']);
      expect(parsePorcelainZ('')).toEqual([]);
    });
  });

  describe('repository state probes', () => {
    it('reports the branch, cleanliness and changed files', async () => {
      expect(await currentBranch(repo)).toBeTruthy();
      // A repository without a remote HEAD has no resolvable default branch.
      expect(await defaultBranch(repo)).toBeNull();
      expect(await isClean(repo)).toBe(true);
      expect(await changedFiles(repo)).toEqual([]);
      expect(await worktreeDiff(repo, ['tracked.txt'])).toBe('');

      await fs.writeFile(path.join(repo, 'tracked.txt'), 'changed\n', 'utf8');
      await fs.writeFile(path.join(repo, 'new.txt'), 'new\n', 'utf8');
      expect(await isClean(repo)).toBe(false);
      const changed = await changedFiles(repo);
      expect(changed).toContain('tracked.txt');
      expect(changed).toContain('new.txt');
      expect(await worktreeDiff(repo, ['tracked.txt'])).toContain('tracked.txt');
    });

    it('returns null for branch and remote in a repository without them', async () => {
      expect(await remoteOriginUrl(repo)).toBeNull();

      await git(repo, ['remote', 'add', 'origin', 'https://example.com/acme/repo.git']);
      expect(await remoteOriginUrl(repo)).toBe('https://example.com/acme/repo.git');
    });

    it('resolves the control-plane layout with all six absolute paths', async () => {
      const layout = await resolveGitControlPlanePaths(repo);
      const values = Object.values(layout);
      expect(values).toHaveLength(6);
      for (const value of values) {
        expect(path.isAbsolute(value)).toBe(true);
      }
      expect(layout.hooksPath.endsWith('hooks')).toBe(true);
    });
  });

  describe('commit and identity helpers', () => {
    it('resolves HEAD in short, full and strict form', async () => {
      expect(await headCommit(repo)).toMatch(/^[a-f0-9]{7,}$/);
      expect(await headCommitFull(repo)).toMatch(/^[a-f0-9]{40}$/);
      expect(await headCommitFullStrict(repo)).toBe(await headCommitFull(repo));
    });

    it('returns null for a valid repository without HEAD and writes nothing to disk', async () => {
      const empty = path.join(tmpDir, 'empty');
      await fs.mkdir(empty);
      await git(empty, ['init', '-q']);
      expect(await headCommit(empty)).toBeNull();
      expect(await headCommitFull(empty)).toBeNull();
      expect(await isGitRepo(empty)).toBe(true);
    });

    it('reads actor identity from local config', async () => {
      expect(await gitUserName(repo)).toBe('Test User');
      expect(await gitUserEmail(repo)).toBe('test@example.com');
    });

    it('returns null for missing actor identity', async () => {
      vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
      vi.stubEnv('GIT_CONFIG_SYSTEM', '/dev/null');
      await git(repo, ['config', '--unset', 'user.name']);
      await git(repo, ['config', '--unset', 'user.email']);

      expect(await gitUserName(repo)).toBeNull();
      expect(await gitUserEmail(repo)).toBeNull();
    });
  });

  describe('hashWorktreeFiles', () => {
    it('returns an empty record for an empty path list', async () => {
      expect(await hashWorktreeFiles(repo, [])).toEqual({});
    });

    it('hashes every existing file in one batch', async () => {
      const hashes = await hashWorktreeFiles(repo, ['tracked.txt']);
      expect(hashes['tracked.txt']).toMatch(/^[a-f0-9]{40}$/);
      expect(hashes['tracked.txt']).toBe(await git(repo, ['hash-object', 'tracked.txt']));
    });

    it('falls back per path when one path is unreadable and keeps the others', async () => {
      const hashes = await hashWorktreeFiles(repo, ['tracked.txt', 'deleted.txt']);
      expect(hashes['tracked.txt']).toMatch(/^[a-f0-9]{40}$/);
      expect(hashes['deleted.txt']).toBeNull();
    });

    it('hashes option-looking paths literally', async () => {
      await fs.writeFile(path.join(repo, '--weird'), 'weird\n', 'utf8');
      const hashes = await hashWorktreeFiles(repo, ['--weird']);
      expect(hashes['--weird']).toMatch(/^[a-f0-9]{40}$/);
    });
  });

  describe('listRepoSignals', () => {
    it('categorizes tracked package and config files with full paths', async () => {
      await fs.writeFile(path.join(repo, 'package.json'), '{}\n', 'utf8');
      await fs.writeFile(path.join(repo, 'tsconfig.json'), '{}\n', 'utf8');
      await fs.mkdir(path.join(repo, 'src'), { recursive: true });
      await fs.writeFile(path.join(repo, 'src', 'deep.ts'), 'x\n', 'utf8');
      await git(repo, ['add', '-A']);
      await git(repo, ['commit', '-q', '-m', 'signals']);

      const signals = await listRepoSignals(repo);
      expect(signals.packageFiles).toContain('package.json');
      expect(signals.configFiles).toContain('tsconfig.json');
      expect(signals.packageFilePaths).toContain('package.json');
      expect(signals.files).toContain(path.normalize('src/deep.ts'));
    });

    it('treats csproj and sln basenames as package signals', async () => {
      await fs.writeFile(path.join(repo, 'App.csproj'), '<Project/>\n', 'utf8');
      await fs.writeFile(path.join(repo, 'App.sln'), 'sln\n', 'utf8');
      await git(repo, ['add', '-A']);
      await git(repo, ['commit', '-q', '-m', 'dotnet']);

      const signals = await listRepoSignals(repo);
      expect(signals.packageFiles).toEqual(expect.arrayContaining(['App.csproj', 'App.sln']));
    });

    it('returns empty signals for a repository without commits', async () => {
      const unborn = path.join(tmpDir, 'unborn');
      await fs.mkdir(unborn);
      await git(unborn, ['init', '-q']);
      await fs.writeFile(path.join(unborn, 'package.json'), '{}\n', 'utf8');

      const signals = await listRepoSignals(unborn);
      expect(signals).toEqual({
        files: [],
        packageFiles: [],
        configFiles: [],
        packageFilePaths: [],
        configFilePaths: [],
      });
    });

    it('returns empty signals outside a repository', async () => {
      const plain = path.join(tmpDir, 'plain');
      await fs.mkdir(plain);

      const signals = await listRepoSignals(plain);
      expect(signals).toEqual({
        files: [],
        packageFiles: [],
        configFiles: [],
        packageFilePaths: [],
        configFilePaths: [],
      });
    });
  });
});
