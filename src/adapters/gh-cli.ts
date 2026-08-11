/**
 * @module gh-cli
 * @description Adapter for GitHub CLI (`gh`) interactions.
 *
 * This module lives in `adapters/` which is allowed to import Node builtins.
 * `rails/` imports from here instead of using `node:child_process` directly.
 */

import { execFileSync } from 'node:child_process';
import { getAdapterLogger } from '../logging/adapter-logger.js';
import { hashText } from '../shared/hashing.js';
import { GitError } from './git.js';

/**
 * Check if `gh` CLI is available and authenticated.
 * Result is cached once per process — the check is synchronous with a 3s timeout.
 */
let _ghCliAvailable: boolean | null = null;

export function hasGhCli(): boolean {
  if (_ghCliAvailable !== null) return _ghCliAvailable;
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'ignore', timeout: 3000 });
    _ghCliAvailable = true;
  } catch {
    _ghCliAvailable = false;
    getAdapterLogger().warn('gh-cli', 'GitHub CLI not available or not authenticated');
  }
  return _ghCliAvailable;
}

/**
 * Load PR diff via `gh` CLI.
 * Requires `gh` CLI installed and authenticated.
 * Returns the raw diff string.
 * Throws if PR not found or gh fails.
 */
export function loadPrDiff(prNumber: number): string {
  const out = execFileSync(
    'gh',
    ['pr', 'view', String(prNumber), '--json', 'diff', '--jq', '.diff'],
    {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 15000,
    },
  );
  if (!out || out.trim() === 'null') {
    throw new GitError('GIT_NOT_FOUND', `PR #${prNumber} not found or has no diff`);
  }
  return out;
}

// ─── Immutable Pull-Request Review Source ────────────────────────────────────

export interface ResolvedPullRequestReviewSource {
  readonly pullRequestNumber: number;
  readonly baseRepository: { readonly host: string; readonly owner: string; readonly name: string };
  readonly headRepository: { readonly host: string; readonly owner: string; readonly name: string };
  readonly baseSha: string;
  readonly headSha: string;
}

/**
 * Resolve a pull request's immutable commit and repository identities.
 *
 * This deliberately reads the PR metadata once and returns only immutable
 * identifiers. Callers must use the returned SHAs for later materialization.
 */
export function resolvePullRequestReviewSource(prNumber: number): ResolvedPullRequestReviewSource {
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
    throw new GitError(
      'GIT_NOT_FOUND',
      `Pull request number must be a positive integer: ${prNumber}`,
    );
  }

  let output: string;
  try {
    output = execFileSync(
      'gh',
      [
        'pr',
        'view',
        String(prNumber),
        '--json',
        'baseRefOid,headRefOid,baseRepository,headRepository',
      ],
      { encoding: 'utf-8', stdio: 'pipe', timeout: 15000 },
    );
  } catch (err) {
    throw new GitError(
      'GIT_NOT_FOUND',
      `Could not resolve immutable source for PR #${prNumber}: ${String(err)}`,
    );
  }

  let metadata: unknown;
  try {
    metadata = JSON.parse(output);
  } catch (err) {
    throw new GitError(
      'GIT_COMMAND_FAILED',
      `GitHub returned invalid PR metadata for #${prNumber}: ${String(err)}`,
    );
  }
  if (!isPullRequestMetadata(metadata)) {
    throw new GitError(
      'GIT_COMMAND_FAILED',
      `GitHub returned incomplete immutable metadata for PR #${prNumber}`,
    );
  }

  const baseRepository = repositoryIdentity(metadata.baseRepository);
  const headRepository = repositoryIdentity(metadata.headRepository);
  if (
    !baseRepository ||
    !headRepository ||
    !isGitSha(metadata.baseRefOid) ||
    !isGitSha(metadata.headRefOid)
  ) {
    throw new GitError(
      'GIT_COMMAND_FAILED',
      `GitHub returned incomplete immutable metadata for PR #${prNumber}`,
    );
  }
  return {
    pullRequestNumber: prNumber,
    baseRepository,
    headRepository,
    baseSha: metadata.baseRefOid,
    headSha: metadata.headRefOid,
  };
}

