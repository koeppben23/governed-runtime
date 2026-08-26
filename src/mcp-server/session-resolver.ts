/**
 * @module mcp-server/session-resolver
 * @description Binds each MCP transport to roots supplied by the MCP client.
 */

import { realpath, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { computeFingerprint } from '../adapters/workspace/fingerprint.js';
import { sessionDir } from '../adapters/workspace/init.js';
import { canonicalJsonStringify } from '../shared/canonical-json.js';
import { hashTextShort } from '../shared/hashing.js';

const execFileAsync = promisify(execFile);
const ENV_SESSION_DIR = 'FLOWGUARD_SESSION_DIR';
const ENV_PROJECT_DIR = 'FLOWGUARD_PROJECT_DIR';
export const SESSION_UNRESOLVABLE_CODE = 'SESSION_UNRESOLVABLE';

export class McpSessionResolutionError extends Error {
  readonly code = SESSION_UNRESOLVABLE_CODE;

  constructor(reason: string) {
    super(`[${SESSION_UNRESOLVABLE_CODE}] ${reason}`);
    this.name = 'McpSessionResolutionError';
  }
}

export interface McpRoot {
  readonly uri: string;
}

export interface McpSessionContext {
  readonly sessionId: string;
  readonly directory: string;
  readonly worktree: string;
}

interface BoundSession {
  readonly canonicalRootSetDigest: string;
  readonly canonicalWorktree: string;
  readonly workspaceFingerprint: string;
}

interface ResolvedRoots {
  readonly digest: string;
  readonly worktrees: readonly string[];
  readonly roots: readonly string[];
}

/**
 * Per-transport authority binder. Roots remain authoritative on every call;
 * environment values can only disambiguate a root-backed worktree or identify
 * a session below an already bound workspace.
 */
export class McpSessionBinder {
  private bound: BoundSession | undefined;

  constructor(private readonly sessionId = `mcp-${randomUUID()}`) {}

  async resolve(roots: readonly McpRoot[]): Promise<McpSessionContext> {
    const resolved = await resolveRoots(roots);
    const worktree = await selectWorktree(resolved.worktrees);
    const fingerprint = (await computeFingerprint(worktree)).fingerprint;

    await validateSessionHint(fingerprint);
    if (!this.bound) {
      this.bound = {
        canonicalRootSetDigest: resolved.digest,
        canonicalWorktree: worktree,
        workspaceFingerprint: fingerprint,
      };
    } else if (
      this.bound.canonicalRootSetDigest !== resolved.digest ||
      this.bound.canonicalWorktree !== worktree ||
      this.bound.workspaceFingerprint !== fingerprint
    ) {
      throw new McpSessionResolutionError('MCP roots or bound workspace changed during transport');
    }

    return { sessionId: this.sessionId, directory: worktree, worktree };
  }
}

async function resolveRoots(roots: readonly McpRoot[]): Promise<ResolvedRoots> {
  if (roots.length === 0) throw new McpSessionResolutionError('MCP client advertised no roots');

  const canonicalRoots = new Set<string>();
  const worktrees = new Set<string>();
  for (const root of roots) {
    const rootPath = fileRootPath(root.uri);
    const canonicalRoot = await canonicalDirectory(rootPath, 'MCP root');
    canonicalRoots.add(canonicalRoot);
    worktrees.add(await gitWorktree(canonicalRoot));
  }

  const sortedRoots = [...canonicalRoots].sort();
  return {
    roots: sortedRoots,
    worktrees: [...worktrees].sort(),
    digest: hashTextShort(canonicalJsonStringify(sortedRoots), 64),
  };
}

function fileRootPath(uri: string): string {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new McpSessionResolutionError(`MCP root is not a valid URI: ${uri}`);
  }
  if (parsed.protocol !== 'file:') {
    throw new McpSessionResolutionError(`MCP root must use file: URI scheme: ${uri}`);
  }
  try {
    return fileURLToPath(parsed);
  } catch {
    throw new McpSessionResolutionError(`MCP root cannot be converted to a local path: ${uri}`);
  }
}

async function canonicalDirectory(candidate: string, label: string): Promise<string> {
  try {
    const canonical = await realpath(candidate);
    if (!(await stat(canonical)).isDirectory()) {
      throw new McpSessionResolutionError(`${label} is not a directory: ${candidate}`);
    }
    return canonical;
  } catch (err) {
    if (err instanceof McpSessionResolutionError) throw err;
    throw new McpSessionResolutionError(
      `${label} does not exist or cannot be resolved: ${candidate}`,
    );
  }
}

async function gitWorktree(directory: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd: directory,
    });
    return canonicalDirectory(stdout.trim(), 'Git worktree');
  } catch {
    throw new McpSessionResolutionError(
      `MCP root is not inside a resolvable Git worktree: ${directory}`,
    );
  }
}

async function selectWorktree(worktrees: readonly string[]): Promise<string> {
  if (worktrees.length === 1) return worktrees[0]!;

  const hint = process.env[ENV_PROJECT_DIR];
  if (!hint) {
    throw new McpSessionResolutionError(
      'MCP roots authorize multiple worktrees without a project hint',
    );
  }
  const hintedPath = await canonicalDirectory(hint, ENV_PROJECT_DIR);
  const hintedWorktree = await gitWorktree(hintedPath);
  if (!worktrees.includes(hintedWorktree)) {
    throw new McpSessionResolutionError(
      `${ENV_PROJECT_DIR} does not select an MCP-authorized worktree`,
    );
  }
  return hintedWorktree;
}

async function validateSessionHint(fingerprint: string): Promise<void> {
  const hint = process.env[ENV_SESSION_DIR];
  if (!hint) return;
  const canonicalHint = await canonicalDirectory(hint, ENV_SESSION_DIR);
  const canonicalSessionsDir = await canonicalDirectory(
    path.join(sessionDir(fingerprint, 'mcp-placeholder'), '..'),
    'Bound workspace session directory',
  );
  if (!isContainedBy(canonicalSessionsDir, canonicalHint)) {
    throw new McpSessionResolutionError(
      `${ENV_SESSION_DIR} is outside the bound workspace session directory`,
    );
  }
}

function isContainedBy(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}
