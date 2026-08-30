/**
 * @module integration/git-control-plane
 * @description Deterministic git control-plane integrity marker (#852).
 *
 * The implementation review subject covers worktree content (`changedFiles`,
 * content digests, diff artifacts). Git CONTROL-PLANE state — `.git/config`,
 * `.git/hooks/*`, `.git/HEAD`, the git-dir reference itself — is invisible to
 * `git status`, so a host mutation touching it would change how the repository
 * behaves WITHOUT ever appearing in the recorded implementation evidence.
 *
 * The marker freezes the control-plane state at session baseline (hydrate).
 * Implementation recording fails closed when the current marker diverges from
 * the baseline: a mutation whose repository effect is not covered by the
 * implementation subject can never be certified as bound evidence.
 *
 * Marker shape (all parts hashed as one SHA-256):
 * - the resolved git-dir reference (`.git` existence/type or the gitfile
 *   target for linked worktrees/submodules);
 * - `.git/config` content;
 * - `.git/HEAD` content;
 * - every `.git/hooks/` entry (name + content hash, directory names as-is).
 *
 * @version v1
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Resolve the actual git metadata directory for a worktree.
 *
 * A regular repository has a `.git` DIRECTORY; a linked worktree or submodule
 * has a `.git` FILE containing `gitdir: <path>`. Returns null when `.git` is
 * absent or unreadable — the marker then records the absence itself.
 */
async function resolveGitDir(worktree: string): Promise<string | null> {
  const dotGit = path.join(worktree, '.git');
  try {
    const stat = await fs.stat(dotGit);
    if (stat.isDirectory()) return dotGit;
    const content = await fs.readFile(dotGit, 'utf8');
    const match = /^gitdir:\s*(.+)$/m.exec(content);
    return match ? path.resolve(worktree, match[1]!.trim()) : null;
  } catch {
    return null;
  }
}

async function markerForFile(filePath: string | null, missingLabel: string): Promise<string> {
  if (!filePath) return missingLabel;
  try {
    return sha256Text(await fs.readFile(filePath, 'utf8'));
  } catch {
    return missingLabel;
  }
}

async function hooksMarker(gitDir: string | null): Promise<string> {
  if (!gitDir) return 'missing';
  let names: string[];
  try {
    names = (await fs.readdir(path.join(gitDir, 'hooks'))).sort();
  } catch {
    return 'missing';
  }
  const parts: string[] = [];
  for (const name of names) {
    const full = path.join(gitDir, 'hooks', name);
    try {
      const stat = await fs.stat(full);
      if (stat.isDirectory()) {
        parts.push(`${name}:dir`);
        continue;
      }
      parts.push(`${name}:${sha256Text(await fs.readFile(full, 'utf8'))}`);
    } catch {
      parts.push(`${name}:missing`);
    }
  }
  return parts.join(',');
}

/**
 * Compute the git control-plane integrity marker for a worktree.
 *
 * Deterministic for an unchanged control plane; changes when the git-dir
 * reference, config, HEAD, or any hook changes (or `.git` disappears).
 */
export async function computeGitControlPlaneMarker(worktree: string): Promise<string> {
  const gitDir = await resolveGitDir(worktree);
  const parts = [
    `gitdir:${gitDir ?? 'missing'}`,
    `config:${await markerForFile(gitDir ? path.join(gitDir, 'config') : null, 'missing')}`,
    `HEAD:${await markerForFile(gitDir ? path.join(gitDir, 'HEAD') : null, 'missing')}`,
    `hooks:${await hooksMarker(gitDir)}`,
  ];
  return sha256Text(parts.join('\n'));
}
