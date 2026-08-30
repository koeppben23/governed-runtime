/**
 * @module integration/git-control-plane
 * @description Deterministic git control-plane integrity marker (#852).
 *
 * The implementation review subject covers worktree content (`changedFiles`,
 * content digests, diff artifacts). Git CONTROL-PLANE state — the common
 * `config`, `hooks/`, worktree-private `HEAD`, and the git-dir reference
 * itself — is invisible to `git status`, so a host mutation touching it would
 * change how the repository behaves WITHOUT ever appearing in the recorded
 * implementation evidence.
 *
 * The marker freezes the control-plane state at session baseline (hydrate).
 * Implementation recording fails closed when the current marker diverges from
 * the baseline: a mutation whose repository effect is not covered by the
 * implementation subject can never be certified as bound evidence.
 *
 * Layout resolution is delegated to git itself (`git rev-parse --git-dir
 * --git-common-dir --git-path HEAD --git-path config --git-path
 * config.worktree --git-path hooks`): linked worktrees relocate these paths
 * between the private $GIT_DIR and the common $GIT_COMMON_DIR, and
 * `extensions.worktreeConfig` adds a per-worktree `config.worktree` — the
 * layout is never guessed manually. A worktree that git cannot resolve makes
 * marker computation THROW (callers fail closed), never a guessed fallback.
 *
 * Marker shape (all parts hashed as one SHA-256):
 * - the resolved git-dir and common-dir paths;
 * - `config` content;
 * - `config.worktree` content (or a stable missing label);
 * - `HEAD` content;
 * - every `hooks/` entry (name + content hash).
 *
 * @version v2
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { resolveGitControlPlanePaths } from '../adapters/git.js';

function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Node/libuv reports reading a directory as EISDIR on every platform. */
function isEisDirError(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'EISDIR'
  );
}

async function markerForFile(filePath: string, missingLabel: string): Promise<string> {
  try {
    return sha256Text(await fs.readFile(filePath, 'utf8'));
  } catch {
    return missingLabel;
  }
}

async function hooksMarker(hooksDir: string): Promise<string> {
  let names: string[];
  try {
    names = (await fs.readdir(hooksDir)).sort();
  } catch {
    return 'missing';
  }
  const parts: string[] = [];
  for (const name of names) {
    const full = path.join(hooksDir, name);
    // Content AND permission bits are read through the SAME opened handle
    // (open → fstat/readFile): no stat-then-read race, and the executable
    // bits are git hook AUTHORITY — git ignores non-executable hooks, so a
    // chmod +x changes repository behavior without changing content.
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(full, 'r');
    } catch (err) {
      // Directory entries (POSIX opens directories; Windows fails with
      // EISDIR) and unreadable entries get a stable placeholder.
      parts.push(isEisDirError(err) ? `${name}:dir` : `${name}:missing`);
      continue;
    }
    try {
      const stat = await handle.stat();
      if (stat.isDirectory()) {
        parts.push(`${name}:dir`);
        continue;
      }
      const mode = (stat.mode & 0o777).toString(8);
      parts.push(`${name}:${mode}:${sha256Text(await handle.readFile('utf8'))}`);
    } catch {
      parts.push(`${name}:missing`);
    } finally {
      await handle.close();
    }
  }
  return parts.join(',');
}

/**
 * Compute the git control-plane integrity marker for a worktree.
 *
 * Deterministic for an unchanged control plane; changes when the git-dir
 * reference, the common config, the per-worktree config.worktree, HEAD, or
 * any hook changes. Throws when git cannot resolve the layout (not a
 * repository, git missing, corrupted layout) — callers fail closed.
 */
export async function computeGitControlPlaneMarker(worktree: string): Promise<string> {
  const layout = await resolveGitControlPlanePaths(worktree);
  const parts = [
    `gitdir:${layout.gitDir}`,
    `commondir:${layout.commonDir}`,
    `config:${await markerForFile(layout.configPath, 'missing')}`,
    `config.worktree:${await markerForFile(layout.worktreeConfigPath, 'missing')}`,
    `HEAD:${await markerForFile(layout.headPath, 'missing')}`,
    `hooks:${await hooksMarker(layout.hooksPath)}`,
  ];
  return sha256Text(parts.join('\n'));
}
