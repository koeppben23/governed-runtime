/**
 * @module workspace/upgrade-preflight-identity
 * @description Read-only workspace-store attribution for the upgrade preflight.
 *
 * Clones that share a remote fingerprint share one workspace store while
 * `workspace.json` records only the first initializer's path. Attribution
 * therefore combines trusted workspace metadata with the persisted session
 * bindings: unreadable evidence fails closed, and stores that provably belong
 * to other worktrees do not block the preflight.
 *
 * @version v1
 */

import { existsSync, readdirSync, type Dirent } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { normalizeBindingPath } from '../binding.js';
import { readWorkspaceInfo, sessionDir, workspaceDir, workspacesHome } from './init.js';
import { WorkspaceError } from './types.js';

export type WorktreeWorkspaceScan =
  | { readonly status: 'ok'; readonly fingerprints: readonly string[] }
  | { readonly status: 'unreadable'; readonly detail: string };

/** Minimal identity input: current fingerprint plus the resolved worktree. */
export interface WorkspaceIdentityInput {
  readonly fingerprint: string;
  readonly worktreeRoot: string;
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/**
 * Read the persisted worktree binding for identification only. Attribution
 * must not depend on the current state schema: foreign workspaces may predate
 * the current hard cut and are rejected by `readState`, yet their binding
 * still identifies which clone the workspace belongs to.
 */
async function readBindingWorktree(sessDir: string): Promise<string | null | 'unreadable'> {
  try {
    const raw = await readFile(join(sessDir, 'session-state.json'), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    const binding = (parsed as { binding?: { worktree?: unknown } } | null)?.binding;
    return typeof binding?.worktree === 'string' ? binding.worktree : 'unreadable';
  } catch (error) {
    if (isEnoent(error)) return null;
    return 'unreadable';
  }
}

type WorkspaceAttribution =
  | { readonly status: 'ok'; readonly ownsWorktree: boolean }
  | { readonly status: 'unreadable'; readonly detail: string };

/** Trusted metadata is the fast path: it owns the worktree only if consistent. */
async function trustedMetadataOwnsWorktree(
  fingerprint: string,
  currentWorktree: string,
): Promise<WorkspaceAttribution> {
  let metadata: Awaited<ReturnType<typeof readWorkspaceInfo>>;
  try {
    metadata = await readWorkspaceInfo(fingerprint);
  } catch (error) {
    if (error instanceof WorkspaceError && error.code === 'INVALID_FINGERPRINT') {
      return { status: 'ok', ownsWorktree: false };
    }
    return { status: 'unreadable', detail: `workspace metadata ${fingerprint}: ${String(error)}` };
  }
  if (metadata === null) {
    return { status: 'ok', ownsWorktree: false };
  }
  if (typeof metadata.worktreePath !== 'string' || metadata.worktreePath.length === 0) {
    return {
      status: 'unreadable',
      detail: `workspace metadata ${fingerprint}: missing worktreePath`,
    };
  }
  if (metadata.fingerprint !== fingerprint) {
    return { status: 'ok', ownsWorktree: false };
  }
  return {
    status: 'ok',
    ownsWorktree: normalizeBindingPath(metadata.worktreePath) === currentWorktree,
  };
}

/** Session bindings are the second signal, independent of workspace metadata. */
async function sessionBindingsOwnWorktree(
  fingerprint: string,
  currentWorktree: string,
): Promise<WorkspaceAttribution> {
  const sessionsRoot = join(workspaceDir(fingerprint), 'sessions');
  if (!existsSync(sessionsRoot)) return { status: 'ok', ownsWorktree: false };

  let sessionEntries: Dirent[];
  try {
    sessionEntries = readdirSync(sessionsRoot, { withFileTypes: true, encoding: 'utf8' });
  } catch (error) {
    return { status: 'unreadable', detail: `sessions of ${fingerprint}: ${String(error)}` };
  }
  for (const session of sessionEntries) {
    // `sessions/archive/` is the canonical archive slot, not a session.
    if (!session.isDirectory() || session.name === 'archive') continue;
    const bindingWorktree = await readBindingWorktree(sessionDir(fingerprint, session.name));
    if (bindingWorktree === null || bindingWorktree === 'unreadable') {
      return {
        status: 'unreadable',
        detail:
          `session binding ${fingerprint}/${session.name}: ` +
          (bindingWorktree === null ? 'state file missing' : 'unreadable'),
      };
    }
    if (normalizeBindingPath(bindingWorktree) === currentWorktree) {
      return { status: 'ok', ownsWorktree: true };
    }
  }
  return { status: 'ok', ownsWorktree: false };
}

/**
 * Attribute an existing workspace store to a worktree. Trusted metadata is the
 * fast path; session bindings are the independent second signal, because
 * clones that share a remote fingerprint share one store while `workspace.json`
 * records only the first initializer's path.
 */
async function attributeWorkspaceToWorktree(
  fingerprint: string,
  currentWorktree: string,
): Promise<WorkspaceAttribution> {
  const metadata = await trustedMetadataOwnsWorktree(fingerprint, currentWorktree);
  if (metadata.status === 'unreadable' || metadata.ownsWorktree) return metadata;
  return sessionBindingsOwnWorktree(fingerprint, currentWorktree);
}

/**
 * Read-only scan of the workspace store for records of this exact worktree.
 * Untrusted or missing metadata is never silently ignored: session bindings
 * are inspected, and a session whose binding cannot be read fails the scan
 * closed instead of being treated as "not this worktree".
 */
export async function scanWorktreeWorkspaces(
  identity: WorkspaceIdentityInput,
): Promise<WorktreeWorkspaceScan> {
  const home = workspacesHome();
  let entries: Dirent[];
  try {
    if (!existsSync(home)) return { status: 'ok', fingerprints: [] };
    entries = readdirSync(home, { withFileTypes: true, encoding: 'utf8' });
  } catch (error) {
    return { status: 'unreadable', detail: `workspace store: ${String(error)}` };
  }

  const currentWorktree = normalizeBindingPath(identity.worktreeRoot);
  const fingerprints: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === identity.fingerprint) continue;
    const attribution = await attributeWorkspaceToWorktree(entry.name, currentWorktree);
    if (attribution.status === 'unreadable') return attribution;
    if (attribution.ownsWorktree) fingerprints.push(entry.name);
  }
  return { status: 'ok', fingerprints };
}
