/**
 * @module adapters/git-identity
 * @description Git config actor identity helpers (`user.name`, `user.email`).
 *
 * @version v1
 */

import { git, logWarn } from './git-command.js';

/**
 * Read `git config user.name` for actor resolution.
 * Returns null on any failure (not a repo, no config, git not found).
 * Non-fatal — actor resolution falls through to 'unknown'.
 */
export async function gitUserName(cwd: string): Promise<string | null> {
  try {
    const name = await git(cwd, ['config', 'user.name']);
    return name || null;
  } catch {
    logWarn('git', 'Failed to read git user.name', { cwd });
    return null;
  }
}

/**
 * Read `git config user.email` for actor resolution.
 * Returns null on any failure (not a repo, no config, git not found).
 * Non-fatal — email is optional for ActorInfo.
 */
export async function gitUserEmail(cwd: string): Promise<string | null> {
  try {
    const email = await git(cwd, ['config', 'user.email']);
    return email || null;
  } catch {
    logWarn('git', 'Failed to read git user.email', { cwd });
    return null;
  }
}
