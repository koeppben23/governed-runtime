/**
 * @module adapters/frozen-repository
 * @description Immutable frozen-repository acquisition primitives.
 *
 * The ONLY sanctioned acquisition boundary for repository observations:
 *
 * ```text
 * frozen revision target (commit | tree, identity + objectSha)
 *   → exact blob at repository-relative path
 *   → raw immutable bytes
 * ```
 *
 * Never resolves mutable state: no `HEAD`, no branch refs, no provider-latest,
 * no worktree file reads. The live index is never used — the synthetic
 * worktree candidate is materialized through an ISOLATED temporary index that
 * is seeded from the frozen base, then discarded.
 *
 * Fail-closed: any acquisition failure surfaces a typed
 * {@link FrozenRepositoryError} and produces no bytes — callers must map it to
 * `evidence_unavailable`, never to a worktree fallback.
 *
 * @version v1
 */

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GitError } from './git.js';
import { MAX_REPOSITORY_OBSERVATION_BYTES } from '../state/evidence.js';
import type {
  FrozenRepositoryRevisionTarget,
  RepositoryIdentity,
  ReviewRepositoryIdentity,
} from '../state/evidence.js';
import { resolveRepositoryIdentity } from './gh-cli.js';

const execFileAsync = promisify(execFile);

export type FrozenRepositoryErrorCode =
  | 'OBJECT_UNAVAILABLE'
  | 'PATH_NOT_IN_TREE'
  | 'UNSUPPORTED_ENTRY'
  | 'OVERSIZED_BLOB'
  | 'FREEZE_FAILED'
  | 'IDENTITY_UNAVAILABLE'
  | 'ACQUISITION_FAILED';

export class FrozenRepositoryError extends Error {
  readonly code: FrozenRepositoryErrorCode;

  constructor(code: FrozenRepositoryErrorCode, message: string) {
    super(message);
    this.name = 'FrozenRepositoryError';
    this.code = code;
  }
}

/** Content-addressed result of a frozen acquisition. */
export interface FrozenRepositoryContent {
  readonly kind: 'local_git_object' | 'remote_commit_blob';
  readonly bytes: Buffer;
  /** Git blob object sha for local acquisitions; undefined for remote reads. */
  readonly blobSha?: string;
}

const MAX_BUFFER = MAX_REPOSITORY_OBSERVATION_BYTES + 1;

function isMaxBufferExceeded(err: unknown): boolean {
  return (
    err instanceof Error &&
    ((err as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ||
      err.message.includes('maxBuffer'))
  );
}

function classifyExecFailure(operation: string, err: unknown): FrozenRepositoryError {
  if (isMaxBufferExceeded(err)) {
    return new FrozenRepositoryError('OVERSIZED_BLOB', `${operation}: blob exceeds size bound`);
  }
  if (err instanceof GitError) {
    return new FrozenRepositoryError(
      err.code === 'NOT_GIT_REPO' ? 'OBJECT_UNAVAILABLE' : 'ACQUISITION_FAILED',
      `${operation}: ${err.message}`,
    );
  }
  return new FrozenRepositoryError(
    'ACQUISITION_FAILED',
    `${operation}: ${err instanceof Error ? err.message : String(err)}`,
  );
}

function gitSyncBuffer(args: string[], cwd: string): Buffer {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'buffer',
      stdio: 'pipe',
      timeout: 10000,
      maxBuffer: MAX_BUFFER,
    });
    return stdout as Buffer;
  } catch (err) {
    throw classifyExecFailure(`git ${args.join(' ')}`, err);
  }
}

function gitSyncText(args: string[], cwd: string): string {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 10000,
    });
    return stdout;
  } catch (err) {
    throw classifyExecFailure(`git ${args.join(' ')}`, err);
  }
}

/**
 * Resolve the repository identity at freeze time. The canonical remote
 * identity when an origin exists; else the immutable local identity derived
 * from the repository's root commits. Freeze-time authority only.
 */
