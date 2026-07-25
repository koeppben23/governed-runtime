/**
 * @module adapters/gh-cli-branch-base.test
 * @description Real-git-repo tests for branch review base detection.
 *
 * Root-cause coverage for GIT_COMMAND_FAILED "Cannot determine base branch"
 * (reproduced in the Java demo): a purely local branch with no origin/HEAD and
 * no main/master exhausted the old fixed ladder. These tests exercise the real
 * git algorithm (not mocked) via temporary repositories, covering: explicit
 * base, named-branch detection, the merge-base fallback, and the fail-closed
 * cases.
 *
 * The gh-cli functions run `git` in process.cwd(), so each test chdir's into a
 * throwaway repo and restores cwd afterward.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { resolveBranchReviewSource } from './gh-cli.js';
import { GitError } from './git.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

/** Initialize a deterministic git repo with a fixed identity and no signing. */
async function initRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-branch-base-'));
  // Use a deliberately non-mainline default branch name so that tests exercising
  // the merge-base fallback are not accidentally satisfied by a default `master`
  // (git's default init branch varies by machine config).
  git(dir, ['init', '-q', '-b', 'trunk-local']);
  git(dir, ['config', 'user.email', 'test@flowguard.local']);
  git(dir, ['config', 'user.name', 'FlowGuard Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'gc.auto', '0']);
  return dir;
}

async function writeAndCommit(
  dir: string,
  file: string,
  content: string,
  message: string,
): Promise<void> {
  await fs.writeFile(path.join(dir, file), content);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message]);
}