/** Load a PR diff by the previously resolved immutable commit SHAs. */
export function loadResolvedPullRequestDiff(source: ResolvedPullRequestReviewSource): string {
  try {
    const out = execFileSync(
      'gh',
      [
        'api',
        '--method',
        'GET',
        '--header',
        'Accept: application/vnd.github.v3.diff',
        `repos/${source.baseRepository.owner}/${source.baseRepository.name}/compare/${source.baseSha}...${source.headSha}`,
      ],
      { encoding: 'utf-8', stdio: 'pipe', timeout: 15000 },
    );
    if (!out || out.trim() === '') {
      throw new GitError('GIT_COMMAND_FAILED', 'Empty diff between resolved pull-request commits');
    }
    return out;
  } catch (err) {
    if (err instanceof GitError) throw err;
    throw new GitError(
      'GIT_COMMAND_FAILED',
      `Could not load diff between resolved pull-request commits: ${String(err)}`,
    );
  }
}

function isPullRequestMetadata(value: unknown): value is {
  readonly baseRefOid: unknown;
  readonly headRefOid: unknown;
  readonly baseRepository: unknown;
  readonly headRepository: unknown;
} {
  return typeof value === 'object' && value !== null;
}

function repositoryIdentity(
  value: unknown,
): { readonly host: string; readonly owner: string; readonly name: string } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const repository = value as {
    readonly name?: unknown;
    readonly owner?: { readonly login?: unknown };
    readonly url?: unknown;
  };
  if (
    typeof repository.name !== 'string' ||
    repository.name.length === 0 ||
    typeof repository.owner?.login !== 'string' ||
    repository.owner.login.length === 0 ||
    typeof repository.url !== 'string'
  ) {
    return undefined;
  }
  try {
    const host = new URL(repository.url).hostname;
    return host ? { host, owner: repository.owner.login, name: repository.name } : undefined;
  } catch {
    return undefined;
  }
}

function isGitSha(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{40,64}$/i.test(value);
}

/**
 * Load branch diff via `gh` CLI (compares branch against base branch).
 * Requires `gh` CLI installed and authenticated.
 * Returns the raw diff string.
 * Throws if branch not found or gh fails.
 */
export function loadBranchDiff(branch: string, cwd?: string): string {
  const base = detectBaseBranch(branch, cwd);
  const out = execFileSync('git', ['diff', `${base.ref}...${branch}`], {
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: 15000,
    cwd,
  });
  if (!out || out.trim() === '') {
    throw new GitError(
      'GIT_COMMAND_FAILED',
      `Branch '${branch}' has no changes relative to ${base.label}`,
    );
  }
  return out;
}

// ─── Immutable Branch Review Source ──────────────────────────────────────────

export interface ResolvedBranchReviewSource {
  readonly branch: string;
  readonly baseBranch: string;
  readonly resolvedBranchSha: string;
  readonly resolvedBaseSha: string;
  readonly repository?:
    | { readonly host: string; readonly owner: string; readonly name: string }
    | { readonly kind: 'local'; readonly rootCommitDigest: string };
}

/**
 * Resolve both the branch head and base to full commit SHAs.
 *
 * When `explicitBase` is provided (e.g. `/review branch=X base=Y`), it is used
 * verbatim as the base ref — this is the deterministic, user-controlled path.
 * Otherwise the base is auto-detected via detectBaseBranch() (best-effort).
 *
 * All git operations are scoped to `cwd` (the project worktree) so that
 * ref resolution does not silently operate against the wrong repository.
 *
 * Fails closed: throws GitError if either ref cannot be resolved. The returned
 * `baseBranch` is an honest label of the base actually used (a ref name, an
 * explicit user value, or "(merge-base with HEAD)") — never a mislabeled
 * mainline when a fallback was taken.
 */