export function freezeRepositoryIdentity(
  worktree: string,
  objectSha: string,
): ReviewRepositoryIdentity {
  try {
    return resolveRepositoryIdentity(objectSha, objectSha, worktree);
  } catch (err) {
    throw new FrozenRepositoryError(
      'IDENTITY_UNAVAILABLE',
      `Could not resolve immutable repository identity: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Resolve the git object type ('commit' | 'tree' | 'blob'), fail-closed. */
export function frozenObjectType(worktree: string, objectSha: string): string {
  return gitSyncText(['cat-file', '-t', objectSha], worktree).trim();
}

/**
 * True when the object exists in the local object database. Missing objects
 * are the sanctioned trigger for remote acquisition of remote identities.
 */
export function frozenObjectExists(worktree: string, objectSha: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', objectSha], {
      cwd: worktree,
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 10000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Freeze the current worktree as a content-addressed tree candidate against a
 * frozen base object, using an ISOLATED temporary index:
 *
 * ```text
 * GIT_INDEX_FILE=<tmp> git read-tree <base>
 * GIT_INDEX_FILE=<tmp> git add -A
 * GIT_INDEX_FILE=<tmp> git write-tree
 * discard tmp index
 * ```
 *
 * The live user index is never read and never modified. Candidate contents:
 * tracked modifications and deletions plus new non-ignored files; ignored
 * files, `.git`, and repository-external paths are excluded; symlink/mode
 * semantics and gitlink (submodule) entries follow Git index semantics.
 *
 * @returns The content-addressed tree object sha.
 */
export async function freezeWorktreeCandidate(
  worktree: string,
  baseObjectSha: string,
): Promise<string> {
  const tmpIndex = path.join(
    await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fg-index-')),
    'index',
  );
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  try {
    await execFileAsync('git', ['read-tree', baseObjectSha], {
      cwd: worktree,
      env,
      timeout: 15000,
      maxBuffer: 10 * 1024 * 1024,
    });
    await execFileAsync('git', ['add', '-A'], {
      cwd: worktree,
      env,
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const { stdout } = await execFileAsync('git', ['write-tree'], {
      cwd: worktree,
      env,
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
    const treeSha = stdout.trim();
    if (!/^[a-f0-9]{40,64}$/i.test(treeSha)) {
      throw new FrozenRepositoryError('FREEZE_FAILED', 'git write-tree returned no object sha');
    }
    return treeSha;
  } catch (err) {
    if (err instanceof FrozenRepositoryError) throw err;
    throw classifyExecFailure('worktree candidate freeze', err);
  } finally {
    await fs.promises.rm(path.dirname(tmpIndex), { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * The exact blob entry of `path` inside a frozen tree/commit object.
 *
 * Git treats the argument as a PATHPEC, not a literal name — a leading `:`
 * would trigger pathspec magic (e.g. `:foo.ts` resolves as `:(top)foo.ts`).
 * The query therefore forces `:(literal)` semantics, and the name Git returns
 * is parsed from the `-z` record and verified for EXACT equality with the
 * requested repository path. A pathspec shortcut resolving a different file
 * can never produce an observation.
 */
export function resolveFrozenBlobEntry(
  worktree: string,
  objectSha: string,
  repositoryPath: string,
): { readonly mode: string; readonly type: 'blob' | 'commit'; readonly objectSha: string } {
  const raw = gitSyncText(
    ['ls-tree', '-z', objectSha, '--', `:(literal)${repositoryPath}`],
    worktree,
  );
  const records = raw.split('\0').filter(Boolean);
  if (records.length === 0) {
    throw new FrozenRepositoryError(
      'PATH_NOT_IN_TREE',
      `path '${repositoryPath}' does not exist in frozen object ${objectSha}`,
    );
  }
  const first = records[0];
  if (!first) {
    throw new FrozenRepositoryError(
      'PATH_NOT_IN_TREE',
      `path '${repositoryPath}' does not exist in frozen object ${objectSha}`,
    );
  }
  const tabIndex = first.indexOf('\t');
  if (tabIndex < 0) {
    throw new FrozenRepositoryError(
      'ACQUISITION_FAILED',
      `unparseable ls-tree record for '${repositoryPath}' in ${objectSha}`,
    );
  }
  const meta = first.slice(0, tabIndex);
  const resolvedName = first.slice(tabIndex + 1);
  if (resolvedName !== repositoryPath) {
    throw new FrozenRepositoryError(
      'PATH_NOT_IN_TREE',
      `path '${repositoryPath}' resolved to a different tree entry '${resolvedName}' in ${objectSha}`,
    );
  }
  const match = /^(\d+)\s(blob|commit)\s([a-f0-9]{40,64})$/.exec(meta);
  if (!match) {
    throw new FrozenRepositoryError(
      'ACQUISITION_FAILED',
      `unparseable ls-tree record for '${repositoryPath}' in ${objectSha}`,
    );
  }
  const [, mode, type, entrySha] = match;
  if (type === 'commit' || mode === '160000') {
    throw new FrozenRepositoryError(
      'UNSUPPORTED_ENTRY',
      `path '${repositoryPath}' is a submodule gitlink; submodule entries are not materialized`,
    );
  }
  if (!entrySha || !mode) {
    throw new FrozenRepositoryError(
      'ACQUISITION_FAILED',
      `missing blob sha for '${repositoryPath}' in ${objectSha}`,
    );
  }
  return { mode, type: 'blob', objectSha: entrySha };
}

/** Read the exact raw bytes of a Git blob from the local object database. */
export function readFrozenBlob(worktree: string, blobSha: string): Buffer {
  const bytes = gitSyncBuffer(['cat-file', 'blob', blobSha], worktree);
  if (bytes.length > MAX_REPOSITORY_OBSERVATION_BYTES) {
    throw new FrozenRepositoryError(
      'OVERSIZED_BLOB',
      `blob ${blobSha} exceeds the repository observation size bound`,
    );
  }
  return bytes;
}

/**
 * Immutable remote acquisition: exact repository host + exact commit + exact
 * path, with IDENTICAL Git object semantics to the local backend.
 *
 * Resolution: walk the git trees API (`/git/trees/{sha}`) segment by segment
 * to obtain the EXACT tree entry (mode + object sha). Gitlink (submodule)
 * entries fail closed; truncated trees fail closed.
 *
 * Acquisition: fetch exactly that blob object via `/git/blobs/{blobSha}` with
 * the raw media type — the raw Git blob bytes, never a contents-API projection
 * (which resolves symlinks and special-cases submodules).
 */
interface RemoteTreeEntry {
  readonly path: string;
  readonly mode: string;
  readonly type: 'blob' | 'tree' | 'commit';
  readonly sha: string;
}

function ghApiJson(
  identity: RepositoryIdentity,
  hostnameArgs: string[],
  pathSegments: string[],
): unknown {
  try {
    const stdout = execFileSync(
      'gh',
      ['api', '--hostname', identity.host, '--method', 'GET', ...hostnameArgs],
      { encoding: 'utf-8', stdio: 'pipe', timeout: 20000 },
    );
    return JSON.parse(stdout) as unknown;
  } catch (err) {
    throw classifyExecFailure(`gh api ${pathSegments.join('/')}`, err);
  }
}

function resolveRemoteTreeEntry(
  identity: RepositoryIdentity,
  commitSha: string,
  repositoryPath: string,
): { readonly mode: string; readonly objectSha: string } {
  const segments = repositoryPath.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    throw new FrozenRepositoryError('PATH_NOT_IN_TREE', 'empty repository path');
  }
  let currentSha = commitSha;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    if (!segment) throw new FrozenRepositoryError('PATH_NOT_IN_TREE', 'empty path segment');
    const data = ghApiJson(
      identity,
      [`repos/${identity.owner}/${identity.name}/git/trees/${currentSha}`],
      segments.slice(0, index + 1),
    ) as { readonly tree?: readonly RemoteTreeEntry[]; readonly truncated?: boolean };
    if (data.truncated) {
      throw new FrozenRepositoryError(
        'OBJECT_UNAVAILABLE',
        `remote tree ${currentSha} is truncated; exact entry resolution is not possible`,
      );
    }
    const entry = (data.tree ?? []).find((candidate) => candidate.path === segment);
    if (!entry) {
      throw new FrozenRepositoryError(
        'PATH_NOT_IN_TREE',
        `path '${repositoryPath}' does not exist in remote commit ${commitSha}`,
      );
    }
    const last = index === segments.length - 1;
    if (entry.type === 'commit') {
      throw new FrozenRepositoryError(
        'UNSUPPORTED_ENTRY',
        `path '${repositoryPath}' is a submodule gitlink; submodule entries are not materialized`,
      );
    }
    if (last) {
      if (entry.type !== 'blob') {
        throw new FrozenRepositoryError(
          'PATH_NOT_IN_TREE',
          `path '${repositoryPath}' is not a blob in remote commit ${commitSha}`,
        );
      }
      return { mode: entry.mode, objectSha: entry.sha };
    }
    if (entry.type !== 'tree') {
      throw new FrozenRepositoryError(
        'PATH_NOT_IN_TREE',
        `path '${repositoryPath}' traverses through a non-tree entry in remote commit ${commitSha}`,
      );
    }
    currentSha = entry.sha;
  }
  throw new FrozenRepositoryError(
    'ACQUISITION_FAILED',
    `could not resolve remote tree entry for '${repositoryPath}'`,
  );
}

/** Fetch the exact raw Git blob bytes from the remote object database. */
function readRemoteBlob(identity: RepositoryIdentity, blobSha: string): Buffer {
  if (!/^[a-f0-9]{40,64}$/i.test(blobSha)) {
    throw new FrozenRepositoryError('ACQUISITION_FAILED', 'invalid remote blob sha');
  }
  try {
    const stdout = execFileSync(
      'gh',
      [
        'api',
        '--hostname',
        identity.host,
        '--method',
        'GET',
        '--header',
        'Accept: application/vnd.github.raw',
        `repos/${identity.owner}/${identity.name}/git/blobs/${blobSha}`,
      ],
      { encoding: 'buffer', stdio: 'pipe', timeout: 20000, maxBuffer: MAX_BUFFER },
    );
    const bytes = stdout as Buffer;
    if (bytes.length > MAX_REPOSITORY_OBSERVATION_BYTES) {
      throw new FrozenRepositoryError(
        'OVERSIZED_BLOB',
        `remote blob ${blobSha} exceeds the size bound`,
      );
    }
    return bytes;
  } catch (err) {
    throw classifyExecFailure('remote blob acquisition', err);
  }
}

function readRemoteCommitBlob(
  identity: RepositoryIdentity,
  commitSha: string,
  repositoryPath: string,
): Buffer {
  const entry = resolveRemoteTreeEntry(identity, commitSha, repositoryPath);
  return readRemoteBlob(identity, entry.objectSha);
}

/**
 * Acquire the exact raw bytes for `repositoryPath` inside a frozen revision
 * target. Never falls back to worktree or mutable refs.
 *
 * `tree` targets resolve from the local object database only — a synthetic
 * candidate tree exists locally by construction.
 * `commit` targets resolve locally first; remote identities fall back to the
 * immutable remote commit/blob backend. Local repository identities resolve
 * from the local object database only.
 */
export function acquireFrozenRepositoryContent(
  worktree: string,
  target: FrozenRepositoryRevisionTarget,
  repositoryPath: string,
): FrozenRepositoryContent {
  const localIdentity =
    'kind' in target.repositoryIdentity && target.repositoryIdentity.kind === 'local';
  if (target.kind === 'tree' || localIdentity) {
    const entry = resolveFrozenBlobEntry(worktree, target.objectSha, repositoryPath);
    const bytes = readFrozenBlob(worktree, entry.objectSha);
    return { kind: 'local_git_object', bytes, blobSha: entry.objectSha };
  }
  if (!frozenObjectExists(worktree, target.objectSha)) {
    // The frozen commit is absent from the local object database: remote
    // acquisition addresses exact repository + exact commit + exact path.
    if ('kind' in target.repositoryIdentity) {
      throw new FrozenRepositoryError(
        'OBJECT_UNAVAILABLE',
        `frozen object ${target.objectSha} is unavailable and local repository identities have no remote backend`,
      );
    }
    const bytes = readRemoteCommitBlob(target.repositoryIdentity, target.objectSha, repositoryPath);
    return { kind: 'remote_commit_blob', bytes };
  }
  const entry = resolveFrozenBlobEntry(worktree, target.objectSha, repositoryPath);
  const bytes = readFrozenBlob(worktree, entry.objectSha);
  return { kind: 'local_git_object', bytes, blobSha: entry.objectSha };
}
