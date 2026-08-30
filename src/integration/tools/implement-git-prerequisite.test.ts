/**
 * @module integration/tools/implement-git-prerequisite
 * @description Tests for the /implement git prerequisite (#575): recording is
 * git-derived, so a non-Git development worktree must fail closed with a clear
 * `NOT_GIT_REPO` block BEFORE any git command runs, rather than a raw
 * `GIT_COMMAND_FAILED` dead-end after the agent has made code changes.
 *
 * @test-policy HAPPY, BAD, CORNER — git-present, git-absent, and empty path.
 * @version v1
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { validateGitPrerequisite } from './implement-record.js';

let tmpDir: string;

async function createTmpDir(prefix = 'gov-implement-git-'): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function cleanup(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    /* ignore cleanup errors */
  }
}

async function execGit(cwd: string, args: string[]): Promise<void> {
  const { execFile } = await import('node:child_process');
  await new Promise<void>((resolve, reject) => {
    execFile('git', args, { cwd }, (err) => (err ? reject(err) : resolve()));
  });
}

function parseCode(result: string): string {
  return (JSON.parse(result) as { code: string }).code;
}

describe('validateGitPrerequisite', () => {
  beforeEach(async () => {
    tmpDir = await createTmpDir();
  });

  afterEach(async () => {
    await cleanup(tmpDir);
  });

  it('returns null when the worktree is a git repository (HAPPY)', async () => {
    const repo = path.join(tmpDir, 'repo');
    await fs.mkdir(repo);
    await execGit(repo, ['init']);
    await execGit(repo, ['config', 'user.email', 'test@example.com']);
    await execGit(repo, ['config', 'user.name', 'Test']);
    expect(await validateGitPrerequisite(repo)).toBeNull();
  });

  it('blocks with NOT_GIT_REPO when the worktree is a plain directory (BAD)', async () => {
    const plain = path.join(tmpDir, 'plain');
    await fs.mkdir(plain);
    const result = await validateGitPrerequisite(plain);
    expect(result).not.toBeNull();
    expect(parseCode(result!)).toBe('NOT_GIT_REPO');
  });

  it('blocks with NOT_GIT_REPO when the path does not exist (CORNER)', async () => {
    const missing = path.join(tmpDir, 'does-not-exist');
    const result = await validateGitPrerequisite(missing);
    expect(result).not.toBeNull();
    expect(parseCode(result!)).toBe('NOT_GIT_REPO');
  });
});