export function resolveBranchReviewSource(
  branch: string,
  explicitBase?: string,
  cwd?: string,
): ResolvedBranchReviewSource {
  const base =
    explicitBase !== undefined && explicitBase.trim() !== ''
      ? { label: explicitBase.trim(), ref: explicitBase.trim() }
      : detectBaseBranch(branch, cwd);

  // Fail closed with a typed, ref-naming error (contract: "throws GitError if
  // either ref cannot be resolved"). An explicit base is user-controlled and is
  // otherwise taken verbatim, so it is the most likely non-resolvable ref.
  if (!refExists(base.ref, cwd)) {
    throw new GitError(
      'GIT_NOT_FOUND',
      `Base '${base.label}' does not resolve to a commit. ` +
        'Provide an existing base with base=<ref>, or create/fetch it first.',
    );
  }
  if (!refExists(branch, cwd)) {
    throw new GitError(
      'GIT_NOT_FOUND',
      `Branch '${branch}' does not resolve to a commit. ` +
        'Check the branch name, or fetch it first.',
    );
  }

  // Defensive: refs were verified above, but resolve inside try/catch so any
  // race (ref deleted between check and use) still surfaces as a typed GitError
  // rather than a raw execFileSync exception.
  let headSha: string;
  let baseSha: string;
  try {
    headSha = execFileSync(
      'git',
      ['rev-parse', '--verify', '--end-of-options', `${branch}^{commit}`],
      { encoding: 'utf-8', stdio: 'pipe', timeout: 5000, cwd },
    ).trim();
    baseSha = execFileSync(
      'git',
      ['rev-parse', '--verify', '--end-of-options', `${base.ref}^{commit}`],
      { encoding: 'utf-8', stdio: 'pipe', timeout: 5000, cwd },
    ).trim();
  } catch (err) {
    throw new GitError(
      'GIT_COMMAND_FAILED',
      `Could not resolve branch '${branch}' or base '${base.label}' to a commit: ${String(err)}. ` +
        'Provide an explicit base with base=<ref>, or fetch the refs first.',
    );
  }

  if (baseSha === headSha) {
    throw new GitError(
      'GIT_COMMAND_FAILED',
      `Branch '${branch}' has no commits ahead of base '${base.label}' (identical commits); ` +
        'nothing to review. Provide an explicit base with base=<ref> or push the branch to a remote.',
    );
  }
  return {
    branch,
    baseBranch: base.label,
    resolvedBranchSha: headSha,
    resolvedBaseSha: baseSha,
    repository: resolveRepositoryIdentity(cwd),
  };
}

function resolveRepositoryIdentity(
  cwd?: string,
):
  | { readonly host: string; readonly owner: string; readonly name: string }
  | { readonly kind: 'local'; readonly rootCommitDigest: string } {
  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 3000,
      cwd,
    }).trim();
    const match = /^(?:https?:\/\/|git@)([^/:]+)[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remote);
    if (!match) return localRepositoryIdentity(cwd);
    const [, host, owner, name] = match;
    if (!host || !owner || !name) return localRepositoryIdentity(cwd);
    return { host, owner, name };
  } catch {
    return localRepositoryIdentity(cwd);
  }
}

function localRepositoryIdentity(cwd?: string): {
  readonly kind: 'local';
  readonly rootCommitDigest: string;
} {
  try {
    const roots = execFileSync('git', ['rev-list', '--max-parents=0', '--all'], {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 3000,
      cwd,
    })
      .split('\n')
      .map((root) => root.trim())
      .filter(Boolean)
      .sort();
    if (roots.length > 0) return { kind: 'local', rootCommitDigest: hashText(roots.join('\n')) };
  } catch {
    // Branch/base SHA resolution already established a usable Git repository.
  }
  throw new GitError('GIT_COMMAND_FAILED', 'Could not derive immutable local repository identity');
}

