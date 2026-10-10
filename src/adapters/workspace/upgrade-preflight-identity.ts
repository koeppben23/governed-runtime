/**
 * @module workspace/upgrade-preflight-identity
 * @description Read-only workspace-store attribution for the upgrade preflight.
 *
 * Clones that share a remote fingerprint share one workspace store while
 * `workspace.json` records only the first initializer's path. Attribution
 * therefore uses the persisted session bindings: unreadable evidence fails
 * closed, stores that provably belong to other worktrees do not block, and the
 * caller classifies the attributed sessions with the existing preflight
 * classification (no second authority here).
 *
 * @version v2
 */

import { existsSync, readdirSync, type Dirent } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { normalizeBindingPath } from '../binding.js';
import { readWorkspaceInfo, sessionDir, workspaceDir, workspacesHome } from './init.js';
import { FINGERPRINT_RE, WorkspaceError, validateSessionId } from './types.js';

/** Sessions of a prior workspace store that belong to the current worktree. */
export interface WorkspaceEvidence {
  readonly fingerprint: string;
  readonly sessionIds: readonly string[];
}

export type WorktreeWorkspaceScan =
  | { readonly status: 'ok'; readonly evidence: readonly WorkspaceEvidence[] }
  | { readonly status: 'unreadable'; readonly detail: string };

/** Minimal identity input: current fingerprint plus the resolved worktree. */
export interface WorkspaceIdentityInput {
  readonly fingerprint: string;
  readonly worktreeRoot: string;
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/** Session directory names must satisfy the canonical session-id contract. */
function isValidSessionDirectoryName(name: string): boolean {
  try {
    validateSessionId(name);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the persisted worktree binding for identification only. Attribution
 * must not depend on the current state schema: foreign workspaces may predate
 * the current hard cut and are rejected by `readState`, yet their binding
 * still identifies which clone the workspace belongs to.
 */
async function readSessionBinding(sessDir: string): Promise<string | null | 'unreadable'> {
  try {
    const raw = await readFile(join(sessDir, 'session-state.json'), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    const worktree = (parsed as { binding?: { worktree?: unknown } } | null)?.binding?.worktree;
    return typeof worktree === 'string' ? worktree : 'unreadable';
  } catch (error) {
    if (isEnoent(error)) return null;
    return 'unreadable';
  }
}

type WorkspaceAttribution =
  | { readonly status: 'ok'; readonly sessionIds: readonly string[] }
  | { readonly status: 'unreadable'; readonly detail: string };

/**
 * Validate persisted metadata before any path handling. Metadata is not an
 * attribution signal anymore, but a malformed record still fails the scan
 * closed instead of being skipped.
 */
async function validateWorkspaceMetadata(
  fingerprint: string,
): Promise<{ readonly status: 'ok' } | { readonly status: 'unreadable'; readonly detail: string }> {
  let metadata: Awaited<ReturnType<typeof readWorkspaceInfo>>;
  try {
    metadata = await readWorkspaceInfo(fingerprint);
  } catch (error) {
    if (error instanceof WorkspaceError && error.code === 'INVALID_FINGERPRINT') {
      return { status: 'ok' };
    }
    return { status: 'unreadable', detail: `workspace metadata ${fingerprint}: ${String(error)}` };
  }
  if (metadata === null) return { status: 'ok' };
  if (typeof metadata.worktreePath !== 'string' || metadata.worktreePath.length === 0) {
    return {
      status: 'unreadable',
      detail: `workspace metadata ${fingerprint}: missing worktreePath`,
    };
  }
  return { status: 'ok' };
}

/**
 * Collect the sessions of a prior workspace store that belong to this
 * worktree. Terminality and blocker classification are deliberately NOT
 * decided here: the caller classifies these sessions with the existing
 * preflight classification, so an identity change can never hide a state or
 * audit blocker. A session whose binding cannot be read fails the scan closed.
 */
async function attributedSessionsForWorktree(
  fingerprint: string,
  currentWorktree: string,
): Promise<WorkspaceAttribution> {
  const sessionsRoot = join(workspaceDir(fingerprint), 'sessions');
  if (!existsSync(sessionsRoot)) return { status: 'ok', sessionIds: [] };

  let sessionEntries: Dirent[];
  try {
    sessionEntries = readdirSync(sessionsRoot, { withFileTypes: true, encoding: 'utf8' });
  } catch (error) {
    return { status: 'unreadable', detail: `sessions of ${fingerprint}: ${String(error)}` };
  }
  const sessionIds: string[] = [];
  for (const session of sessionEntries) {
    // `sessions/archive/` is the canonical archive slot, not a session.
    if (!session.isDirectory() || session.name === 'archive') continue;
    if (!isValidSessionDirectoryName(session.name)) {
      return {
        status: 'unreadable',
        detail: `session directory name ${fingerprint}/${session.name} is not a valid session id`,
      };
    }
    const binding = await readSessionBinding(sessionDir(fingerprint, session.name));
    if (binding === null || binding === 'unreadable') {
      return {
        status: 'unreadable',
        detail:
          `session binding ${fingerprint}/${session.name}: ` +
          (binding === null ? 'state file missing' : 'unreadable'),
      };
    }
    if (normalizeBindingPath(binding) === currentWorktree) {
      sessionIds.push(session.name);
    }
  }
  return { status: 'ok', sessionIds };
}

/** Validate metadata, then attribute the store through its session evidence. */
async function attributeWorkspaceToWorktree(
  fingerprint: string,
  currentWorktree: string,
): Promise<WorkspaceAttribution> {
  const metadata = await validateWorkspaceMetadata(fingerprint);
  if (metadata.status === 'unreadable') return metadata;
  return attributedSessionsForWorktree(fingerprint, currentWorktree);
}

/**
 * Read-only scan of the workspace store for sessions of this exact worktree.
 * Untrusted or missing metadata is never silently ignored: session bindings
 * are inspected, and a session that cannot be attributed fails the scan closed
 * instead of being treated as "not this worktree".
 */
export async function scanWorktreeWorkspaces(
  identity: WorkspaceIdentityInput,
): Promise<WorktreeWorkspaceScan> {
  const home = workspacesHome();
  let entries: Dirent[];
  try {
    if (!existsSync(home)) return { status: 'ok', evidence: [] };
    entries = readdirSync(home, { withFileTypes: true, encoding: 'utf8' });
  } catch (error) {
    return { status: 'unreadable', detail: `workspace store: ${String(error)}` };
  }

  const currentWorktree = normalizeBindingPath(identity.worktreeRoot);
  const evidence: WorkspaceEvidence[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === identity.fingerprint) continue;
    // Non-fingerprint directories are not workspace records (backups, stray
    // tooling output); they must not reach the fingerprint-validating helpers.
    if (!FINGERPRINT_RE.test(entry.name)) continue;
    const attribution = await attributeWorkspaceToWorktree(entry.name, currentWorktree);
    if (attribution.status === 'unreadable') return attribution;
    if (attribution.sessionIds.length > 0) {
      evidence.push({ fingerprint: entry.name, sessionIds: attribution.sessionIds });
    }
  }
  return { status: 'ok', evidence };
}