describe('resolveBranchReviewSource — real-git base detection', () => {
  let originalCwd: string;
  const created: string[] = [];

  beforeEach(() => {
    originalCwd = process.cwd();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    for (const dir of created.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  async function repoWithBranch(opts: {
    /** Create a local `main` branch as the base. */
    withMain?: boolean;
    /** Create a local `master` branch as the base. */
    withMaster?: boolean;
    /** Number of extra commits on the feature branch beyond the base. */
    featureCommits?: number;
  }): Promise<{ dir: string; baseSha: string; headSha: string }> {
    const dir = await initRepo();
    created.push(dir);

    // Base commit on the initial branch.
    await writeAndCommit(dir, 'base.txt', 'base\n', 'base commit');
    const baseSha = git(dir, ['rev-parse', 'HEAD']);

    if (opts.withMain) git(dir, ['branch', 'main']);
    if (opts.withMaster) git(dir, ['branch', 'master']);

    git(dir, ['checkout', '-q', '-b', 'feature/add-due-date']);
    const commits = opts.featureCommits ?? 1;
    for (let i = 0; i < commits; i++) {
      await writeAndCommit(dir, `feature-${i}.txt`, `feature ${i}\n`, `feature commit ${i}`);
    }
    const headSha = git(dir, ['rev-parse', 'HEAD']);

    // Leave HEAD on the base commit (detached-free) so merge-base(feature,HEAD)
    // is the base — mirrors reviewing a branch you are not currently on.
    git(dir, ['checkout', '-q', baseSha]);

    return { dir, baseSha, headSha };
  }

  it('uses an explicit base ref verbatim (deterministic path)', async () => {
    const { dir, baseSha, headSha } = await repoWithBranch({ withMain: true });
    process.chdir(dir);

    const src = resolveBranchReviewSource('feature/add-due-date', 'main');

    expect(src.baseBranch).toBe('main');
    expect(src.resolvedBaseSha).toBe(baseSha);
    expect(src.resolvedBranchSha).toBe(headSha);
  });

  it('trims surrounding whitespace on an explicit base ref', async () => {
    const { dir, baseSha } = await repoWithBranch({ withMain: true });
    process.chdir(dir);

    // A padded value must be trimmed to the real ref and labeled cleanly.
    const src = resolveBranchReviewSource('feature/add-due-date', '  main  ');

    expect(src.baseBranch).toBe('main');
    expect(src.resolvedBaseSha).toBe(baseSha);
  });

  it('treats a whitespace-only explicit base as absent and auto-detects', async () => {
    // '   '.trim() === '' → explicitBase is ignored, auto-detection must run.
    const { dir, baseSha } = await repoWithBranch({ withMain: true });
    process.chdir(dir);

    const src = resolveBranchReviewSource('feature/add-due-date', '   ');

    expect(src.baseBranch).toBe('main');
    expect(src.resolvedBaseSha).toBe(baseSha);
  });

  it('prefers origin/HEAD over local main when a remote default is set', async () => {
    const { dir, baseSha } = await repoWithBranch({ withMain: true });
    // Simulate a remote default branch pointer: origin/HEAD → origin/main.
    git(dir, ['update-ref', 'refs/remotes/origin/main', baseSha]);
    git(dir, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
    process.chdir(dir);

    const src = resolveBranchReviewSource('feature/add-due-date');

    // Label is the stripped remote ref ("origin/main"), proving the
    // refs/remotes/ prefix removal and the origin/HEAD-first ladder order.
    expect(src.baseBranch).toBe('origin/main');
    expect(src.resolvedBaseSha).toBe(baseSha);
  });

  it('auto-detects a local main branch as base', async () => {
    const { dir, baseSha, headSha } = await repoWithBranch({ withMain: true });
    process.chdir(dir);

    const src = resolveBranchReviewSource('feature/add-due-date');

    expect(src.baseBranch).toBe('main');
    expect(src.resolvedBaseSha).toBe(baseSha);
    expect(src.resolvedBranchSha).toBe(headSha);
  });

  it('auto-detects a local master branch when no main exists', async () => {
    const { dir, baseSha } = await repoWithBranch({ withMaster: true });
    process.chdir(dir);

    const src = resolveBranchReviewSource('feature/add-due-date');

    expect(src.baseBranch).toBe('master');
    expect(src.resolvedBaseSha).toBe(baseSha);
  });

  it('falls back to merge-base with HEAD for a local-only branch (the demo case)', async () => {
    // No origin, no main, no master — only the feature branch and a base commit.
    const { dir, baseSha, headSha } = await repoWithBranch({});
    process.chdir(dir);

    const src = resolveBranchReviewSource('feature/add-due-date');

    // Honest label — never a mislabeled "main".
    expect(src.baseBranch).toBe('(merge-base with HEAD)');
    expect(src.resolvedBaseSha).toBe(baseSha);
    expect(src.resolvedBranchSha).toBe(headSha);
    expect(src.resolvedBaseSha).not.toBe(src.resolvedBranchSha);
  });

  it('fails closed with recovery guidance when the branch has no commits ahead of base', async () => {
    // Feature branch is at the same commit as HEAD → merge-base == head → nothing to review.
    const dir = await initRepo();
    created.push(dir);
    await writeAndCommit(dir, 'base.txt', 'base\n', 'base commit');
    git(dir, ['branch', 'feature/add-due-date']); // points at HEAD, no ahead commits
    process.chdir(dir);

    try {
      resolveBranchReviewSource('feature/add-due-date');
      throw new Error('expected resolveBranchReviewSource to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(GitError);
      expect((err as GitError).code).toBe('GIT_COMMAND_FAILED');
      expect((err as GitError).message).toMatch(/no commits ahead|base=<ref>/);
    }
  });

  it('explicit base overrides auto-detection even when main exists', async () => {
    const { dir, headSha } = await repoWithBranch({ withMain: true, featureCommits: 2 });
    process.chdir(dir);

    // Use the branch head's parent as an explicit base.
    const parent = git(dir, ['rev-parse', 'feature/add-due-date^']);
    const src = resolveBranchReviewSource('feature/add-due-date', parent);

    expect(src.baseBranch).toBe(parent);
    expect(src.resolvedBaseSha).toBe(parent);
    expect(src.resolvedBranchSha).toBe(headSha);
  });

  it('fails closed with a typed GitError when the explicit base does not resolve', async () => {
    const { dir } = await repoWithBranch({ withMain: true });
    process.chdir(dir);

    try {
      resolveBranchReviewSource('feature/add-due-date', 'does-not-exist-base');
      throw new Error('expected resolveBranchReviewSource to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(GitError);
      expect((err as GitError).code).toBe('GIT_NOT_FOUND');
      expect((err as GitError).message).toMatch(/does not resolve to a commit|base=<ref>/);
    }
  });

  it('fails closed with a typed GitError when the branch does not resolve', async () => {
    const { dir } = await repoWithBranch({ withMain: true });
    process.chdir(dir);

    try {
      // Valid base, non-existent branch.
      resolveBranchReviewSource('no-such-branch', 'main');
      throw new Error('expected resolveBranchReviewSource to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(GitError);
      expect((err as GitError).code).toBe('GIT_NOT_FOUND');
      expect((err as GitError).message).toMatch(/does not resolve to a commit/);
    }
  });

  // #721: untrusted branch/base refs must never reach a shell. gh-cli uses
  // execFileSync (no shell), so a ref containing shell metacharacters is passed
  // as a literal argument to git and never interpreted. This is the negative
  // regression test the ticket requires.
  it('treats a ref with shell metacharacters as a literal, never executing it (#721)', async () => {
    const { dir } = await repoWithBranch({ withMain: true });
    process.chdir(dir);

    const sentinel = path.join(dir, 'pwned.txt');
    // A ref name that, if it ever reached a shell, would create the sentinel.
    const malicious = 'main;$(touch "' + sentinel + '")';

    try {
      resolveBranchReviewSource('feature/add-due-date', malicious);
      throw new Error('expected resolveBranchReviewSource to throw');
    } catch (err) {
      // The malicious string is a non-existent ref → fail-closed GitError.
      expect(err).toBeInstanceOf(GitError);
      expect((err as GitError).code).toBe('GIT_NOT_FOUND');
    }

    // Proof no shell ran: the sentinel was never created.
    await expect(fs.stat(sentinel)).rejects.toThrow();
  });

  // Regression: resolveBranchReviewSource with an explicit cwd correctly
  // resolves refs from the target repository even when the process CWD is
  // a different directory.
  it('resolves refs from the cwd target when process CWD is elsewhere', async () => {
    const { dir, baseSha, headSha } = await repoWithBranch({ withMain: true });
    // Switch the process CWD to a non-repo directory.
    const saved = process.cwd();
    process.chdir('/tmp');
    try {
      // cwd=dir points git at the correct repo, even though the process
      // CWD is /tmp (not a git repo).
      const src = resolveBranchReviewSource('feature/add-due-date', 'main', dir);

      expect(src.baseBranch).toBe('main');
      expect(src.resolvedBaseSha).toBe(baseSha);
      expect(src.resolvedBranchSha).toBe(headSha);
    } finally {
      process.chdir(saved);
    }
  });

  // Regression: resolveBranchReviewSource WITHOUT a cwd silently operates
  // against the process CWD, which may be a completely different repository.
  it('fails when process CWD is not the target repo and no cwd is given', async () => {
    const { dir } = await repoWithBranch({ withMain: true });
    const saved = process.cwd();
    process.chdir('/tmp');
    try {
      expect(() => resolveBranchReviewSource('feature/add-due-date', 'main')).toThrow(GitError);
    } finally {
      process.chdir(saved);
    }
  });

  // Regression: resolveBranchReviewSource with cwd but WITHOUT explicit base
  // exercises the detectBaseBranch() auto-detection path. Without cwd threading,
  // detectBaseBranch operates against the wrong repository and fails.
  it('auto-detects base from cwd target when process CWD is elsewhere (no explicit base)', async () => {
    const { dir, baseSha, headSha } = await repoWithBranch({ withMain: true });
    const saved = process.cwd();
    process.chdir('/tmp');
    try {
      // No explicit base — detectBaseBranch must find 'main' in the correct repo.
      const src = resolveBranchReviewSource('feature/add-due-date', undefined, dir);

      expect(src.baseBranch).toBe('main');
      expect(src.resolvedBaseSha).toBe(baseSha);
      expect(src.resolvedBranchSha).toBe(headSha);
    } finally {
      process.chdir(saved);
    }
  });
});