/**
 * Load the diff between two resolved commit SHAs.
 * Uses immutable refs — no branch name interpolation.
 */
export function loadResolvedBranchDiff(headSha: string, baseSha: string, cwd?: string): string {
  const out = execFileSync('git', ['diff', `${baseSha}...${headSha}`], {
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: 15000,
    cwd,
  });
  if (!out || out.trim() === '') {
    throw new GitError('GIT_COMMAND_FAILED', 'Empty diff between resolved commits');
  }
  return out;
}

/** A resolved base: an honest human label plus a git-resolvable ref/SHA. */
interface DetectedBase {
  readonly label: string;
  readonly ref: string;
}

/** True if `ref` resolves to a commit in the repo at `cwd`. */
function refExists(ref: string, cwd?: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], {
      stdio: 'ignore',
      timeout: 3000,
      cwd,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort auto-detection of a base ref to diff `branch` against.
 *
 * Candidate ladder (fail-closed): origin/HEAD → main → master → origin/master →
 * upstream/HEAD → merge-base(branch, HEAD). If none resolve, throws a typed
 * GitError with recovery guidance. The caller can always bypass this by passing
 * an explicit base (base=<ref>).
 */
function detectBaseBranch(branch: string, cwd?: string): DetectedBase {
  try {
    const originHead = execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 3000,
      cwd,
    })
      .trim()
      .replace('refs/remotes/', '');
    return { label: originHead, ref: originHead };
  } catch {
    getAdapterLogger().warn('gh-cli', 'Cannot detect origin/HEAD, trying named-branch fallbacks');
  }

  for (const named of ['main', 'master', 'origin/master', 'upstream/HEAD']) {
    if (refExists(named, cwd)) {
      return { label: named, ref: named };
    }
  }

  // Final fallback: the merge-base of the branch and the current HEAD. This
  // gives the branch's changes relative to where it diverged, matching the
  // conventional `git merge-base` behavior. Only used when no mainline ref
  // exists (e.g. a purely local branch with no remote).
  try {
    const mergeBase = execFileSync('git', ['merge-base', '--end-of-options', branch, 'HEAD'], {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 3000,
      cwd,
    }).trim();
    if (mergeBase) {
      getAdapterLogger().warn(
        'gh-cli',
        'No mainline base found; using merge-base with HEAD as review base',
      );
      return { label: '(merge-base with HEAD)', ref: mergeBase };
    }
  } catch {
    // fall through to the typed error below
  }

  getAdapterLogger().error('gh-cli', 'Cannot determine base branch for diff');
  throw new GitError(
    'GIT_COMMAND_FAILED',
    `Cannot determine a base to diff branch '${branch}' against ` +
      '(no origin/HEAD, main, master, origin/master, upstream/HEAD, or merge-base with HEAD). ' +
      'Provide an explicit base with base=<ref>, or create/fetch a mainline branch.',
  );
}

// ─── Target-Path Resolution for Challenge Classification ─────────────────────

export function loadBranchChangedFiles(
  branch: string,
  explicitBase?: string,
  cwd?: string,
): string[] {
  try {
    const base = resolveBranchReviewSource(branch, explicitBase, cwd);
    const out = execFileSync(
      'git',
      ['diff', '--name-only', `${base.resolvedBaseSha}...${base.resolvedBranchSha}`],
      { encoding: 'utf-8', stdio: 'pipe', timeout: 10000, cwd },
    );
    return out
      .trim()
      .split('\n')
      .filter((p) => p.length > 0);
  } catch {
    return [];
  }
}

export function loadPrChangedFiles(prNumber: number): string[] {
  try {
    const out = execFileSync(
      'gh',
      ['pr', 'view', String(prNumber), '--json', 'files', '--jq', '.files[].path'],
      {
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 10000,
      },
    );
    return out
      .trim()
      .split('\n')
      .filter((p) => p.length > 0);
  } catch {
    return [];
  }
}
